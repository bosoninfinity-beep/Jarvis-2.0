/**
 * WhatsApp Communication Layer — WhatsAppBridge
 *
 * Full-featured WhatsApp bridge: QR login, agent routing, enhanced commands,
 * proactive notifications, media support, message splitting, JID authorization.
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createLogger, shortId, NatsSubjects, type ChatMessage } from '@jarvis/shared';
import type { NasPaths } from '../nas/paths.js';
import type { NatsClient } from '../nats/client.js';
import type { ProtocolHandler } from '../protocol/handler.js';
import type { StateStore } from '../redis/state-store.js';

const log = createLogger('gateway:whatsapp');

// --- Command security ---

const CMD_BLACKLIST = [
  /rm\s+-rf/i,
  /shutdown/i,
  /reboot/i,
  /mkfs/i,
  /dd\s+if=/i,
  /kill\s+-9/i,
  /launchctl\s+unload/i,
  /diskutil\s+erase/i,
  /srm\s/i,
  />\s*\/dev\//i,
  /chmod\s+-R\s+000/i,
];

const CMD_TIMEOUT_MS = 30_000;
const CMD_MAX_OUTPUT = 4000;

// --- Message splitting ---

function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      // Try space
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // Hard split
      splitIdx = maxLen;
    }

    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }

  // Add headers
  if (chunks.length > 1) {
    return chunks.map((c, i) => `(${i + 1}/${chunks.length})\n${c}`);
  }
  return chunks;
}

// --- Dependencies interface ---

export interface WhatsAppDeps {
  nats: NatsClient;
  protocol: ProtocolHandler;
  nas: NasPaths;
  store: StateStore;
  getChannelConfig: (channel: string) => Record<string, unknown>;
  setChannelConfig: (channel: string, updates: Record<string, unknown>) => { success: boolean; config: Record<string, unknown> };
  appendChannelMessage: (channel: string, message: Record<string, unknown>) => void;
  persistChatMessage: (sessionId: string, msg: ChatMessage) => void;
  getHealthStatus: () => Promise<{
    status: string;
    uptime: number;
    agents: Array<{ id: string; status: string; role: string; alive: boolean }>;
    infrastructure: { nats: boolean; redis: boolean };
  }>;
  assignTask: (task: any) => Promise<void>;
  formatDuration: (ms: number) => string;
}

export class WhatsAppBridge {
  // Baileys socket and login state
  private waSocket: ReturnType<typeof import('@whiskeysockets/baileys').makeWASocket> | null = null;
  private waConnected = false;
  private waQrDataUrl: string | null = null;
  private waLoginResolvers: Array<(value: { connected: boolean; message: string }) => void> = [];
  private waSelfJid: string | null = null;

  /** Maps WhatsApp session IDs to JIDs for routing agent responses back via WhatsApp */
  private waActiveChats = new Map<string, string>();

  /** Maps sessionId → active agentId for agent routing */
  private sessionAgent = new Map<string, string>();

  /** Track message IDs sent by the bot to prevent echo loops */
  private recentlySentIds = new Set<string>();

  constructor(private readonly deps: WhatsAppDeps) {}

  // --- Public API (for server.ts RPC registration) ---

  get connected(): boolean {
    return this.waConnected;
  }

  getAuthDir(): string {
    const dir = this.deps.nas.resolve('whatsapp-auth');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  getStatus(): {
    connected: boolean;
    loggedIn: boolean;
    selfJid: string | null;
    qrPending: boolean;
    message: string;
  } {
    const authDir = this.getAuthDir();
    const credsPath = join(authDir, 'creds.json');
    const loggedIn = existsSync(credsPath);

    return {
      connected: this.waConnected,
      loggedIn,
      selfJid: this.waSelfJid,
      qrPending: !!this.waQrDataUrl,
      message: this.waConnected
        ? `Connected as ${this.waSelfJid || 'unknown'}`
        : loggedIn
          ? 'Logged in but not connected. Click Connect to start.'
          : 'Not logged in. Click "Show QR" to scan with WhatsApp.',
    };
  }

  async startLogin(force = false): Promise<{ qrDataUrl: string | null; message: string }> {
    log.info('WhatsApp login: starting QR flow...');

    // Stop existing socket
    if (this.waSocket) {
      try { this.waSocket.end(undefined); } catch { /* */ }
      this.waSocket = null;
      this.waConnected = false;
    }

    // If force, clear auth
    if (force) {
      const authDir = this.getAuthDir();
      const credsPath = join(authDir, 'creds.json');
      try { if (existsSync(credsPath)) unlinkSync(credsPath); } catch { /* */ }
      log.info('WhatsApp: cleared existing auth (force relink)');
    }

    // Dynamic import for Baileys (ESM module)
    let baileys: typeof import('@whiskeysockets/baileys');
    try {
      baileys = await import('@whiskeysockets/baileys');
    } catch (err) {
      log.error('Failed to import Baileys:', { error: String(err) });
      return { qrDataUrl: null, message: 'Baileys library not installed. Run: pnpm add @whiskeysockets/baileys' };
    }

    let qrcode: typeof import('qrcode');
    try {
      qrcode = await import('qrcode');
    } catch {
      return { qrDataUrl: null, message: 'qrcode library not installed. Run: pnpm add qrcode' };
    }

    const authDir = this.getAuthDir();
    const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);
    const { version } = await baileys.fetchLatestBaileysVersion();

    return new Promise((resolveLogin) => {
      let qrReceived = false;
      const timeout = setTimeout(() => {
        if (!qrReceived) {
          resolveLogin({ qrDataUrl: null, message: 'QR code timeout (30s). Try again.' });
        }
      }, 30000);

      const sock = baileys!.makeWASocket({
        auth: {
          creds: state.creds,
          keys: baileys!.makeCacheableSignalKeyStore(state.keys, undefined as any),
        },
        version,
        printQRInTerminal: false,
        browser: ['Jarvis 2.0', 'Desktop', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      this.waSocket = sock as any;

      // Save creds on update
      sock.ev.on('creds.update', saveCreds);

      // Connection events
      sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !qrReceived) {
          qrReceived = true;
          clearTimeout(timeout);
          try {
            const dataUrl = await qrcode!.toDataURL(qr, {
              width: 300,
              margin: 2,
              color: { dark: '#000000', light: '#ffffff' },
            });
            this.waQrDataUrl = dataUrl;
            log.info('WhatsApp: QR code generated, waiting for scan...');
            resolveLogin({
              qrDataUrl: dataUrl,
              message: 'Scan this QR code in WhatsApp → Linked Devices → Link a Device',
            });
          } catch (err) {
            log.error('QR generation failed:', { error: String(err) });
            resolveLogin({ qrDataUrl: null, message: `QR generation failed: ${(err as Error).message}` });
          }
        }

        if (connection === 'open') {
          this.waConnected = true;
          this.waQrDataUrl = null;
          this.waSelfJid = sock.user?.id ?? null;
          log.info(`WhatsApp connected as ${this.waSelfJid}`);
          this.deps.protocol.broadcast('whatsapp.connected', {
            selfJid: this.waSelfJid,
            timestamp: Date.now(),
          });

          // Resolve all pending login waiters
          for (const resolve of this.waLoginResolvers) {
            resolve({ connected: true, message: `Connected as ${this.waSelfJid}` });
          }
          this.waLoginResolvers = [];
        }

        if (connection === 'close') {
          this.waConnected = false;
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const reason = baileys!.DisconnectReason;

          log.warn(`WhatsApp disconnected (code: ${statusCode})`);
          this.deps.protocol.broadcast('whatsapp.disconnected', { statusCode, timestamp: Date.now() });

          if (statusCode === reason.loggedOut) {
            log.info('WhatsApp: Logged out, clearing credentials');
            this.waSocket = null;
            this.waSelfJid = null;
          } else if (statusCode === 515 || statusCode === reason.restartRequired) {
            log.info('WhatsApp: Restart required, reconnecting...');
            setTimeout(() => this.connect(), 2000);
          } else {
            log.info('WhatsApp: Will reconnect in 5s...');
            setTimeout(() => this.connect(), 5000);
          }

          // Resolve all pending login waiters with disconnect
          for (const resolve of this.waLoginResolvers) {
            resolve({ connected: false, message: `Disconnected (code: ${statusCode})` });
          }
          this.waLoginResolvers = [];
        }
      });

      // Message handler
      sock.ev.on('messages.upsert', async (upsert: any) => {
        if (upsert.type !== 'notify' && upsert.type !== 'append') return;

        for (const msg of upsert.messages) {
          if (!msg.message) continue;

          // Skip messages sent by this bot (echo loop prevention)
          const msgId = msg.key.id ?? '';
          if (msgId && this.recentlySentIds.has(msgId)) {
            this.recentlySentIds.delete(msgId);
            continue;
          }

          const from = msg.key.remoteJid ?? '';
          if (from === 'status@broadcast' || from.endsWith('@broadcast')) continue;

          // --- Authorization gate ---
          const config = this.deps.getChannelConfig('whatsapp');
          const authorizedJids = config.authorizedJids as string[] | undefined;
          if (authorizedJids && authorizedJids.length > 0) {
            // Owner-only mode: only process self-chat messages (fromMe + writing to own number)
            const selfNumber = this.waSelfJid?.split(':')[0]?.split('@')[0] ?? '';
            const remoteNumber = from.split('@')[0];
            const isSelfChat = msg.key.fromMe && selfNumber && remoteNumber === selfNumber;
            if (!isSelfChat) {
              log.debug(`WhatsApp: ignoring message (not self-chat) from=${from} fromMe=${msg.key.fromMe}`);
              continue;
            }
          }

          // --- Auto-save notificationJid on first message ---
          if (!config.notificationJid) {
            this.deps.setChannelConfig('whatsapp', { notificationJid: from });
            log.info(`WhatsApp: auto-saved notificationJid = ${from}`);
          }

          // --- Extract text ---
          const text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || '';

          // --- Media handling ---
          const imageMessage = msg.message.imageMessage;
          const documentMessage = msg.message.documentMessage;

          if (imageMessage || documentMessage) {
            await this.handleIncomingMedia(msg, from);
          }

          if (!text && !imageMessage && !documentMessage) continue;

          const pushName = msg.pushName ?? from.split('@')[0];

          const incomingMsg = {
            id: msg.key.id ?? `wa-${Date.now()}`,
            from,
            fromName: pushName,
            to: 'jarvis',
            body: text || (imageMessage ? `[Image: ${imageMessage.caption || 'no caption'}]` : `[Document: ${documentMessage?.fileName || 'file'}]`),
            timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
            direction: 'incoming' as const,
            status: 'read' as const,
            type: (imageMessage ? 'image' : documentMessage ? 'document' : 'text') as string,
          };

          this.deps.appendChannelMessage('whatsapp', incomingMsg);
          this.deps.protocol.broadcast('whatsapp.message', incomingMsg);
          log.info(`WhatsApp from ${pushName}: "${(text || incomingMsg.body).substring(0, 80)}"`);

          // Route to agent if jarvisMode
          if (config.jarvisMode && text) {
            const lang = (config.autoReplyLanguage as string) ?? 'pl';

            if (text.startsWith('/')) {
              const sessionId = `whatsapp-${from.split('@')[0]}`;
              const reply = await this.handleCommand(text, lang, sessionId, from);
              await this.sendMessage({ to: from, message: reply });
            } else {
              // Route to active agent (or default)
              const sessionId = `whatsapp-${from.split('@')[0]}`;
              const activeAgent = this.sessionAgent.get(sessionId) ?? (config.defaultAgent as string) ?? 'jarvis';

              if (this.waActiveChats.size >= 10_000 && !this.waActiveChats.has(sessionId)) {
                const oldestKey = this.waActiveChats.keys().next().value;
                if (oldestKey !== undefined) this.waActiveChats.delete(oldestKey);
              }
              this.waActiveChats.set(sessionId, from);

              const chatMsg: ChatMessage = {
                id: shortId(),
                from: 'user',
                to: activeAgent as ChatMessage['to'],
                content: `[WhatsApp from ${pushName}]: ${text}`,
                timestamp: Date.now(),
                metadata: { source: 'whatsapp', whatsappJid: from, sessionId, language: lang },
              };

              this.deps.persistChatMessage(sessionId, chatMsg);
              await this.deps.nats.publish(NatsSubjects.chat(activeAgent), { ...chatMsg, sessionId });
              this.deps.protocol.broadcast('chat.message', chatMsg);
              log.info(`WhatsApp → ${activeAgent}: "${text.substring(0, 80)}" (session: ${sessionId})`);
            }
          }
        }
      });

      // If we already have creds, this socket will connect without QR
      const credsPath = join(authDir, 'creds.json');
      if (existsSync(credsPath)) {
        setTimeout(() => {
          if (!qrReceived && this.waConnected) {
            clearTimeout(timeout);
            resolveLogin({
              qrDataUrl: null,
              message: `Already connected as ${this.waSelfJid}`,
            });
          }
        }, 5000);
      }
    });
  }

  async connect(): Promise<void> {
    const authDir = this.getAuthDir();
    const credsPath = join(authDir, 'creds.json');
    if (!existsSync(credsPath)) {
      log.info('WhatsApp: No credentials found, skipping auto-connect');
      return;
    }

    if (this.waConnected) return;

    log.info('WhatsApp: Auto-connecting with saved credentials...');
    await this.startLogin(false);
  }

  async waitLogin(): Promise<{ connected: boolean; message: string }> {
    if (this.waConnected) {
      return { connected: true, message: `Already connected as ${this.waSelfJid}` };
    }

    return new Promise((resolve) => {
      this.waLoginResolvers.push(resolve);
      setTimeout(() => {
        const idx = this.waLoginResolvers.indexOf(resolve);
        if (idx !== -1) {
          this.waLoginResolvers.splice(idx, 1);
          resolve({ connected: false, message: 'Scan timeout (120s). Try again.' });
        }
      }, 120000);
    });
  }

  async logout(): Promise<{ success: boolean; message: string }> {
    try {
      if (this.waSocket) {
        try { await (this.waSocket as any).logout(); } catch { /* */ }
        try { this.waSocket.end(undefined); } catch { /* */ }
        this.waSocket = null;
      }
      this.waConnected = false;
      this.waSelfJid = null;
      this.waQrDataUrl = null;

      const authDir = this.getAuthDir();
      try {
        const files = readdirSync(authDir);
        for (const file of files) {
          try { unlinkSync(join(authDir, file)); } catch { /* */ }
        }
      } catch { /* */ }

      log.info('WhatsApp: Logged out and cleared credentials');
      this.deps.protocol.broadcast('whatsapp.disconnected', { reason: 'logout', timestamp: Date.now() });
      return { success: true, message: 'Logged out successfully. Scan QR to reconnect.' };
    } catch (err) {
      return { success: false, message: `Logout failed: ${(err as Error).message}` };
    }
  }

  async sendMessage(params: { to: string; message: string }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.waSocket || !this.waConnected) {
      return { success: false, error: 'WhatsApp not connected. Login via QR code first.' };
    }

    let jid = params.to;
    if (!jid.includes('@')) {
      const cleaned = jid.replace(/[\s\-+()]/g, '');
      jid = `${cleaned}@s.whatsapp.net`;
    }

    const config = this.deps.getChannelConfig('whatsapp');
    const maxLen = (config.maxMessageLength as number) ?? 4000;
    const chunks = splitMessage(params.message, maxLen);

    try {
      let lastMsgId = '';
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 500));
        const result = await (this.waSocket as any).sendMessage(jid, { text: chunks[i] });
        lastMsgId = result?.key?.id ?? `wa-${Date.now()}`;
        // Track sent ID to prevent echo loop
        if (lastMsgId) {
          this.recentlySentIds.add(lastMsgId);
          // Auto-cleanup after 30s
          setTimeout(() => this.recentlySentIds.delete(lastMsgId), 30_000);
        }
      }

      // Save to history (full message, not chunks)
      this.deps.appendChannelMessage('whatsapp', {
        id: lastMsgId,
        from: 'jarvis',
        to: jid,
        body: params.message,
        timestamp: Date.now(),
        direction: 'outgoing',
        status: 'sent',
        type: 'text',
      });

      this.deps.protocol.broadcast('whatsapp.sent', { to: jid, message: params.message, timestamp: Date.now() });
      return { success: true, messageId: lastMsgId };
    } catch (err) {
      log.error(`WhatsApp send error: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message };
    }
  }

  async sendImage(params: { to: string; image: Buffer; caption?: string }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.waSocket || !this.waConnected) {
      return { success: false, error: 'WhatsApp not connected.' };
    }

    let jid = params.to;
    if (!jid.includes('@')) {
      const cleaned = jid.replace(/[\s\-+()]/g, '');
      jid = `${cleaned}@s.whatsapp.net`;
    }

    try {
      const result = await (this.waSocket as any).sendMessage(jid, {
        image: params.image,
        caption: params.caption ?? '',
      });
      const msgId = result?.key?.id ?? `wa-${Date.now()}`;
      if (msgId) {
        this.recentlySentIds.add(msgId);
        setTimeout(() => this.recentlySentIds.delete(msgId), 30_000);
      }

      this.deps.appendChannelMessage('whatsapp', {
        id: msgId,
        from: 'jarvis',
        to: jid,
        body: params.caption ?? '[Image]',
        timestamp: Date.now(),
        direction: 'outgoing',
        status: 'sent',
        type: 'image',
      });

      return { success: true, messageId: msgId };
    } catch (err) {
      log.error(`WhatsApp send image error: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message };
    }
  }

  /** Handle legacy webhook — no-op with Baileys */
  async handleWebhook(_body: Record<string, unknown>): Promise<void> {
    log.debug('WhatsApp webhook called (legacy — Baileys handles messages via socket)');
  }

  // --- Chat broadcast handler (called from server.ts NATS subscription) ---

  async handleChatBroadcast(msg: ChatMessage & { sessionId?: string; metadata?: Record<string, unknown> }): Promise<void> {
    // sessionId may be top-level or inside metadata (from agent's sendChatResponse)
    const sessionId = msg.sessionId ?? (msg.metadata?.sessionId as string | undefined);
    if (!sessionId || !this.waActiveChats.has(sessionId) || !msg.content) return;

    const jid = this.waActiveChats.get(sessionId)!;
    // Tag responses from non-default agents
    let content = msg.content;
    if (msg.from && msg.from !== 'jarvis' && msg.from !== 'user') {
      const agentName = msg.from.replace('agent-', '');
      content = `[${agentName}]: ${content}`;
    }

    try {
      await this.sendMessage({ to: jid, message: content });
    } catch (err) {
      log.error(`WhatsApp reply failed: ${(err as Error).message}`);
    }
  }

  // --- Proactive notifications ---

  async notify(text: string): Promise<void> {
    if (!this.waConnected) return;
    const config = this.deps.getChannelConfig('whatsapp');
    const jid = config.notificationJid as string;
    if (!jid) return;

    try {
      await this.sendMessage({ to: jid, message: text });
    } catch (err) {
      log.error(`WhatsApp notification failed: ${(err as Error).message}`);
    }
  }

  // --- Private: Media handling ---

  private async handleIncomingMedia(msg: any, from: string): Promise<void> {
    try {
      const baileys = await import('@whiskeysockets/baileys');
      const buffer = await baileys.downloadMediaMessage(msg, 'buffer', {});
      if (!buffer) return;

      const mediaDir = this.deps.nas.resolve('channels', 'whatsapp', 'media');
      if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });

      const ext = msg.message.imageMessage ? 'jpg' : (msg.message.documentMessage?.fileName?.split('.').pop() ?? 'bin');
      const filename = `${Date.now()}-${from.split('@')[0]}.${ext}`;
      const filePath = join(mediaDir, filename);

      const { writeFileSync } = await import('node:fs');
      writeFileSync(filePath, buffer as Buffer);
      log.info(`WhatsApp: saved media ${filename} (${(buffer as Buffer).length} bytes)`);
    } catch (err) {
      log.warn(`WhatsApp: failed to download media: ${(err as Error).message}`);
    }
  }

  // --- Private: Command handler ---

  private async handleCommand(text: string, lang: string, sessionId: string, from: string): Promise<string> {
    const cmd = text.replace(/^[/!]/, '').trim();
    const parts = cmd.split(/\s+/);
    const command = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);

    const isPl = lang === 'pl';
    const config = this.deps.getChannelConfig('whatsapp');

    switch (command) {
      // --- Existing commands ---
      case 'status': {
        const health = await this.deps.getHealthStatus();
        const agents = health.agents;
        const agentList = agents.map((a) => `${a.id.replace('agent-', '')}: ${a.status}`).join(', ');
        return isPl
          ? `System: ${health.status}. Uptime: ${this.deps.formatDuration(health.uptime)}. Agenci: ${agentList}. Infra: NATS=${health.infrastructure.nats ? 'OK' : 'DOWN'}, Redis=${health.infrastructure.redis ? 'OK' : 'DOWN'}`
          : `System: ${health.status}. Uptime: ${this.deps.formatDuration(health.uptime)}. Agents: ${agentList}. Infra: NATS=${health.infrastructure.nats ? 'OK' : 'DOWN'}, Redis=${health.infrastructure.redis ? 'OK' : 'DOWN'}`;
      }

      case 'agents': {
        const agents = await this.deps.store.getAllAgentStates();
        const list = agents.map((a) => `${a.identity.agentId} [${a.identity.role}]: ${a.status}`).join('\n');
        return isPl ? `Agenci:\n${list}` : `Agents:\n${list}`;
      }

      case 'tasks': {
        const tasks = await this.deps.store.getPendingTasks();
        if (tasks.length === 0) return isPl ? 'Brak oczekujących tasków.' : 'No pending tasks.';
        const list = tasks.slice(0, 5).map((t) => `• ${t.title ?? t.id}`).join('\n');
        return isPl ? `Taski (${tasks.length}):\n${list}` : `Tasks (${tasks.length}):\n${list}`;
      }

      case 'task': {
        const subCmd = args[0]?.toLowerCase();

        if (subCmd === 'create') {
          const taskText = args.slice(1).join(' ');
          if (!taskText) return isPl ? 'Podaj treść: /task create <tytuł> | <opis>' : 'Provide: /task create <title> | <description>';
          const [title, description] = taskText.includes('|') ? taskText.split('|').map((s) => s.trim()) : [taskText, taskText];
          const taskDef = {
            id: shortId(),
            title,
            description: description || title,
            priority: 5,
            requiredCapabilities: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await this.deps.store.createTask(taskDef as any);
          await this.deps.assignTask(taskDef as any);
          return isPl ? `Task utworzony: ${taskDef.id}\n${title}` : `Task created: ${taskDef.id}\n${title}`;
        }

        if (subCmd === 'cancel') {
          const taskId = args[1];
          if (!taskId) return isPl ? 'Podaj ID: /task cancel <id>' : 'Provide ID: /task cancel <id>';
          try {
            await this.deps.store.updateTask(taskId, { status: 'cancelled' } as any);
            return isPl ? `Task ${taskId} anulowany.` : `Task ${taskId} cancelled.`;
          } catch {
            return isPl ? `Nie znaleziono taska: ${taskId}` : `Task not found: ${taskId}`;
          }
        }

        if (subCmd === 'status') {
          const taskId = args[1];
          if (!taskId) return isPl ? 'Podaj ID: /task status <id>' : 'Provide ID: /task status <id>';
          try {
            const task = await this.deps.store.getTask(taskId);
            if (!task) return isPl ? `Nie znaleziono: ${taskId}` : `Not found: ${taskId}`;
            return `Task ${taskId}: ${(task as any).status ?? 'unknown'}\n${(task as any).title ?? ''}`;
          } catch {
            return isPl ? `Nie znaleziono: ${taskId}` : `Not found: ${taskId}`;
          }
        }

        // Default: create task (backward compat)
        const taskText = args.join(' ');
        if (!taskText) return isPl ? 'Podaj treść taska: /task <opis>' : 'Provide task text: /task <description>';
        const taskDef = {
          id: shortId(),
          title: taskText,
          description: taskText,
          priority: 5,
          requiredCapabilities: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await this.deps.store.createTask(taskDef as any);
        await this.deps.assignTask(taskDef as any);
        return isPl ? `Task utworzony: ${taskDef.id}` : `Task created: ${taskDef.id}`;
      }

      // --- Agent routing ---
      case 'agent': {
        const agentArg = args[0]?.toLowerCase();
        if (!agentArg) {
          const current = this.sessionAgent.get(sessionId) ?? (config.defaultAgent as string) ?? 'jarvis';
          return isPl ? `Aktywny agent: ${current}` : `Active agent: ${current}`;
        }

        const agentId = agentArg === 'jarvis' ? 'jarvis' : (agentArg.startsWith('agent-') ? agentArg : `agent-${agentArg}`);

        if (agentId === 'jarvis') {
          this.sessionAgent.delete(sessionId);
        } else {
          this.sessionAgent.set(sessionId, agentId);
        }

        const displayName = agentId.replace('agent-', '');
        return isPl ? `Przełączono na: ${displayName}` : `Switched to: ${displayName}`;
      }

      case 'broadcast': {
        const broadcastMsg = args.join(' ');
        if (!broadcastMsg) return isPl ? 'Podaj wiadomość: /broadcast <msg>' : 'Provide message: /broadcast <msg>';

        const agents = await this.deps.store.getAllAgentStates();
        for (const agent of agents) {
          const chatMsg: ChatMessage = {
            id: shortId(),
            from: 'user',
            to: agent.identity.agentId as ChatMessage['to'],
            content: `[WhatsApp broadcast]: ${broadcastMsg}`,
            timestamp: Date.now(),
            metadata: { source: 'whatsapp', whatsappJid: from, sessionId, language: lang },
          };
          await this.deps.nats.publish(NatsSubjects.chat(agent.identity.agentId), { ...chatMsg, sessionId });
        }

        return isPl
          ? `Wysłano broadcast do ${agents.length} agentów.`
          : `Broadcast sent to ${agents.length} agents.`;
      }

      // --- Shell command ---
      case 'cmd': {
        if (!(config.enableCommands as boolean)) {
          return isPl ? 'Komendy /cmd są wyłączone.' : '/cmd commands are disabled.';
        }

        const shellCmd = args.join(' ');
        if (!shellCmd) return isPl ? 'Podaj komendę: /cmd <polecenie>' : 'Provide command: /cmd <command>';

        // Blacklist check
        for (const pattern of CMD_BLACKLIST) {
          if (pattern.test(shellCmd)) {
            this.auditLog(from, shellCmd, false, 'BLACKLISTED');
            return isPl ? `Komenda zablokowana (blacklist): ${shellCmd}` : `Command blocked (blacklist): ${shellCmd}`;
          }
        }

        try {
          const output = execSync(shellCmd, {
            timeout: CMD_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            encoding: 'utf-8',
            cwd: process.env['HOME'] ?? '/tmp',
          });

          const trimmed = output.length > CMD_MAX_OUTPUT
            ? output.substring(0, CMD_MAX_OUTPUT) + `\n...(truncated ${output.length - CMD_MAX_OUTPUT} chars)`
            : output;

          this.auditLog(from, shellCmd, true);
          return `$ ${shellCmd}\n${trimmed || '(no output)'}`;
        } catch (err: any) {
          this.auditLog(from, shellCmd, false, err.message?.substring(0, 200));
          const stderr = err.stderr?.substring(0, CMD_MAX_OUTPUT) || err.message?.substring(0, 500) || 'Unknown error';
          return `$ ${shellCmd}\nERROR: ${stderr}`;
        }
      }

      // --- Screenshot ---
      case 'screenshot': {
        if (!(config.enableCommands as boolean)) {
          return isPl ? 'Komendy są wyłączone.' : 'Commands are disabled.';
        }

        try {
          const tmpPath = `/tmp/jarvis-screenshot-${Date.now()}.png`;
          execSync(`screencapture -x ${tmpPath}`, { timeout: 10000 });

          const imageBuffer = readFileSync(tmpPath);
          try { unlinkSync(tmpPath); } catch { /* */ }

          await this.sendImage({ to: from, image: imageBuffer, caption: 'Screenshot' });
          return ''; // Image already sent
        } catch (err) {
          return isPl
            ? `Błąd screenshot: ${(err as Error).message}`
            : `Screenshot error: ${(err as Error).message}`;
        }
      }

      // --- Logs ---
      case 'logs': {
        const agentArg = args[0] ?? 'gateway';
        try {
          const logsDir = this.deps.nas.resolve('logs');
          const logFile = join(logsDir, `${agentArg}.log`);

          if (!existsSync(logFile)) {
            return isPl ? `Brak logów dla: ${agentArg}` : `No logs for: ${agentArg}`;
          }

          const content = readFileSync(logFile, 'utf-8');
          const lines = content.trim().split('\n');
          const last30 = lines.slice(-30).join('\n');
          return `Logs (${agentArg}, last 30):\n${last30}`;
        } catch (err) {
          return `Logs error: ${(err as Error).message}`;
        }
      }

      // --- Ping ---
      case 'ping': {
        const health = await this.deps.getHealthStatus();
        const uptime = this.deps.formatDuration(health.uptime);
        return `Pong! Uptime: ${uptime}\nNATS: ${health.infrastructure.nats ? 'OK' : 'DOWN'}\nRedis: ${health.infrastructure.redis ? 'OK' : 'DOWN'}\nAgents: ${health.agents.length} (${health.agents.filter((a) => a.alive).length} alive)`;
      }

      // --- VNC info ---
      case 'vnc': {
        const agentArg = args[0];
        const agents = await this.deps.store.getAllAgentStates();
        if (agentArg) {
          const agentId = agentArg.startsWith('agent-') ? agentArg : `agent-${agentArg}`;
          const agent = agents.find((a) => a.identity.agentId === agentId);
          if (!agent) return isPl ? `Agent nie znaleziony: ${agentArg}` : `Agent not found: ${agentArg}`;
          return `VNC ${agent.identity.agentId}: status=${agent.status}`;
        }
        const list = agents.map((a) => `${a.identity.agentId}: ${a.status}`).join('\n');
        return `VNC agents:\n${list}`;
      }

      // --- Help ---
      case 'help': {
        return isPl
          ? `Komendy:
/status — stan systemu
/agents — lista agentów
/tasks — oczekujące taski
/task <opis> — utwórz task
/task create <tytuł> | <opis> — utwórz task
/task cancel <id> — anuluj task
/task status <id> — status taska
/agent — aktywny agent
/agent <nazwa> — przełącz agenta
/broadcast <msg> — wyślij do wszystkich
/cmd <polecenie> — komenda shell
/screenshot — zrzut ekranu
/logs [agent] — ostatnie 30 linii logów
/ping — health check
/vnc [agent] — info VNC
/help — ta wiadomość

Możesz też napisać normalnie — agent odpowie.`
          : `Commands:
/status — system health
/agents — list agents
/tasks — pending tasks
/task <desc> — create task
/task create <title> | <desc> — create task
/task cancel <id> — cancel task
/task status <id> — task status
/agent — show active agent
/agent <name> — switch agent
/broadcast <msg> — send to all agents
/cmd <command> — shell command
/screenshot — take screenshot
/logs [agent] — last 30 log lines
/ping — health check
/vnc [agent] — VNC info
/help — this message

You can also write normally — agent will reply.`;
      }

      default:
        return isPl ? `Nieznana komenda: /${command}. Wpisz /help.` : `Unknown command: /${command}. Type /help.`;
    }
  }

  // --- Private: Audit logging for /cmd ---

  private auditLog(jid: string, command: string, success: boolean, error?: string): void {
    try {
      const dir = this.deps.nas.resolve('channels', 'whatsapp');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const logFile = join(dir, 'cmd-audit.jsonl');
      const entry = {
        timestamp: new Date().toISOString(),
        jid,
        command,
        success,
        ...(error ? { error } : {}),
      };
      appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      log.warn(`Audit log failed: ${(err as Error).message}`);
    }
  }
}
