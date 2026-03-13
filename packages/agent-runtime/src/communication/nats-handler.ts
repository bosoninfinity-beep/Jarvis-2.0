import { connect, StringCodec, type NatsConnection, type Subscription } from 'nats';
import { networkInterfaces } from 'node:os';
import { connect as tcpConnect } from 'node:net';
import dns from 'node:dns';
import { createLogger, NatsSubjects, HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT, type AgentId, type AgentState, type AgentRole, type ChatStreamDelta } from '@jarvis/shared';

// Force IPv4-first DNS resolution — nats.js createConnection() doesn't set family:4,
// causing EHOSTUNREACH on macOS when Node.js tries IPv6-mapped addresses.
dns.setDefaultResultOrder('ipv4first');

/** Detect the primary LAN IPv4 address of this machine. */
function getLocalIp(): string {
  const nets = networkInterfaces();
  // Prefer en0 (WiFi/Ethernet on macOS), then any non-internal IPv4
  for (const name of ['en0', 'en1', 'eth0', 'wlan0']) {
    const iface = nets[name];
    if (iface) {
      const v4 = iface.find((n) => n.family === 'IPv4' && !n.internal);
      if (v4) return v4.address;
    }
  }
  // Fallback: any non-internal IPv4
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    const v4 = iface.find((n) => n.family === 'IPv4' && !n.internal);
    if (v4) return v4.address;
  }
  return '127.0.0.1';
}

const log = createLogger('agent:nats');
const sc = StringCodec();

/** Maximum NATS connection retries per cycle */
const MAX_CONNECT_RETRIES = 10;
/** Delay between NATS connection retries (ms) */
const CONNECT_RETRY_DELAY_MS = 5000;
/** Timeout for NATS drain on disconnect (ms) */
const DRAIN_TIMEOUT_MS = 5000;

export interface NatsHandlerConfig {
  agentId: AgentId;
  role: AgentRole;
  natsUrl: string;
  natsUrlThunderbolt?: string;
  capabilities: string[];
  machineId: string;
  hostname: string;
}

export interface TaskAssignment {
  taskId: string;
  title: string;
  description: string;
  priority: string;
  context?: Record<string, unknown>;
}

export interface PeerAgent {
  agentId: string;
  role: string;
  capabilities: string[];
  machineId: string;
  hostname: string;
  ip: string;
  status: string;
  lastSeen: number;
}

export interface InterAgentMsg {
  id: string;
  type: string;
  from: string;
  to?: string;
  content?: string;
  payload?: unknown;
  replyTo?: string;
  timestamp: number;
}

/**
 * NatsHandler manages NATS connectivity for an agent:
 * - Heartbeat broadcasts
 * - Status updates
 * - Task reception
 * - Result publishing
 * - Inter-agent messaging (DM, broadcast, discovery)
 * - Coordination (task delegation)
 */
export class NatsHandler {
  private nc: NatsConnection | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private subscriptions: Subscription[] = [];
  private subscriptionLoops: Promise<void>[] = [];
  private taskCallback: ((task: TaskAssignment) => void) | null = null;
  private chatCallback: ((msg: { from: string; content: string; sessionId?: string; metadata?: Record<string, unknown> }) => void) | null = null;
  private dmCallback: ((msg: InterAgentMsg) => void) | null = null;
  private broadcastCallback: ((msg: InterAgentMsg) => void) | null = null;
  private coordinationCallback: ((msg: InterAgentMsg) => void) | null = null;
  private startedAt: number = Date.now();
  private completedTasks: number = 0;
  private failedTasks: number = 0;
  private currentStatus: string = 'starting';
  private activeTaskId: string | null = null;
  private activeTaskDescription: string | null = null;
  private running = true;

  /** Known peer agents in the system */
  readonly peers: Map<string, PeerAgent> = new Map();

  /** Auto-detected local IP address */
  readonly localIp: string;

  constructor(private config: NatsHandlerConfig) {
    this.localIp = getLocalIp();
  }

  /** TCP probe: warm up ARP cache and verify reachability before nats.js connect */
  private async tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const sock = tcpConnect({ host, port, family: 4, timeout: timeoutMs }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', (err) => { log.warn(`TCP probe error: ${(err as Error).message}`); sock.destroy(); resolve(false); });
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
    });
  }

  /** Parse servers list into {host, port} tuples */
  private get serverAddrs(): Array<{ host: string; port: number }> {
    const servers = [
      this.config.natsUrlThunderbolt,
      this.config.natsUrl,
    ].filter((s): s is string => !!s);
    return servers.map((srv) => {
      const url = new URL(srv);
      return { host: url.hostname, port: parseInt(url.port || '4222', 10) };
    });
  }

  /** Build nats.js connection options */
  private buildNatsOpts(): Record<string, unknown> {
    const servers = [
      this.config.natsUrlThunderbolt,
      this.config.natsUrl,
    ].filter((s): s is string => !!s);

    const opts: Record<string, unknown> = {
      servers,
      name: this.config.agentId,
      reconnect: true,
      reconnectTimeWait: 5_000,   // Wait 5s between reconnect attempts (was 3s)
      maxReconnectAttempts: 20,   // Max 20 attempts (~2 min), then scheduleReconnect takes over
      pingInterval: 15_000,       // Client ping every 15s (was 5s — less aggressive)
      maxPingOut: 3,              // Allow 3 missed pongs (= 45s before disconnect)
      timeout: 10_000,            // Initial connection timeout
      noEcho: true,
    };

    if (process.env['NATS_USER'] && process.env['NATS_PASS']) {
      opts.user = process.env['NATS_USER'];
      opts.pass = process.env['NATS_PASS'];
    } else if (process.env['NATS_TOKEN']) {
      opts.token = process.env['NATS_TOKEN'];
    }
    return opts;
  }

  /** Establish NATS connection with retry */
  private async connectOnce(): Promise<NatsConnection> {
    const opts = this.buildNatsOpts();

    for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
      // TCP probe to warm ARP cache (non-blocking, no execSync)
      for (const addr of this.serverAddrs) {
        await this.tcpProbe(addr.host, addr.port, 2000).catch(() => {});
      }

      try {
        return await connect(opts as Parameters<typeof connect>[0]);
      } catch (err) {
        if (attempt === MAX_CONNECT_RETRIES) throw err;
        log.warn(`NATS connect attempt ${attempt}/${MAX_CONNECT_RETRIES} failed: ${(err as Error).message}. Retrying in ${CONNECT_RETRY_DELAY_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, CONNECT_RETRY_DELAY_MS));
      }
    }
    throw new Error('Unreachable');
  }

  async connect(): Promise<void> {
    this.nc = await this.connectOnce();
    log.info(`Connected to NATS — server: ${this.nc.getServer()}`);
    this.setupAfterConnect();
  }

  /** Wire up subscriptions, heartbeat, and status monitor after a (re)connect */
  private setupAfterConnect(): void {
    if (!this.nc) return;

    // Clear old subscriptions
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    // Monitor connection status and trigger manual reconnect on disconnect
    this.subscriptionLoops.push((async () => {
      if (!this.nc) return;
      try {
        for await (const status of this.nc.status()) {
          switch (status.type) {
            case 'disconnect':
              log.warn(`NATS disconnected — nats.js will auto-reconnect`);
              break;
            case 'reconnect':
              log.info(`NATS reconnected to ${String(status.data)}`);
              // Re-register and re-announce after reconnect
              this.register().catch(() => {});
              this.announcePresence('online').catch(() => {});
              break;
            case 'error':
              log.error(`NATS error: ${String(status.data)}`);
              break;
            default:
              log.info(`NATS status: ${status.type} data=${String(status.data)}`);
          }
        }
      } catch (err) {
        log.warn(`NATS status monitor ended: ${(err as Error).message}`);
        this.scheduleReconnect();
      }
    })());

    this.register().catch(() => {});
    this.startHeartbeat();
    this.subscribeToTasks();
    this.subscribeToChat();
    this.subscribeToDiscovery();
    this.subscribeToDM();
    this.subscribeToAgentsBroadcast();
    this.subscribeToCoordination();
    this.subscribeToPing();
    this.announcePresence('online').catch(() => {});
  }

  /** Manual reconnect loop with TCP warmup */
  private scheduleReconnect(): void {
    if (!this.running) return;

    // Stop heartbeat during reconnect
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    const MAX_RECONNECT_CYCLES = 12; // ~3 minutes with exponential backoff
    const doReconnect = async () => {
      for (let i = 1; this.running; i++) {
        try {
          // Close old connection if it exists
          if (this.nc && !this.nc.isClosed()) {
            try { await this.nc.close(); } catch { /* ignore */ }
          }

          log.info(`Reconnect attempt ${i}/${MAX_RECONNECT_CYCLES}...`);
          this.nc = await this.connectOnce();
          log.info(`Reconnected to NATS — server: ${this.nc.getServer()}`);
          this.setupAfterConnect();
          return; // Success
        } catch (err) {
          if (i >= MAX_RECONNECT_CYCLES) {
            log.error(`NATS reconnect failed after ${i} attempts — setting agent status to error`);
            this.currentStatus = 'error';
            return;
          }
          // Exponential backoff: 5s, 10s, 15s, 20s... max 30s
          const delay = Math.min(5_000 * i, 30_000);
          log.warn(`Reconnect cycle ${i}/${MAX_RECONNECT_CYCLES} failed: ${(err as Error).message}. Waiting ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    };

    doReconnect().catch((err) => {
      log.error(`Reconnect loop crashed: ${(err as Error).message}`);
    });
  }

  // ─── Agent State ──────────────────────────────────

  private buildAgentState(): AgentState {
    return {
      identity: {
        agentId: this.config.agentId,
        role: this.config.role,
        machineId: this.config.machineId,
        hostname: this.config.hostname,
        ip: this.localIp,
      },
      status: this.currentStatus as AgentState['status'],
      activeTaskId: this.activeTaskId,
      activeTaskDescription: this.activeTaskDescription,
      lastHeartbeat: Date.now(),
      startedAt: this.startedAt,
      completedTasks: this.completedTasks,
      failedTasks: this.failedTasks,
    };
  }

  private async register(): Promise<void> {
    this.currentStatus = 'idle';
    const state = this.buildAgentState();
    await this.publish(NatsSubjects.agentStatus(this.config.agentId), state);
    log.info(`Registered agent: ${this.config.agentId} (role: ${this.config.role})`);
  }

  // ─── Heartbeat ────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.publish(NatsSubjects.agentHeartbeat(this.config.agentId), {
          agentId: this.config.agentId,
          timestamp: Date.now(),
          memoryUsage: process.memoryUsage().heapUsed,
          uptime: process.uptime(),
          status: this.currentStatus,
          peers: Array.from(this.peers.keys()),
        });
        const state = this.buildAgentState();
        await this.publish(NatsSubjects.agentStatus(this.config.agentId), state);

        // Re-announce presence so peers refresh lastSeen
        await this.announcePresence('online');

        // Prune stale peers
        const now = Date.now();
        for (const [id, peer] of this.peers) {
          if (now - peer.lastSeen > HEARTBEAT_TIMEOUT) {
            this.peers.delete(id);
            log.info(`Peer ${id} went offline (timeout)`);
          }
        }
      } catch (err) {
        log.error(`Heartbeat failed: ${(err as Error).message} — closed=${this.nc?.isClosed()} stack=${(err as Error).stack?.split('\n').slice(1, 3).join(' | ')}`);
      }
    }, HEARTBEAT_INTERVAL);
  }

  // ─── Task Subscriptions ───────────────────────────

  private subscribeToTasks(): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(NatsSubjects.agentTask(this.config.agentId));
    this.subscriptions.push(sub);

    this.subscriptionLoops.push((async () => {
      try {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data)) as TaskAssignment;
            log.info(`Received task: ${data.taskId} - ${data.title}`);
            this.taskCallback?.(data);
          } catch (err) {
            log.error(`Failed to parse task message: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        log.warn(`Task subscription ended: ${(err as Error).message}`);
      }
    })());
  }

  private subscribeToChat(): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(NatsSubjects.chat(this.config.agentId));
    this.subscriptions.push(sub);

    this.subscriptionLoops.push((async () => {
      try {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data)) as { from: string; content: string; sessionId?: string; metadata?: Record<string, unknown> };
            log.info(`Chat from ${data.from}: ${data.content.slice(0, 80)}`);
            this.chatCallback?.(data);
          } catch (err) {
            log.error(`Failed to parse chat message: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        log.warn(`Chat subscription ended: ${(err as Error).message}`);
      }
    })());
  }

  // ─── Inter-Agent Communication ────────────────────

  /** Subscribe to agent discovery announcements */
  private subscribeToDiscovery(): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(NatsSubjects.agentsDiscovery);
    this.subscriptions.push(sub);

    this.subscriptionLoops.push((async () => {
      try {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data)) as {
              agentId: string; role: string; capabilities: string[];
              machineId: string; hostname: string; ip?: string; status: string; timestamp: number;
            };
            if (data.agentId === this.config.agentId) continue; // skip self

            if (data.status === 'offline') {
              this.peers.delete(data.agentId);
              log.info(`Peer ${data.agentId} announced offline`);
            } else {
              const isNew = !this.peers.has(data.agentId);
              this.peers.set(data.agentId, {
                agentId: data.agentId,
                role: data.role,
                capabilities: data.capabilities,
                machineId: data.machineId,
                hostname: data.hostname,
                ip: data.ip ?? '',
                status: data.status,
                lastSeen: Date.now(),
              });
              if (isNew) {
                log.info(`Discovered peer: ${data.agentId} (role: ${data.role}, machine: ${data.hostname})`);
                // Announce back so the new agent knows about us
                await this.announcePresence('online');
              }
            }
          } catch (err) {
            log.error(`Discovery parse error: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        log.warn(`Discovery subscription ended: ${(err as Error).message}`);
      }
    })());
  }

  /** Subscribe to direct messages from other agents */
  private subscribeToDM(): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(NatsSubjects.agentDM(this.config.agentId));
    this.subscriptions.push(sub);

    this.subscriptionLoops.push((async () => {
      try {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data)) as InterAgentMsg;
            log.info(`DM from ${data.from}: ${(data.content || '').slice(0, 80)}`);

            // Update peer last seen
            if (this.peers.has(data.from)) {
              this.peers.get(data.from)!.lastSeen = Date.now();
            }

            this.dmCallback?.(data);
          } catch (err) {
            log.error(`DM parse error: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        log.warn(`DM subscription ended: ${(err as Error).message}`);
      }
    })());
  }

  /** Subscribe to shared agents broadcast channel */
  private subscribeToAgentsBroadcast(): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(NatsSubjects.agentsBroadcast);
    this.subscriptions.push(sub);

    this.subscriptionLoops.push((async () => {
      try {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data)) as InterAgentMsg;
            if (data.from === this.config.agentId) continue; // skip own broadcasts
            log.info(`Broadcast from ${data.from}: ${data.type} — ${(data.content || '').slice(0, 60)}`);

            // Update peer last seen
            if (this.peers.has(data.from)) {
              this.peers.get(data.from)!.lastSeen = Date.now();
            }

            this.broadcastCallback?.(data);
          } catch (err) {
            log.error(`Broadcast parse error: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        log.warn(`Broadcast subscription ended: ${(err as Error).message}`);
      }
    })());
  }

  /** Subscribe to coordination requests (task delegation) */
  private subscribeToCoordination(): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(NatsSubjects.coordinationRequest);
    this.subscriptions.push(sub);

    this.subscriptionLoops.push((async () => {
      try {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data)) as InterAgentMsg;
            if (data.from === this.config.agentId) continue;
            // Only handle if directed at us or broadcast
            if (data.to && data.to !== this.config.agentId) continue;

            log.info(`Coordination from ${data.from}: ${data.type} — ${(data.content || '').slice(0, 60)}`);
            this.coordinationCallback?.(data);
          } catch (err) {
            log.error(`Coordination parse error: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        log.warn(`Coordination subscription ended: ${(err as Error).message}`);
      }
    })());
  }

  /** Respond to gateway active pings with agent status */
  private subscribeToPing(): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(NatsSubjects.agentPing(this.config.agentId));
    this.subscriptions.push(sub);

    this.subscriptionLoops.push((async () => {
      try {
        for await (const msg of sub) {
          try {
            const reply = {
              agentId: this.config.agentId,
              status: this.currentStatus,
              uptime: process.uptime(),
              timestamp: Date.now(),
            };
            if (msg.reply) {
              this.nc!.publish(msg.reply, sc.encode(JSON.stringify(reply)));
            }
          } catch (err) {
            log.error(`Ping response error: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        log.warn(`Ping subscription ended: ${(err as Error).message}`);
      }
    })());
  }

  // ─── Callbacks ────────────────────────────────────

  onTask(callback: (task: TaskAssignment) => void): void {
    this.taskCallback = callback;
  }

  onChat(callback: (msg: { from: string; content: string; sessionId?: string; metadata?: Record<string, unknown> }) => void): void {
    this.chatCallback = callback;
  }

  onDM(callback: (msg: InterAgentMsg) => void): void {
    this.dmCallback = callback;
  }

  onBroadcast(callback: (msg: InterAgentMsg) => void): void {
    this.broadcastCallback = callback;
  }

  onCoordination(callback: (msg: InterAgentMsg) => void): void {
    this.coordinationCallback = callback;
  }

  // ─── Publishing ───────────────────────────────────

  /** Announce presence on discovery channel */
  async announcePresence(status: 'online' | 'offline'): Promise<void> {
    await this.publish(NatsSubjects.agentsDiscovery, {
      agentId: this.config.agentId,
      role: this.config.role,
      capabilities: this.config.capabilities,
      machineId: this.config.machineId,
      hostname: this.config.hostname,
      ip: this.localIp,
      status,
      timestamp: Date.now(),
    });
    log.info(`Announced presence: ${status} (peers: ${this.peers.size})`);
  }

  /** Send direct message to another agent */
  async sendDM(toAgentId: string, content: string, payload?: unknown): Promise<void> {
    const msg: InterAgentMsg = {
      id: `dm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'dm',
      from: this.config.agentId,
      to: toAgentId,
      content,
      payload,
      timestamp: Date.now(),
    };
    await this.publish(NatsSubjects.agentDM(toAgentId), msg);
    log.info(`DM sent to ${toAgentId}: ${content.slice(0, 60)}`);
  }

  /** Broadcast message to all agents */
  async broadcastToAgents(content: string, type: string = 'broadcast', payload?: unknown): Promise<void> {
    const msg: InterAgentMsg = {
      id: `bc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      from: this.config.agentId,
      content,
      payload,
      timestamp: Date.now(),
    };
    await this.publish(NatsSubjects.agentsBroadcast, msg);
  }

  /** Request task delegation to another agent */
  async delegateTask(toAgentId: string, task: { taskId?: string; title: string; description: string; priority?: string }): Promise<void> {
    const msg: InterAgentMsg = {
      id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'delegation',
      from: this.config.agentId,
      to: toAgentId,
      content: task.title,
      payload: task,
      timestamp: Date.now(),
    };
    await this.publish(NatsSubjects.coordinationRequest, msg);
    log.info(`Delegation request to ${toAgentId}: ${task.title}`);
  }

  /** Respond to coordination request */
  async respondCoordination(replyTo: string, accepted: boolean, reason?: string): Promise<void> {
    const msg: InterAgentMsg = {
      id: `coord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'delegation-ack',
      from: this.config.agentId,
      content: accepted ? 'accepted' : `rejected: ${reason || 'busy'}`,
      replyTo,
      timestamp: Date.now(),
    };
    await this.publish(NatsSubjects.coordinationResponse, msg);
  }

  /** Publish status update */
  async updateStatus(status: string, activeTaskId?: string, activeTaskDescription?: string): Promise<void> {
    this.currentStatus = status;
    this.activeTaskId = activeTaskId ?? null;
    this.activeTaskDescription = activeTaskDescription ?? null;
    const state = this.buildAgentState();
    await this.publish(NatsSubjects.agentStatus(this.config.agentId), state);
  }

  trackTaskComplete(success: boolean): void {
    if (success) this.completedTasks++;
    else this.failedTasks++;
  }

  /**
   * Sanitize an external ID for safe use in a NATS subject.
   * Strips NATS wildcard characters (`*`, `>`), subject delimiters (`.`),
   * and any whitespace to prevent subject injection.
   */
  private sanitizeSubjectToken(id: string): string {
    return id.replace(/[*.>\s]/g, '_');
  }

  async publishResult(taskId: string, result: { success: boolean; output: string; artifacts?: string[] }): Promise<void> {
    await this.publish(NatsSubjects.agentResult(this.config.agentId), {
      agentId: this.config.agentId,
      taskId,
      ...result,
      timestamp: Date.now(),
    });
  }

  async publishProgress(taskId: string, progress: { step: string; percentage?: number; log?: string }): Promise<void> {
    const safeTaskId = this.sanitizeSubjectToken(taskId);
    await this.publish(`jarvis.task.${safeTaskId}.progress`, {
      agentId: this.config.agentId,
      taskId,
      ...progress,
      timestamp: Date.now(),
    });
  }

  async broadcastDashboard(event: string, payload: unknown): Promise<void> {
    await this.publish(NatsSubjects.dashboardBroadcast, {
      event,
      source: this.config.agentId,
      payload,
      timestamp: Date.now(),
    });
  }

  async sendChatResponse(content: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.publish(NatsSubjects.chatBroadcast, {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: this.config.agentId,
      to: 'user',
      role: this.config.role,
      content,
      timestamp: Date.now(),
      metadata: metadata ?? {},
    });
  }

  /** Publish an ephemeral streaming delta (thinking/text/tool_start/done) — not persisted */
  async sendChatStream(delta: Omit<ChatStreamDelta, 'from' | 'timestamp'>): Promise<void> {
    await this.publish(NatsSubjects.chatStream, {
      from: this.config.agentId,
      ...delta,
      timestamp: Date.now(),
    });
  }

  /** Get list of known online peers */
  getPeers(): PeerAgent[] {
    return Array.from(this.peers.values());
  }

  /** Check if a specific agent is online */
  isPeerOnline(agentId: string): boolean {
    const peer = this.peers.get(agentId);
    return !!peer && (Date.now() - peer.lastSeen) < HEARTBEAT_TIMEOUT;
  }

  // ─── Low-level ────────────────────────────────────

  async publish(subject: string, data: unknown): Promise<void> {
    if (!this.nc) throw new Error('Not connected to NATS');
    if (this.nc.isClosed()) {
      log.warn(`Publish to ${subject} skipped — connection closed`);
      return;
    }
    try {
      this.nc.publish(subject, sc.encode(JSON.stringify(data)));
    } catch (err) {
      log.error(`Publish to ${subject} FAILED: ${(err as Error).message}`);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.running = false; // Prevent reconnect loop from restarting

    // Announce offline before disconnecting
    try {
      await this.announcePresence('offline');
    } catch { /* ignore if NATS already gone */ }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    if (this.nc) {
      // Drain with timeout to prevent hanging on stuck subscriptions
      try {
        await Promise.race([
          this.nc.drain(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Drain timeout')), DRAIN_TIMEOUT_MS)),
        ]);
      } catch (err) {
        log.warn(`NATS drain timeout/failed: ${(err as Error).message}`);
        try { this.nc.close(); } catch { /* ignore */ }
      }
      this.nc = null;
      log.info('Disconnected from NATS');
    }

    // Wait for subscription loops to finish (with timeout to prevent hanging)
    if (this.subscriptionLoops.length > 0) {
      const SUB_CLEANUP_TIMEOUT = 5_000;
      try {
        await Promise.race([
          Promise.allSettled(this.subscriptionLoops),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Subscription cleanup timeout')), SUB_CLEANUP_TIMEOUT)),
        ]);
      } catch {
        log.warn(`Subscription loops did not finish within ${SUB_CLEANUP_TIMEOUT}ms — forcing cleanup`);
      }
    }
    this.subscriptionLoops = [];
  }
}
