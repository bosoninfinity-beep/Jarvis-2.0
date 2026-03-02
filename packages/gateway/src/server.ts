import express from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, cpus, totalmem, freemem, loadavg, networkInterfaces, uptime as osUptime } from 'node:os';
import { execSync, execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { timingSafeEqual, createHash, createHmac, randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);
import { z } from 'zod';
import {
  createLogger,
  shortId,
  DEFAULT_GATEWAY_PORT,
  NatsSubjects,
  HEARTBEAT_TIMEOUT,
  PROJECT_NAME,
  PROJECT_VERSION,
  AGENT_DEFAULTS,
  type AgentState,
  type AgentId,
  type TaskDefinition,
  type ChatMessage,
  type AgentRegistryEntry,
  RateLimiter,
  initAuditLogger,
  getAuditLogger,
} from '@jarvis/shared';
import { NatsClient } from './nats/client.js';
import { RedisClient } from './redis/client.js';
import { StateStore } from './redis/state-store.js';
import { NasPaths } from './nas/paths.js';
import { AuthManager } from './auth/auth.js';
import { ProtocolHandler } from './protocol/handler.js';
import { DependencyOrchestrator } from './orchestration/dependency-orchestrator.js';
import { maskSecret, isSecretKey, stripHtml, formatDuration } from './utils.js';
import {
  getChannelConfig as _getChannelConfig,
  setChannelConfig as _setChannelConfig,
  getChannelMessages as _getChannelMessages,
  appendChannelMessage as _appendChannelMessage,
} from './channels/config.js';

const log = createLogger('gateway:server');

const knownAgents = new Set<string>(['jarvis', 'agent-smith', 'agent-johny']);

// Rate limiters
const wsRateLimiter = new RateLimiter(30);   // 30 msgs/min per WS connection
const apiRateLimiter = new RateLimiter(120);  // 120 req/min per IP
const authTokenRateLimiter = new RateLimiter(10); // 10 req/min for /auth/token

// Zod schema for chat.send validation
const chatSendSchema = z.object({
  id: z.string().max(64).optional(),
  from: z.string().min(1).max(100),
  to: z.string().min(1).max(100).optional(),
  content: z.string().min(1).max(50000),
  type: z.string().max(50).optional(),
  sessionId: z.string().max(128).regex(/^[a-zA-Z0-9_\-]+$/).optional(),
  timestamp: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Utility functions moved to ./utils.ts

export interface GatewayConfig {
  port: number;
  host: string;
  authToken: string;
  natsUrl: string;
  natsUrlThunderbolt?: string;
  redisUrl: string;
  nasMountPath?: string;
}

export class GatewayServer {
  private app: ReturnType<typeof express>;
  private httpServer: Server;
  private wss: WebSocketServer;
  private protocol: ProtocolHandler;
  private nats: NatsClient;
  private redis: RedisClient;
  private store: StateStore;
  private nas: NasPaths;
  private auth: AuthManager;
  private orchestrator: DependencyOrchestrator;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private updateCheckInterval: ReturnType<typeof setInterval> | null = null;
  private updateAvailable: { commitsBehind: number; latestCommit: string; latestMessage: string; localHead: string; remoteHead: string } | null = null;
  private updateInProgress = false;
  private agentStates = new Map<string, { status: string; activeTaskId: string | null }>();
  private spawnedAgents = new Map<string, import('node:child_process').ChildProcess>();

  constructor(private readonly config: GatewayConfig) {
    this.app = express();
    this.httpServer = createServer(this.app);
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: 64 * 1024, // 64 KB max message size
      verifyClient: ({ req }) => {
        // Allow loopback connections unconditionally
        const ip = req.socket.remoteAddress ?? '';
        if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
        // Reject if origin header is set and doesn't match a trusted pattern
        const origin = req.headers.origin;
        if (origin) {
          try {
            const url = new URL(origin);
            const allowed = url.hostname === 'localhost'
              || url.hostname === '127.0.0.1'
              || url.hostname.endsWith('.local');
            if (!allowed) {
              log.warn(`WebSocket rejected origin: ${origin} from ${ip}`);
              return false;
            }
          } catch {
            return false;
          }
        }
        return true;
      },
    });
    this.protocol = new ProtocolHandler();
    this.nats = new NatsClient(config.natsUrl, config.natsUrlThunderbolt);
    this.redis = new RedisClient(config.redisUrl);
    this.store = new StateStore(this.redis);
    this.nas = new NasPaths(config.nasMountPath);
    this.auth = new AuthManager(config.authToken);
    this.orchestrator = new DependencyOrchestrator({
      nasPath: config.nasMountPath ?? '',
      maxConcurrentPerAgent: 1,
      maxTotalConcurrent: 4,
      maxDepth: 2,
    });

    this.setupHttpRoutes();
    this.setupWebSocket();
    this.registerMethods();
  }

  /** Start the gateway server */
  async start(): Promise<void> {
    log.info(`Starting ${PROJECT_NAME} v${PROJECT_VERSION} Gateway...`);

    // Initialize audit logger
    const auditLogPath = this.nas.resolve('logs', 'security-audit.jsonl');
    initAuditLogger({
      logFilePath: auditLogPath,
      onEvent: (event) => {
        // Publish security events to NATS if connected
        if (this.nats.isConnected) {
          void this.nats.publish('jarvis.security.audit', event);
        }
      },
    });
    log.info(`Security audit log: ${auditLogPath}`);

    // Connect to infrastructure
    await this.nats.connect();
    await this.redis.connect();
    this.nas.ensureDirectories();

    // Setup NATS subscriptions for agent events
    this.setupNatsSubscriptions();

    // Start dependency orchestrator
    this.setupOrchestrator();
    this.orchestrator.start();

    // Start health monitoring
    this.startHealthMonitoring();

    // Start update checker (every 5 min)
    this.startUpdateChecker();

    // Start HTTP+WS server
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', (err: NodeJS.ErrnoException) => {
        log.error(`HTTP server failed to start: ${err.message}`, { code: err.code });
        process.exit(1);
      });
      this.httpServer.listen(this.config.port, this.config.host, () => {
        log.info(`Gateway listening on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
    });

    // Post-restart: check if we just completed an OTA update
    this.broadcastUpdateStatusOnRestart();
  }

  /** Stop the gateway */
  async stop(): Promise<void> {
    log.info('Shutting down gateway...');
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.updateCheckInterval) clearInterval(this.updateCheckInterval);
    this.orchestrator.stop();

    // Close all WebSocket connections gracefully
    for (const client of this.wss.clients) {
      try { client.close(1001, 'Server shutting down'); } catch { /* ignore */ }
    }

    // Close the WebSocket server
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });

    // Close HTTP server and await completion
    await new Promise<void>((resolve) => {
      this.httpServer.close((err) => {
        if (err) { log.warn('HTTP server close error', { error: String(err) }); }
        resolve();
      });
    });

    await this.nats.close();
    await this.redis.close();
    log.info('Gateway stopped');
  }

  // --- HTTP Routes ---

  private setupHttpRoutes(): void {
    this.app.use(express.json({ limit: '1mb' }));

    // Security headers
    this.app.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data: blob:");
      if (_req.secure || _req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
      next();
    });

    // Rate limiting for REST API
    this.app.use('/api', (req, res, next) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';

      // Check if IP is blocked by audit logger
      if (getAuditLogger().isBlocked(ip)) {
        res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
        return;
      }

      if (!apiRateLimiter.allow(ip)) {
        getAuditLogger().logEvent('rate_limit.exceeded', 'gateway:http', { ip, path: req.path });
        res.status(429).json({ error: 'Rate limit exceeded. Max 120 requests per minute.' });
        return;
      }
      next();
    });

    // Auth middleware for /api/* routes
    const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
      const token = req.headers.authorization?.replace('Bearer ', '') || req.query['token'] as string;
      const ip = req.ip || req.socket.remoteAddress || 'unknown';

      if (!token || !this.auth.verifyDashboardToken(token)) {
        getAuditLogger().logEvent('auth.failure', 'gateway:http', { ip, path: req.path, method: req.method }, ip);
        getAuditLogger().trackFailedAuth(ip);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      getAuditLogger().clearFailedAuth(ip);
      next();
    };

    // Health check - no auth required
    this.app.get('/health', async (_req, res) => {
      const health = await this.getHealthStatus();
      res.json(health);
    });

    // Auth token endpoint - only accessible from localhost for initial dashboard setup
    this.app.get('/auth/token', (req, res) => {
      const ip = req.ip || req.socket.remoteAddress || '';
      const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
      if (!isLocal) {
        log.warn(`/auth/token access denied from non-local IP: ${ip}`);
        res.status(403).json({ error: 'Token endpoint only accessible from localhost' });
        return;
      }
      if (!authTokenRateLimiter.allow(ip)) {
        log.warn(`/auth/token rate limit exceeded for IP: ${ip}`);
        res.status(429).json({ error: 'Too many requests' });
        return;
      }
      log.info(`/auth/token accessed from ${ip}`);
      res.json({ token: this.auth.getDashboardToken() });
    });

    // Webhook endpoints - authenticated via their own mechanisms (BEFORE auth middleware)
    this.app.get('/api/whatsapp/webhook', (req, res) => {
      const mode = req.query['hub.mode'];
      const wToken = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      const waConfig = this.getChannelConfig('whatsapp') as Record<string, unknown>;
      const verifyToken = (waConfig?.verifyToken as string) ?? 'jarvis-whatsapp-verify';
      if (mode === 'subscribe' && wToken === verifyToken) {
        log.info('WhatsApp webhook verified');
        res.status(200).send(challenge);
      } else {
        res.sendStatus(403);
      }
    });
    this.app.post('/api/whatsapp/webhook', async (req, res) => {
      try { await this.handleWhatsAppWebhook(req.body as Record<string, unknown>); res.sendStatus(200); }
      catch (err) { log.error('WhatsApp webhook error', { error: String(err) }); res.sendStatus(500); }
    });
    this.app.post('/api/telegram/webhook', async (req, res) => {
      try { await this.handleTelegramWebhook(req.body as Record<string, unknown>); res.sendStatus(200); }
      catch (err) { log.error('Telegram webhook error', { error: String(err) }); res.sendStatus(500); }
    });
    this.app.post('/api/discord/webhook', async (req, res) => {
      try { await this.handleDiscordWebhook(req.body as Record<string, unknown>); res.sendStatus(200); }
      catch (err) { log.error('Discord webhook error', { error: String(err) }); res.sendStatus(500); }
    });
    this.app.post('/api/slack/events', express.raw({ type: '*/*' }), async (req, res) => {
      try {
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body));
        const bodyStr = rawBody.toString('utf-8');
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(bodyStr) as Record<string, unknown>; }
        catch { res.status(400).json({ error: 'Invalid JSON' }); return; }

        // url_verification challenge (Slack Event API setup)
        if (payload.type === 'url_verification') {
          res.json({ challenge: payload.challenge });
          return;
        }

        // Verify signing secret
        const config = this.getChannelConfig('slack');
        const signingSecret = config.signingSecret as string;
        if (signingSecret) {
          const timestamp = req.headers['x-slack-request-timestamp'] as string;
          const slackSig = req.headers['x-slack-signature'] as string;
          if (!timestamp || !slackSig) { res.sendStatus(401); return; }
          const age = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
          if (age > 300) { res.status(403).json({ error: 'Timestamp too old' }); return; }
          const baseString = `v0:${timestamp}:${bodyStr}`;
          const computed = 'v0=' + createHmac('sha256', signingSecret).update(baseString).digest('hex');
          if (!timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig))) {
            res.sendStatus(401);
            return;
          }
        }

        if (payload.type === 'event_callback') {
          await this.handleSlackWebhook(payload);
        }
        res.sendStatus(200);
      } catch (err) {
        log.error('Slack events webhook error', { error: String(err) });
        res.sendStatus(500);
      }
    });

    // Apply auth to all remaining /api/* routes
    this.app.use('/api', requireAuth);

    // Serve iMessage attachment files (images, videos, etc.)
    this.app.get('/api/imessage/attachment', (req, res) => {
      const filePath = req.query.path as string;
      if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
      // Security: only allow files under ~/Library/Messages/Attachments
      const home = process.env['HOME'] ?? '';
      const allowedPrefix = join(home, 'Library/Messages/Attachments');
      const resolved = resolve(filePath);
      if (!resolved.startsWith(allowedPrefix)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      if (!existsSync(resolved)) { res.status(404).json({ error: 'File not found' }); return; }
      res.sendFile(resolved);
    });

    // Serve social media files (images, videos) for dashboard thumbnail preview
    this.app.get('/api/social/media', (req, res) => {
      const filePath = req.query.path as string;
      if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
      const resolved = resolve(filePath);
      // Security: block path traversal attempts
      if (resolved.includes('..') || !existsSync(resolved)) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      const ext = resolved.slice(resolved.lastIndexOf('.')).toLowerCase();
      const allowed = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.avi', '.webm', '.heic', '.heif']);
      if (!allowed.has(ext)) {
        res.status(403).json({ error: 'File type not allowed' });
        return;
      }
      res.sendFile(resolved);
    });

    this.app.get('/api/agents', async (_req, res) => {
      const agents = await this.store.getAllAgentStates();
      res.json({ agents });
    });

    this.app.get('/api/tasks', async (_req, res) => {
      const tasks = await this.store.getPendingTasks();
      res.json({ tasks });
    });

    this.app.get('/api/vnc', (_req, res) => {
      // Prefer Thunderbolt IPs for VNC (10 Gbps = smoother stream)
      const tbEnabled = process.env['THUNDERBOLT_ENABLED'] === 'true';
      const smithHost = (tbEnabled && process.env['VNC_SMITH_HOST_THUNDERBOLT'])
        ? process.env['VNC_SMITH_HOST_THUNDERBOLT']
        : process.env['VNC_SMITH_HOST'] ?? process.env['VNC_ALPHA_HOST'] ?? '192.168.1.37';
      const johnyHost = (tbEnabled && process.env['VNC_JOHNY_HOST_THUNDERBOLT'])
        ? process.env['VNC_JOHNY_HOST_THUNDERBOLT']
        : process.env['VNC_JOHNY_HOST'] ?? process.env['VNC_BETA_HOST'] ?? '192.168.1.32';

      // Authenticated endpoint — safe to include credentials
      res.json({
        endpoints: {
          smith: {
            host: smithHost,
            port: Number(process.env['VNC_SMITH_PORT'] ?? process.env['VNC_ALPHA_PORT'] ?? 6080),
            username: process.env['VNC_SMITH_USERNAME'] ?? process.env['VNC_ALPHA_USERNAME'] ?? '',
            password: process.env['VNC_SMITH_PASSWORD'] ?? process.env['VNC_ALPHA_PASSWORD'] ?? '',
            label: 'Agent Smith (Dev)',
            thunderbolt: tbEnabled && !!(process.env['VNC_SMITH_HOST_THUNDERBOLT'] ?? process.env['VNC_ALPHA_HOST_THUNDERBOLT']),
          },
          johny: {
            host: johnyHost,
            port: Number(process.env['VNC_JOHNY_PORT'] ?? process.env['VNC_BETA_PORT'] ?? 6081),
            username: process.env['VNC_JOHNY_USERNAME'] ?? process.env['VNC_BETA_USERNAME'] ?? '',
            password: process.env['VNC_JOHNY_PASSWORD'] ?? process.env['VNC_BETA_PASSWORD'] ?? '',
            label: 'Agent Johny (Marketing)',
            thunderbolt: tbEnabled && !!(process.env['VNC_JOHNY_HOST_THUNDERBOLT'] ?? process.env['VNC_BETA_HOST_THUNDERBOLT']),
          },
        },
        thunderboltEnabled: tbEnabled,
      });
    });

    // ── VNC file transfer: upload file → SCP to remote machine ──────────
    this.app.post('/api/vnc/upload', async (req, res) => {
      try {
        const target = req.query['target'] as string; // 'smith' or 'johny'
        const filename = req.query['filename'] as string;
        if (!target || !filename) {
          res.status(400).json({ error: 'Missing target or filename' });
          return;
        }

        // Resolve SSH target
        const sshKey = resolve(process.env['HOME'] ?? '/Users/kamilpadula', '.ssh/id_ed25519_jarvis');
        let sshUser: string;
        let sshHost: string;
        if (target === 'smith') {
          sshHost = process.env['SMITH_IP'] ?? process.env['ALPHA_IP'] ?? '192.168.1.37';
          sshUser = process.env['SMITH_USER'] ?? process.env['ALPHA_USER'] ?? 'agent_smith';
        } else if (target === 'johny') {
          sshHost = process.env['JOHNY_IP'] ?? process.env['BETA_IP'] ?? '192.168.1.32';
          sshUser = process.env['JOHNY_USER'] ?? process.env['BETA_USER'] ?? 'agent_johny';
        } else {
          res.status(400).json({ error: 'Invalid target (use smith or johny)' });
          return;
        }

        // Sanitize filename
        const safeName = filename.replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 255);
        if (!safeName) {
          res.status(400).json({ error: 'Invalid filename' });
          return;
        }

        // Collect raw body (file bytes)
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          // 500MB limit
          const total = chunks.reduce((a, b) => a + b.length, 0);
          if (total > 500 * 1024 * 1024) {
            res.status(413).json({ error: 'File too large (max 500MB)' });
            return;
          }
        }
        const fileBuffer = Buffer.concat(chunks);

        // Write to temp file
        const tmpDir = '/tmp/jarvis-vnc-upload';
        if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
        const tmpPath = join(tmpDir, `${Date.now()}-${safeName}`);
        writeFileSync(tmpPath, fileBuffer);

        // SCP to remote Desktop
        const remotePath = `/Users/${sshUser}/Desktop/${safeName}`;
        await execFileAsync('scp', [
          '-i', sshKey,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=10',
          tmpPath,
          `${sshUser}@${sshHost}:${remotePath}`,
        ]);

        // Cleanup temp
        try { unlinkSync(tmpPath); } catch { /* ignore */ }

        log.info(`VNC file transfer: ${safeName} (${(fileBuffer.length / 1024).toFixed(1)}KB) → ${target} (${sshHost}:${remotePath})`);
        res.json({ ok: true, path: remotePath, size: fileBuffer.length });
      } catch (err) {
        log.error('VNC file transfer failed', { error: String(err) });
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // ── VNC clipboard: push text to remote via pbcopy over SSH ──────────
    this.app.post('/api/vnc/clipboard', async (req, res) => {
      try {
        const target = req.query['target'] as string;
        if (!target) {
          res.status(400).json({ error: 'Missing target' });
          return;
        }

        const sshKey = resolve(process.env['HOME'] ?? '/Users/kamilpadula', '.ssh/id_ed25519_jarvis');
        let sshUser: string;
        let sshHost: string;
        if (target === 'smith') {
          sshHost = process.env['SMITH_IP'] ?? process.env['ALPHA_IP'] ?? '192.168.1.37';
          sshUser = process.env['SMITH_USER'] ?? process.env['ALPHA_USER'] ?? 'agent_smith';
        } else if (target === 'johny') {
          sshHost = process.env['JOHNY_IP'] ?? process.env['BETA_IP'] ?? '192.168.1.32';
          sshUser = process.env['JOHNY_USER'] ?? process.env['BETA_USER'] ?? 'agent_johny';
        } else {
          res.status(400).json({ error: 'Invalid target (use smith or johny)' });
          return;
        }

        // Read text body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const text = Buffer.concat(chunks).toString('utf-8').slice(0, 100_000);

        // Push to remote clipboard via SSH + pbcopy (macOS)
        const child = spawn('ssh', [
          '-i', sshKey,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=5',
          `${sshUser}@${sshHost}`,
          'pbcopy',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin.write(text);
        child.stdin.end();

        await new Promise<void>((ok, fail) => {
          child.on('close', (code) => code === 0 ? ok() : fail(new Error(`pbcopy exit ${code}`)));
          child.on('error', fail);
        });

        res.json({ ok: true });
      } catch (err) {
        log.error('VNC clipboard push failed', { error: String(err) });
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // ── VNC clipboard: read from remote via pbpaste over SSH ──────────
    this.app.get('/api/vnc/clipboard', async (req, res) => {
      try {
        const target = req.query['target'] as string;
        if (!target) {
          res.status(400).json({ error: 'Missing target' });
          return;
        }

        const sshKey = resolve(process.env['HOME'] ?? '/Users/kamilpadula', '.ssh/id_ed25519_jarvis');
        let sshUser: string;
        let sshHost: string;
        if (target === 'smith') {
          sshHost = process.env['SMITH_IP'] ?? process.env['ALPHA_IP'] ?? '192.168.1.37';
          sshUser = process.env['SMITH_USER'] ?? process.env['ALPHA_USER'] ?? 'agent_smith';
        } else if (target === 'johny') {
          sshHost = process.env['JOHNY_IP'] ?? process.env['BETA_IP'] ?? '192.168.1.32';
          sshUser = process.env['JOHNY_USER'] ?? process.env['BETA_USER'] ?? 'agent_johny';
        } else {
          res.status(400).json({ error: 'Invalid target (use smith or johny)' });
          return;
        }

        const { stdout } = await execFileAsync('ssh', [
          '-i', sshKey,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=5',
          `${sshUser}@${sshHost}`,
          'pbpaste',
        ]);

        res.json({ text: stdout.slice(0, 100_000) });
      } catch (err) {
        log.error('VNC clipboard read failed', { error: String(err) });
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Network config (read from NAS config/network.json)
    this.app.get('/api/config', (_req, res) => {
      try {
        const configPath = this.nas.resolve('config', 'network.json');
        if (existsSync(configPath)) {
          const data = JSON.parse(readFileSync(configPath, 'utf-8'));
          res.json(data);
        } else {
          // Return basic config from env
          res.json({
            master: {
              ip: process.env['MASTER_IP'] ?? '',
              hostname: hostname(),
              ports: {
                gateway: Number(process.env['JARVIS_PORT'] ?? 18900),
                dashboard: Number(process.env['DASHBOARD_PORT'] ?? 3000),
                nats: 4222,
                redis: 6379,
              },
            },
            agents: {
              smith: { ip: process.env['SMITH_IP'] ?? process.env['ALPHA_IP'] ?? '', user: process.env['SMITH_USER'] ?? process.env['ALPHA_USER'] ?? '', role: 'dev', vnc_port: 6080 },
              johny: { ip: process.env['JOHNY_IP'] ?? process.env['BETA_IP'] ?? '', user: process.env['JOHNY_USER'] ?? process.env['BETA_USER'] ?? '', role: 'marketing', vnc_port: 6081 },
            },
            nas: {
              ip: process.env['NAS_IP'] ?? '',
              share: '',
              mount: process.env['JARVIS_NAS_MOUNT'] ?? '',
            },
            thunderbolt: {
              enabled: process.env['THUNDERBOLT_ENABLED'] === 'true',
              master_ip: process.env['MASTER_IP_THUNDERBOLT'] ?? '',
              smith_ip: process.env['SMITH_IP_THUNDERBOLT'] ?? process.env['ALPHA_IP_THUNDERBOLT'] ?? '',
              johny_ip: process.env['JOHNY_IP_THUNDERBOLT'] ?? process.env['BETA_IP_THUNDERBOLT'] ?? '',
              nats_url: process.env['NATS_URL_THUNDERBOLT'] ?? '',
            },
          });
        }
      } catch (err) {
        log.error('Failed to load config', { error: String(err) });
        res.status(500).json({ error: 'Failed to load configuration' });
      }
    });

    this.app.post('/api/config', (req, res) => {
      try {
        const configPath = this.nas.resolve('config', 'network.json');
        let data: Record<string, unknown> = {};
        if (existsSync(configPath)) {
          data = JSON.parse(readFileSync(configPath, 'utf-8'));
        }

        const body = req.body as Record<string, unknown>;
        const section = body.section as string;

        if (section === 'agents') {
          const agents = (data.agents ?? {}) as Record<string, Record<string, unknown>>;
          if (body.smithIp) { agents.smith = { ...agents.smith, ip: body.smithIp }; }
          if (body.johnyIp) { agents.johny = { ...agents.johny, ip: body.johnyIp }; }
          data.agents = agents;
        } else if (section === 'nas') {
          data.nas = {
            ip: body.nasIp ?? '',
            share: body.nasShare ?? '',
            mount: body.nasMount ?? '',
          };
        } else if (section === 'thunderbolt') {
          data.thunderbolt = {
            enabled: body.enabled ?? false,
            master_ip: body.masterIp ?? '169.254.100.1',
            smith_ip: body.smithIp ?? '169.254.100.2',
            johny_ip: body.johnyIp ?? '169.254.100.3',
            nats_port: body.natsPort ?? 4223,
          };
        }

        data.updated = new Date().toISOString();
        writeFileSync(configPath, JSON.stringify(data, null, 2));
        res.json({ success: true });
      } catch (err) {
        log.error('Failed to save config', { error: String(err) });
        res.status(500).json({ error: 'Failed to save configuration' });
      }
    });

    // Serve dashboard static files (production build)
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const dashboardDist = resolve(__dirname, '../../dashboard/dist');
    if (existsSync(dashboardDist)) {
      this.app.use(express.static(dashboardDist));
      // SPA fallback - serve index.html for all non-API routes
      this.app.use((req, res, next) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/ws') || req.path.includes('.')) {
          next();
          return;
        }
        res.sendFile(resolve(dashboardDist, 'index.html'));
      });
      log.info(`Serving dashboard from ${dashboardDist}`);
    }
  }

  // --- WebSocket ---

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      const token = AuthManager.extractToken(req.url ?? '');
      const ip = req.socket.remoteAddress || 'unknown';

      const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

      // Check if IP is blocked (skip for loopback — dashboard reconnects cause false positives)
      if (!isLoopback && getAuditLogger().isBlocked(ip)) {
        ws.close(4029, 'Too many failed attempts');
        return;
      }

      // ALWAYS require a valid token — no bypass
      if (!token || !this.auth.verifyDashboardToken(token)) {
        getAuditLogger().logEvent('auth.failure', 'gateway:ws', { ip, hasToken: !!token }, ip);
        if (!isLoopback) {
          getAuditLogger().trackFailedAuth(ip);
        }
        log.warn(`WebSocket auth rejected from ${ip}`);
        ws.close(4001, 'Unauthorized');
        return;
      }

      getAuditLogger().logEvent('auth.success', 'gateway:ws', { ip }, ip);
      getAuditLogger().clearFailedAuth(ip);

      const clientId = shortId();
      this.protocol.registerClient(clientId, ws);
      log.info(`Dashboard client connected: ${clientId} from ${ip}`);

      ws.on('message', async (data) => {
        // Rate limit WebSocket messages
        if (!wsRateLimiter.allow(clientId)) {
          getAuditLogger().logEvent('rate_limit.exceeded', 'gateway:ws', { clientId, ip });
          const errMsg = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded' } });
          ws.send(errMsg);
          return;
        }
        await this.protocol.handleMessage(clientId, data.toString());
      });

      ws.on('close', () => {
        this.protocol.removeClient(clientId);
        log.info(`Dashboard client disconnected: ${clientId}`);
      });

      ws.on('error', (err) => {
        log.error(`WebSocket error for ${clientId}`, { error: String(err) });
      });

      // Send initial state
      void this.sendInitialState(clientId);
    });
  }

  // --- Gateway Methods ---

  private registerMethods(): void {
    this.protocol.registerMethod('ping', async () => {
      return { pong: true, timestamp: Date.now() };
    });

    this.protocol.registerMethod('health', async () => {
      return this.getHealthStatus();
    });

    this.protocol.registerMethod('health.detailed', async () => {
      return this.getHealthStatus();
    });

    this.protocol.registerMethod('agents.list', async () => {
      return this.store.getAllAgentStates();
    });

    this.protocol.registerMethod('agents.status', async (params) => {
      const { agentId } = params as { agentId: string };
      return this.store.getAgentState(agentId);
    });

    this.protocol.registerMethod('agents.capabilities', async (params) => {
      const { agentId } = params as { agentId: string };
      return this.store.getCapabilities(agentId);
    });

    this.protocol.registerMethod('tasks.list', async () => {
      return this.store.getAllTasks();
    });

    this.protocol.registerMethod('tasks.create', async (params) => {
      if (typeof (params as Record<string, unknown>)?.title !== 'string' || !(params as Record<string, unknown>).title) {
        throw new Error('Invalid task.create params: title must be a non-empty string');
      }
      const task = params as TaskDefinition;
      task.id = task.id || shortId();
      task.status = task.status || 'pending';
      task.createdAt = Date.now();
      task.updatedAt = Date.now();
      await this.store.createTask(task);

      // Broadcast to dashboard
      this.protocol.broadcast('task.created', task);

      // Assign to appropriate agent based on capabilities
      await this.assignTask(task);

      return { taskId: task.id };
    });

    this.protocol.registerMethod('tasks.cancel', async (params) => {
      if (typeof (params as Record<string, unknown>)?.taskId !== 'string') {
        throw new Error('Invalid tasks.cancel params: taskId must be a string');
      }
      const { taskId } = params as { taskId: string };
      await this.store.updateTask(taskId, { assignedAgent: null, status: 'cancelled' });
      this.protocol.broadcast('task.cancelled', { taskId });
      return { success: true };
    });

    this.protocol.registerMethod('tasks.status', async (params) => {
      const { taskId } = params as { taskId: string };
      const task = await this.store.getTask(taskId);
      const result = await this.store.getTaskResult(taskId);
      return { task, result };
    });

    this.protocol.registerMethod('chat.send', async (params) => {
      // Validate input with Zod schema
      const parsed = chatSendSchema.safeParse(params);
      if (!parsed.success) {
        const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
        throw new Error(`Invalid chat message: ${issues}`);
      }

      const msg = parsed.data as ChatMessage;
      msg.id = msg.id || shortId();
      msg.timestamp = Date.now();

      // Sanitize HTML from content
      if (typeof msg.content === 'string') {
        msg.content = stripHtml(msg.content);
      }

      // Persist message to NAS
      const sessionId = (msg as Record<string, unknown>).sessionId as string || 'default';
      this.persistChatMessage(sessionId, msg);

      // Route to the appropriate agent via NATS
      // Default to jarvis (orchestrator) if no specific target or 'all'
      let target = (!msg.to || msg.to === 'all') ? 'jarvis' : msg.to;

      // Smart routing: check if target agent is online, if not find an available agent
      const targetState = await this.store.getAgentState(target);
      const isOnline = targetState && targetState.status !== 'offline' &&
        (Date.now() - targetState.lastHeartbeat) < HEARTBEAT_TIMEOUT;

      if (!isOnline) {
        log.warn(`Chat target '${target}' is offline, searching for available agent...`);
        const allStates = await this.store.getAllAgentStates();
        const available = allStates.find(s =>
          s.status !== 'offline' &&
          (Date.now() - s.lastHeartbeat) < HEARTBEAT_TIMEOUT
        );
        if (available) {
          target = available.identity.agentId;
          log.info(`Chat rerouted to available agent: ${target}`);
        } else {
          log.error(`No online agents available to handle chat message`);
          // Still publish to original target — it will be picked up when agent comes online
          // Also send error feedback to dashboard
          this.protocol.broadcast('chat.message', {
            id: shortId(),
            from: 'system',
            to: 'user',
            content: 'No agents are currently online. Start an agent first: ./jarvis.sh agents-start',
            timestamp: Date.now(),
          });
        }
      }

      log.info(`Chat from '${msg.from}' → '${target}': ${(msg.content as string).slice(0, 80)}`);
      await this.nats.publish(NatsSubjects.chat(target), msg);

      // Broadcast to dashboard for display
      this.protocol.broadcast('chat.message', msg);
      return { messageId: msg.id };
    });

    this.protocol.registerMethod('chat.history', async (params) => {
      const { sessionId = 'default', limit = 200 } = params as { sessionId?: string; limit?: number };
      // Cap limit to a safe upper bound
      const cappedLimit = Math.min(Math.max(1, limit), 2000);
      return { messages: this.getChatHistory(sessionId, cappedLimit) };
    });

    this.protocol.registerMethod('chat.sessions', async () => {
      return { sessions: this.getChatSessions() };
    });

    this.protocol.registerMethod('chat.session.delete', async (params) => {
      const { sessionId } = params as { sessionId: string };
      return this.deleteChatSession(sessionId);
    });

    this.protocol.registerMethod('chat.abort', async (params) => {
      const { sessionId } = params as { sessionId: string };
      // Broadcast abort to all agents
      for (const id of knownAgents) {
        await this.nats.publish(NatsSubjects.chat(id), { type: 'abort', sessionId });
      }
      return { success: true };
    });

    this.protocol.registerMethod('vnc.info', async () => {
      const tbEnabled = process.env['THUNDERBOLT_ENABLED'] === 'true';
      return {
        smith: {
          host: (tbEnabled && process.env['VNC_SMITH_HOST_THUNDERBOLT'])
            ? process.env['VNC_SMITH_HOST_THUNDERBOLT']
            : process.env['VNC_SMITH_HOST'] ?? process.env['VNC_ALPHA_HOST'] ?? '192.168.1.37',
          port: Number(process.env['VNC_SMITH_PORT'] ?? process.env['VNC_ALPHA_PORT'] ?? 6080),
          label: 'Agent Smith (Dev)',
          thunderbolt: tbEnabled && !!(process.env['VNC_SMITH_HOST_THUNDERBOLT'] ?? process.env['VNC_ALPHA_HOST_THUNDERBOLT']),
        },
        johny: {
          host: (tbEnabled && process.env['VNC_JOHNY_HOST_THUNDERBOLT'])
            ? process.env['VNC_JOHNY_HOST_THUNDERBOLT']
            : process.env['VNC_JOHNY_HOST'] ?? process.env['VNC_BETA_HOST'] ?? '192.168.1.32',
          port: Number(process.env['VNC_JOHNY_PORT'] ?? process.env['VNC_BETA_PORT'] ?? 6081),
          label: 'Agent Johny (Marketing)',
          thunderbolt: tbEnabled && !!(process.env['VNC_JOHNY_HOST_THUNDERBOLT'] ?? process.env['VNC_BETA_HOST_THUNDERBOLT']),
        },
        thunderboltEnabled: tbEnabled,
      };
    });

    this.protocol.registerMethod('config.get', async () => {
      // Never expose authToken or sensitive connection strings to the dashboard
      const { authToken, ...safeConfig } = this.config;
      return safeConfig;
    });

    this.protocol.registerMethod('config.set', async (params) => {
      const { agentId, tools, skills, config: agentConfig } = params as {
        agentId?: string; tools?: Record<string, boolean>;
        skills?: Record<string, boolean>; config?: Record<string, string>;
      };
      if (!agentId) return { success: false, message: 'agentId required' };

      const configPath = this.nas.resolve('config', `agent-${agentId}.json`);
      let existing: Record<string, unknown> = {};
      try {
        if (existsSync(configPath)) {
          existing = JSON.parse(readFileSync(configPath, 'utf-8'));
        }
      } catch { /* ignore */ }

      const updated = {
        ...existing,
        ...(tools && { tools }),
        ...(skills && { skills }),
        ...(agentConfig && { config: agentConfig }),
        updatedAt: new Date().toISOString(),
      };

      try {
        const configDir = this.nas.resolve('config');
        if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
        writeFileSync(configPath, JSON.stringify(updated, null, 2));
        log.info(`Agent config saved for ${agentId}`);
        return { success: true };
      } catch (err) {
        log.error(`Failed to save agent config: ${(err as Error).message}`);
        return { success: false, message: 'Failed to save agent configuration' };
      }
    });

    this.protocol.registerMethod('config.agent.get', async (params) => {
      const { agentId } = params as { agentId: string };
      if (!agentId) return {};
      const configPath = this.nas.resolve('config', `agent-${agentId}.json`);
      try {
        if (existsSync(configPath)) {
          return JSON.parse(readFileSync(configPath, 'utf-8'));
        }
      } catch { /* ignore */ }
      return {};
    });

    this.protocol.registerMethod('metrics.usage', async () => {
      const agents = await this.store.getAllAgentStates();
      const sessionsDir = this.nas.resolve('sessions');
      let totalSessions = 0;
      let totalMessages = 0;

      // Count sessions and messages from NAS
      try {
        if (existsSync(sessionsDir)) {
          const agentDirs = readdirSync(sessionsDir);
          for (const dir of agentDirs) {
            const agentPath = join(sessionsDir, dir);
            if (statSync(agentPath).isDirectory()) {
              const files = readdirSync(agentPath).filter((f) => f.endsWith('.jsonl'));
              totalSessions += files.length;
              for (const f of files) {
                try {
                  const content = readFileSync(join(agentPath, f), 'utf-8');
                  totalMessages += content.split('\n').filter(Boolean).length;
                } catch { /* skip corrupt files */ }
              }
            }
          }
        }
      } catch { /* non-critical */ }

      // Count chat messages
      let chatMessages = 0;
      try {
        const chatDir = this.nas.resolve('chat');
        if (existsSync(chatDir)) {
          const files = readdirSync(chatDir).filter((f) => f.endsWith('.jsonl'));
          for (const f of files) {
            try {
              const content = readFileSync(join(chatDir, f), 'utf-8');
              chatMessages += content.split('\n').filter(Boolean).length;
            } catch { /* skip */ }
          }
        }
      } catch { /* non-critical */ }

      return {
        agents,
        totalSessions,
        totalMessages,
        chatMessages,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
      };
    });

    this.protocol.registerMethod('metrics.costs', async () => {
      // Aggregate costs from session files (if they contain token/cost info)
      const sessionsDir = this.nas.resolve('sessions');
      let totalTokens = 0;
      let totalCost = 0;
      const byAgent: Record<string, { tokens: number; cost: number; sessions: number }> = {};

      try {
        if (existsSync(sessionsDir)) {
          const agentDirs = readdirSync(sessionsDir);
          for (const dir of agentDirs) {
            const agentPath = join(sessionsDir, dir);
            if (statSync(agentPath).isDirectory()) {
              const files = readdirSync(agentPath).filter((f) => f.endsWith('.jsonl'));
              if (!byAgent[dir]) byAgent[dir] = { tokens: 0, cost: 0, sessions: files.length };
              else byAgent[dir].sessions = files.length;

              for (const f of files) {
                try {
                  const content = readFileSync(join(agentPath, f), 'utf-8');
                  const lines = content.split('\n').filter(Boolean);
                  for (const line of lines) {
                    try {
                      const entry = JSON.parse(line);
                      if (entry.usage?.totalTokens) {
                        const tokens = entry.usage.totalTokens as number;
                        totalTokens += tokens;
                        byAgent[dir].tokens += tokens;
                        // Estimate cost: ~$3/M input + $15/M output for Claude Sonnet
                        const estimatedCost = tokens * 0.000009;
                        totalCost += estimatedCost;
                        byAgent[dir].cost += estimatedCost;
                      }
                    } catch { /* skip */ }
                  }
                } catch { /* skip */ }
              }
            }
          }
        }
      } catch { /* non-critical */ }

      return {
        totalCost: Math.round(totalCost * 100) / 100,
        totalTokens,
        byAgent,
        currency: 'USD',
        note: 'Estimated based on token counts',
      };
    });

    // --- Sessions ---

    this.protocol.registerMethod('sessions.list', async () => {
      return this.listSessions();
    });

    this.protocol.registerMethod('sessions.get', async (params) => {
      const { sessionId } = params as { sessionId: string };
      return this.getSessionDetail(sessionId);
    });

    // --- Usage ---

    this.protocol.registerMethod('usage.summary', async () => {
      return this.getUsageSummary();
    });

    this.protocol.registerMethod('usage.sessions', async () => {
      return this.getSessionUsageList();
    });

    // --- Logs ---

    this.protocol.registerMethod('logs.get', async (params) => {
      const { lines } = (params ?? {}) as { lines?: number };
      return this.getLogLines(lines ?? 200);
    });

    // --- Orchestrator ---

    this.protocol.registerMethod('orchestrator.graph', async () => {
      return this.orchestrator.getGraphState();
    });

    this.protocol.registerMethod('orchestrator.ready', async () => {
      return this.orchestrator.getReadyTasks();
    });

    // --- Integrations ---

    this.protocol.registerMethod('integrations.status', async () => {
      // Count cron jobs from NAS
      let cronJobCount = 0;
      try {
        const cronDir = this.nas.resolve('cron-jobs');
        if (existsSync(cronDir)) {
          cronJobCount = readdirSync(cronDir).filter(f => f.endsWith('.json')).length;
        }
      } catch { /* ignore */ }

      // Count workflows from NAS
      let workflowCount = 0;
      try {
        const wfDir = this.nas.resolve('workflows');
        if (existsSync(wfDir)) {
          workflowCount = readdirSync(wfDir).filter(f => f.endsWith('.json')).length;
        }
      } catch { /* ignore */ }

      return {
        imessage: {
          available: process.platform === 'darwin',
          platform: process.platform,
        },
        spotify: {
          available: process.platform === 'darwin' || !!process.env['SPOTIFY_ACCESS_TOKEN'],
          hasApi: !!process.env['SPOTIFY_ACCESS_TOKEN'],
          mode: process.env['SPOTIFY_ACCESS_TOKEN'] ? 'api' : 'local',
        },
        homeAssistant: {
          available: !!(process.env['HASS_URL'] && process.env['HASS_TOKEN']),
          url: process.env['HASS_URL'] ?? undefined,
        },
        cron: {
          available: true,
          jobCount: cronJobCount,
        },
        calendar: {
          available: process.platform === 'darwin',
          platform: process.platform,
        },
        workflows: {
          available: true,
          count: workflowCount,
        },
      };
    });

    // --- Workflows ---

    this.protocol.registerMethod('workflows.list', async () => {
      return this.listWorkflows();
    });

    this.protocol.registerMethod('workflows.get', async (params) => {
      const { workflowId } = params as { workflowId: string };
      return this.getWorkflow(workflowId);
    });

    this.protocol.registerMethod('workflows.runs', async () => {
      return this.listWorkflowRuns();
    });

    // --- System Metrics ---

    this.protocol.registerMethod('system.metrics', async () => {
      return this.getSystemMetrics();
    });

    this.protocol.registerMethod('system.processes', async () => {
      return this.getTopProcesses();
    });

    // --- Notifications Config ---

    this.protocol.registerMethod('notifications.config.get', async () => {
      return this.getNotificationsConfig();
    });

    this.protocol.registerMethod('notifications.config.set', async (params) => {
      return this.setNotificationsConfig(params as Record<string, unknown>);
    });

    this.protocol.registerMethod('notifications.test', async () => {
      // Trigger macOS native test notification
      try {
        execSync(`osascript -e 'display notification "Test from Jarvis Dashboard" with title "🔔 Jarvis Test" sound name "Glass"'`, { timeout: 5000 });
        return { success: true, message: 'Test notification sent' };
      } catch {
        return { success: false, message: 'Failed to send test notification' };
      }
    });

    // --- API Keys ---

    this.protocol.registerMethod('apikeys.list', async () => {
      return this.getApiKeys();
    });

    this.protocol.registerMethod('apikeys.add', async (params) => {
      return this.addApiKey(params as { name: string; provider: string; key: string });
    });

    this.protocol.registerMethod('apikeys.delete', async (params) => {
      return this.deleteApiKey((params as { id: string }).id);
    });

    this.protocol.registerMethod('apikeys.validate', async (params) => {
      return this.validateApiKey(params as { id: string; key: string });
    });

    // --- Scheduler / Cron ---

    this.protocol.registerMethod('scheduler.list', async () => {
      return this.listScheduledJobs();
    });

    this.protocol.registerMethod('scheduler.jobs', async () => {
      return { jobs: this.listScheduledJobs() };
    });

    this.protocol.registerMethod('scheduler.history', async () => {
      return this.getSchedulerHistory();
    });

    this.protocol.registerMethod('scheduler.create', async (params) => {
      return this.createScheduledJob(params as Record<string, unknown>);
    });

    this.protocol.registerMethod('scheduler.delete', async (params) => {
      return this.deleteScheduledJob((params as { id: string }).id);
    });

    this.protocol.registerMethod('scheduler.enable', async (params) => {
      return this.toggleScheduledJob((params as { id: string }).id, true);
    });

    this.protocol.registerMethod('scheduler.disable', async (params) => {
      return this.toggleScheduledJob((params as { id: string }).id, false);
    });

    this.protocol.registerMethod('scheduler.run_now', async (params) => {
      return this.runJobNow((params as { id: string }).id);
    });

    // --- Environment Variables ---

    this.protocol.registerMethod('environment.list', async () => {
      return this.getEnvironmentVars();
    });

    this.protocol.registerMethod('environment.set', async (params) => {
      const p = params as Record<string, unknown>;
      if (typeof p?.key !== 'string' || !p.key || typeof p?.value !== 'string') {
        throw new Error('Invalid environment.set params: key and value must be strings');
      }
      const { key, value } = p as { key: string; value: string };
      return this.setEnvironmentVar(key, value);
    });

    this.protocol.registerMethod('environment.delete', async (params) => {
      const p = params as Record<string, unknown>;
      if (typeof p?.key !== 'string' || !p.key) {
        throw new Error('Invalid environment.delete params: key must be a non-empty string');
      }
      const { key } = p as { key: string };
      return this.deleteEnvironmentVar(key);
    });

    // --- Timeline ---

    this.protocol.registerMethod('timeline.list', async () => {
      return this.getTimelines();
    });

    this.protocol.registerMethod('timeline.recent', async () => {
      return this.getRecentTimeline();
    });

    // --- Plugins ---

    this.protocol.registerMethod('plugins.list', async () => {
      return this.getPluginsList();
    });

    // --- Skills ---

    this.protocol.registerMethod('skills.list', async () => {
      return this.getSkillsList();
    });

    this.protocol.registerMethod('skills.toggle', async (params) => {
      const { skillId } = params as { skillId: string };
      return this.toggleSkill(skillId);
    });

    this.protocol.registerMethod('skills.install', async (params) => {
      const { skillId } = params as { skillId: string };
      return this.installSkill(skillId);
    });

    // --- Model Providers ---

    this.protocol.registerMethod('providers.config.get', async () => {
      return this.getProvidersConfig();
    });

    this.protocol.registerMethod('providers.config.set', async (params) => {
      return this.setProvidersConfig(params as Record<string, unknown>);
    });

    // --- Voice ---

    this.protocol.registerMethod('voice.process', async (params) => {
      return this.processVoiceMessage(params as { message: string; language: string });
    });

    this.protocol.registerMethod('voice.settings', async () => {
      return this.getVoiceSettings();
    });

    // --- File Manager ---

    this.protocol.registerMethod('files.list', async (params) => {
      const { path } = params as { path: string };
      return this.listFiles(path);
    });

    this.protocol.registerMethod('files.read', async (params) => {
      const { path } = params as { path: string };
      return this.readFile(path);
    });

    // --- WhatsApp (Baileys QR Login) ---

    this.protocol.registerMethod('whatsapp.status', async () => {
      return this.getWhatsAppStatus();
    });

    this.protocol.registerMethod('whatsapp.login.start', async (params) => {
      const { force } = (params ?? {}) as { force?: boolean };
      return this.startWhatsAppLogin(force ?? false);
    });

    this.protocol.registerMethod('whatsapp.login.wait', async () => {
      return this.waitWhatsAppLogin();
    });

    this.protocol.registerMethod('whatsapp.logout', async () => {
      return this.logoutWhatsApp();
    });

    this.protocol.registerMethod('whatsapp.connect', async () => {
      await this.connectWhatsApp();
      return this.getWhatsAppStatus();
    });

    this.protocol.registerMethod('whatsapp.config.get', async () => {
      return this.getChannelConfig('whatsapp');
    });

    this.protocol.registerMethod('whatsapp.config.set', async (params) => {
      return this.setChannelConfig('whatsapp', params as Record<string, unknown>);
    });

    this.protocol.registerMethod('whatsapp.send', async (params) => {
      return this.sendWhatsAppMessage(params as { to: string; message: string });
    });

    this.protocol.registerMethod('whatsapp.messages', async (params) => {
      const { limit } = (params ?? {}) as { limit?: number };
      return this.getChannelMessages('whatsapp', limit ?? 200);
    });

    // --- Telegram ---

    this.protocol.registerMethod('telegram.status', async () => {
      return this.getTelegramStatus();
    });

    this.protocol.registerMethod('telegram.config.get', async () => {
      return this.getChannelConfig('telegram');
    });

    this.protocol.registerMethod('telegram.config.set', async (params) => {
      return this.setChannelConfig('telegram', params as Record<string, unknown>);
    });

    this.protocol.registerMethod('telegram.send', async (params) => {
      return this.sendTelegramMessage(params as { chatId: string; message: string });
    });

    this.protocol.registerMethod('telegram.messages', async (params) => {
      const { limit } = (params ?? {}) as { limit?: number };
      return this.getChannelMessages('telegram', limit ?? 200);
    });

    // --- Discord ---

    this.protocol.registerMethod('discord.status', async () => {
      return this.getDiscordStatus();
    });

    this.protocol.registerMethod('discord.config.get', async () => {
      return this.getChannelConfig('discord');
    });

    this.protocol.registerMethod('discord.config.set', async (params) => {
      return this.setChannelConfig('discord', params as Record<string, unknown>);
    });

    this.protocol.registerMethod('discord.send', async (params) => {
      return this.sendDiscordMessage(params as { channelId: string; message: string });
    });

    this.protocol.registerMethod('discord.messages', async (params) => {
      const { limit } = (params ?? {}) as { limit?: number };
      return this.getChannelMessages('discord', limit ?? 200);
    });

    // --- Slack ---

    this.protocol.registerMethod('slack.status', async () => {
      return this.getSlackStatus();
    });

    this.protocol.registerMethod('slack.config.get', async () => {
      return this.getChannelConfig('slack');
    });

    this.protocol.registerMethod('slack.config.set', async (params) => {
      return this.setChannelConfig('slack', params as Record<string, unknown>);
    });

    this.protocol.registerMethod('slack.connect', async () => {
      const config = this.getChannelConfig('slack') as Record<string, unknown>;
      const botToken = config.botToken as string;
      if (!botToken) {
        return { success: false, error: 'Bot token not configured' };
      }
      const mode = (config.mode as string) ?? 'socket';
      if (mode === 'socket') {
        const appToken = config.appToken as string;
        if (!appToken) {
          return { success: false, error: 'App token not configured (required for Socket Mode)' };
        }
        try {
          await this.connectSlackSocketMode(botToken, appToken);
          return { success: true, message: 'Slack Socket Mode connected' };
        } catch (err) {
          return { success: false, error: (err as Error).message };
        }
      } else {
        // HTTP mode — validate config and return webhook URL
        if (!config.signingSecret) {
          return { success: false, error: 'Signing secret not configured (required for HTTP mode)' };
        }
        return {
          success: true,
          message: 'Slack HTTP mode ready',
          webhookUrl: `/api/slack/events`,
        };
      }
    });

    this.protocol.registerMethod('slack.disconnect', async () => {
      this.disconnectSlackSocketMode();
      return { success: true, message: 'Slack disconnected' };
    });

    this.protocol.registerMethod('slack.send', async (params) => {
      const { channel, message } = params as { channel: string; message: string };
      return this.sendSlackMessage(channel, message);
    });

    this.protocol.registerMethod('slack.messages', async (params) => {
      const { limit } = (params ?? {}) as { limit?: number };
      return this.getChannelMessages('slack', limit ?? 200);
    });

    // --- iMessage ---

    this.protocol.registerMethod('imessage.status', async () => {
      return {
        available: process.platform === 'darwin',
        platform: process.platform,
        connected: process.platform === 'darwin',
      };
    });

    this.protocol.registerMethod('imessage.config.get', async () => {
      return this.getChannelConfig('imessage');
    });

    this.protocol.registerMethod('imessage.config.set', async (params) => {
      return this.setChannelConfig('imessage', params as Record<string, unknown>);
    });

    this.protocol.registerMethod('imessage.send', async (params) => {
      const { to, message } = params as { to: string; message: string };
      return this.sendIMessage(to, message);
    });

    this.protocol.registerMethod('imessage.messages', async (params) => {
      const { limit } = (params ?? {}) as { limit?: number };
      return this.getChannelMessages('imessage', limit ?? 200);
    });

    this.protocol.registerMethod('imessage.conversations', async (params) => {
      const { limit } = (params ?? {}) as { limit?: number };
      return this.getIMessageConversations(limit ?? 50);
    });

    this.protocol.registerMethod('imessage.conversation', async (params) => {
      const { chatId, limit } = params as { chatId: string; limit?: number };
      return this.getIMessageConversation(chatId, limit ?? 50);
    });

    this.protocol.registerMethod('imessage.search', async (params) => {
      const { query, limit } = params as { query: string; limit?: number };
      return this.searchIMessages(query, limit ?? 30);
    });

    this.protocol.registerMethod('imessage.contacts', async () => {
      return this.getIMessageContacts();
    });

    // --- Channels (unified) ---

    this.protocol.registerMethod('channels.list', async () => {
      return this.listChannels();
    });

    this.protocol.registerMethod('channels.status', async () => {
      return this.getChannelsStatus();
    });

    // --- Memory ---

    this.protocol.registerMethod('memory.status', async () => {
      return this.getMemoryStatus();
    });

    this.protocol.registerMethod('memory.search', async (params) => {
      const { query, maxResults } = (params ?? {}) as { query: string; maxResults?: number };
      return this.searchMemory(query, maxResults ?? 30);
    });

    this.protocol.registerMethod('memory.read', async (params) => {
      const { file } = (params ?? {}) as { file?: string };
      return this.readMemoryFile(file ?? 'MEMORY.md');
    });

    this.protocol.registerMethod('memory.save', async (params) => {
      const { content, category } = params as { content: string; category?: 'core' | 'daily' };
      return this.saveMemory(content, category ?? 'core');
    });

    this.protocol.registerMethod('memory.list', async () => {
      return this.listMemoryFiles();
    });

    this.protocol.registerMethod('memory.delete', async (params) => {
      const { file } = params as { file: string };
      return this.deleteMemoryFile(file);
    });

    this.protocol.registerMethod('memory.entries', async (params) => {
      const { query, limit } = (params ?? {}) as { query?: string; limit?: number };
      return this.getKnowledgeEntries(query, limit ?? 50);
    });

    this.protocol.registerMethod('memory.entry.save', async (params) => {
      const { title, content, tags, source } = params as { title: string; content: string; tags?: string[]; source?: string };
      return this.saveKnowledgeEntry({ title, content, tags: tags ?? [], source: source ?? 'dashboard' });
    });

    this.protocol.registerMethod('memory.entry.delete', async (params) => {
      const { id } = params as { id: string };
      return this.deleteKnowledgeEntry(id);
    });

    // --- Exec Approvals (Human-in-the-loop) ---

    this.protocol.registerMethod('approvals.list', async () => {
      return { approvals: this.pendingApprovals };
    });

    this.protocol.registerMethod('approvals.history', async () => {
      return { history: this.approvalHistory.slice(-100) };
    });

    this.protocol.registerMethod('approvals.approve', async (params) => {
      const { approvalId } = params as { approvalId: string };
      return this.resolveApproval(approvalId, true);
    });

    this.protocol.registerMethod('approvals.deny', async (params) => {
      const { approvalId, reason } = params as { approvalId: string; reason?: string };
      return this.resolveApproval(approvalId, false, reason);
    });

    this.protocol.registerMethod('approvals.config.get', async () => {
      return this.getApprovalConfig();
    });

    this.protocol.registerMethod('approvals.config.set', async (params) => {
      return this.setApprovalConfig(params as Record<string, unknown>);
    });

    // --- OTA Update Methods ---

    this.protocol.registerMethod('system.update.check', async () => {
      return this.checkForUpdates();
    });

    this.protocol.registerMethod('system.update.apply', async () => {
      return this.applyUpdate();
    });

    this.protocol.registerMethod('system.update.status', async () => {
      return this.getUpdateStatus();
    });

    // --- Social Media Methods ---

    this.protocol.registerMethod('social.config', async () => {
      const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
      const env = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
      const has = (key: string) => env.includes(`${key}=`) && !env.includes(`${key}=\n`) && !env.includes(`${key}=\r`);
      return {
        twitter: has('TWITTER_API_KEY') && has('TWITTER_ACCESS_TOKEN'),
        instagram: has('INSTAGRAM_ACCESS_TOKEN'),
        facebook: has('FACEBOOK_PAGE_TOKEN'),
        linkedin: has('LINKEDIN_ACCESS_TOKEN'),
        tiktok: has('TIKTOK_ACCESS_TOKEN'),
      };
    });

    this.protocol.registerMethod('social.config.save', async (params) => {
      const { platform, keys } = params as { platform: string; keys: Record<string, string> };
      if (!platform || !keys || typeof keys !== 'object') throw new Error('platform and keys required');
      const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
      let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
      for (const [key, value] of Object.entries(keys)) {
        // Sanitize key name - only allow alphanumeric and underscores
        const safeKey = key.replace(/[^A-Z0-9_]/gi, '');
        if (!safeKey) continue;
        const regex = new RegExp(`^${safeKey}=.*$`, 'm');
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `${safeKey}=${value}`);
        } else {
          envContent = envContent.trimEnd() + `\n${safeKey}=${value}`;
        }
        // Also set in current process
        process.env[safeKey] = value;
      }
      writeFileSync(envPath, envContent + '\n');
      log.info(`Social config saved for platform: ${platform}`);
      return { success: true, platform };
    });

    this.protocol.registerMethod('social.schedule.list', async () => {
      const schedulePath = this.nas.resolve('config/social-schedule.json');
      if (!existsSync(schedulePath)) return [];
      try {
        return JSON.parse(readFileSync(schedulePath, 'utf-8'));
      } catch { return []; }
    });

    this.protocol.registerMethod('social.schedule', async (params) => {
      const p = params as Record<string, unknown>;
      const schedulePath = this.nas.resolve('config/social-schedule.json');
      const dir = dirname(schedulePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let posts: Record<string, unknown>[] = [];
      if (existsSync(schedulePath)) {
        try { posts = JSON.parse(readFileSync(schedulePath, 'utf-8')); } catch { posts = []; }
      }

      const newPost = {
        id: shortId(),
        platform: p.platform ?? 'twitter',
        action: p.post_type ?? p.action ?? 'post',
        text: p.text ?? '',
        mediaUrl: p.media_url ?? '',
        link: p.link ?? '',
        title: p.title ?? '',
        scheduledAt: p.scheduled_at ? new Date(p.scheduled_at as string).getTime() : Date.now() + 3600000,
        status: 'scheduled',
        createdAt: Date.now(),
      };
      posts.push(newPost);
      writeFileSync(schedulePath, JSON.stringify(posts, null, 2));
      log.info(`Social post scheduled: ${newPost.id} for ${newPost.platform}`);
      return { success: true, post: newPost };
    });

    this.protocol.registerMethod('social.schedule.cancel', async (params) => {
      const { post_id } = params as { post_id: string; action?: string };
      if (!post_id) throw new Error('post_id required');
      const schedulePath = this.nas.resolve('config/social-schedule.json');
      if (!existsSync(schedulePath)) throw new Error('No schedule file found');

      const posts = JSON.parse(readFileSync(schedulePath, 'utf-8')) as Record<string, unknown>[];
      const idx = posts.findIndex((p) => p.id === post_id);
      if (idx === -1) throw new Error('Post not found');
      posts[idx].status = 'cancelled';
      writeFileSync(schedulePath, JSON.stringify(posts, null, 2));
      log.info(`Social post cancelled: ${post_id}`);
      return { success: true };
    });

    this.protocol.registerMethod('social.post', async (params) => {
      const p = params as { platform: string; action?: string; text: string; media_url?: string; link?: string; title?: string };
      if (!p.text) throw new Error('text required');

      // Send to agent-johny via NATS DM for execution
      const task = {
        from: 'dashboard',
        type: 'social_post',
        content: `Use the social_post tool to publish on ${p.platform}: "${p.text}"${p.media_url ? ` with media: ${p.media_url}` : ''}`,
        params: p,
        timestamp: Date.now(),
      };

      try {
        await this.nats.publish(NatsSubjects.chat('agent-johny'), {
          id: shortId(),
          from: 'dashboard',
          to: 'agent-johny',
          content: `Execute social media post immediately.\nPlatform: ${p.platform}\nAction: ${p.action ?? 'post'}\nText: ${p.text}${p.media_url ? `\nMedia: ${p.media_url}` : ''}${p.link ? `\nLink: ${p.link}` : ''}`,
          type: 'task',
          timestamp: Date.now(),
        } satisfies ChatMessage);
        log.info(`Social post sent to agent-johny: ${p.platform}`);
        return { success: true, message: 'Post sent to Agent Johny for publishing' };
      } catch (err) {
        log.error('Failed to send social post to agent', { error: String(err) });
        throw new Error(`Failed to dispatch post: ${String(err)}`);
      }
    });

    this.protocol.registerMethod('social.media.browse', async (params) => {
      const { path: dirPath } = params as { path: string };
      if (!dirPath) throw new Error('path required');
      const resolved = resolve(dirPath);
      if (!existsSync(resolved)) throw new Error(`Directory not found: ${dirPath}`);
      const stat = statSync(resolved);
      if (!stat.isDirectory()) throw new Error('Path is not a directory');

      const mediaExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.avi', '.webm', '.heic', '.heif']);
      const entries = readdirSync(resolved);
      const files: { name: string; path: string; size: number; modified: number; type: 'image' | 'video' }[] = [];

      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const fullPath = join(resolved, entry);
        try {
          const s = statSync(fullPath);
          if (!s.isFile()) continue;
          const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
          if (!mediaExtensions.has(ext)) continue;
          const isVideo = ['.mp4', '.mov', '.avi', '.webm'].includes(ext);
          files.push({
            name: entry,
            path: fullPath,
            size: s.size,
            modified: s.mtimeMs,
            type: isVideo ? 'video' : 'image',
          });
        } catch { continue; }
      }

      files.sort((a, b) => b.modified - a.modified);
      return { directory: resolved, files, total: files.length };
    });

    this.protocol.registerMethod('social.autopost', async (params) => {
      const { platform, mediaFolder, prompt: userPrompt } = params as { platform: string; mediaFolder?: string; prompt?: string };
      if (!platform) throw new Error('platform required');

      const taskContent = [
        `Autonomous social media posting task:`,
        `Platform: ${platform}`,
        mediaFolder ? `Media folder: ${mediaFolder} — browse it, pick the best/most visually appealing content.` : '',
        userPrompt ? `Additional instructions: ${userPrompt}` : '',
        `Steps:`,
        `1. ${mediaFolder ? 'Browse the media folder and select the best image/video' : 'Find or create compelling visual content'}`,
        `2. Generate viral, engaging post content with trending hashtags and strong hooks`,
        `3. Publish the post using the social_post tool`,
        `4. Report the result back`,
      ].filter(Boolean).join('\n');

      await this.nats.publish(NatsSubjects.chat('agent-johny'), {
        id: shortId(),
        from: 'dashboard',
        to: 'agent-johny',
        content: taskContent,
        type: 'task',
        timestamp: Date.now(),
      } satisfies ChatMessage);

      log.info(`Auto-post task sent to agent-johny: ${platform}`);
      return { success: true, message: 'Auto-post task dispatched to Agent Johny' };
    });

    // --- Setup Wizard Methods ---

    this.protocol.registerMethod('setup.master.info', async () => {
      const nets = networkInterfaces();
      let masterIp = '127.0.0.1';
      for (const ifaces of Object.values(nets)) {
        if (!ifaces) continue;
        for (const iface of ifaces) {
          if (iface.family === 'IPv4' && !iface.internal) {
            masterIp = iface.address;
            break;
          }
        }
        if (masterIp !== '127.0.0.1') break;
      }

      return {
        hostname: hostname(),
        ip: masterIp,
        natsPort: parseInt(new URL(this.config.natsUrl).port) || 4222,
        redisPort: parseInt(new URL(this.config.redisUrl).port) || 6379,
        gatewayPort: this.config.port,
        gatewayUrl: `http://${masterIp}:${this.config.port}`,
        nasPath: this.nas.getBasePath(),
        nasMounted: this.nas.isMounted(),
        natsConnected: this.nats.isConnected,
      };
    });

    this.protocol.registerMethod('setup.agents.registry', async () => {
      const registryPath = this.nas.resolve('config', 'agents-registry.json');
      if (!existsSync(registryPath)) return [];
      try {
        return JSON.parse(readFileSync(registryPath, 'utf-8')) as AgentRegistryEntry[];
      } catch { return []; }
    });

    this.protocol.registerMethod('setup.agents.add', async (params) => {
      const { agentId, role, hostname: agentHostname, ip } = params as {
        agentId: string; role: string; hostname?: string; ip?: string;
      };
      if (!agentId || !role) throw new Error('agentId and role are required');
      if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error('agentId must be alphanumeric with dashes/underscores');

      const registryPath = this.nas.resolve('config', 'agents-registry.json');
      let registry: AgentRegistryEntry[] = [];
      if (existsSync(registryPath)) {
        try { registry = JSON.parse(readFileSync(registryPath, 'utf-8')); } catch { registry = []; }
      }

      if (registry.some((e) => e.agentId === agentId)) {
        throw new Error(`Agent "${agentId}" already exists in registry`);
      }

      const natsToken = randomBytes(16).toString('hex');
      const authToken = randomBytes(32).toString('hex');
      const localHostname = hostname();

      // Determine local IP
      const nets = networkInterfaces();
      let masterIp = '127.0.0.1';
      for (const ifaces of Object.values(nets)) {
        if (!ifaces) continue;
        for (const iface of ifaces) {
          if (iface.family === 'IPv4' && !iface.internal) {
            masterIp = iface.address;
            break;
          }
        }
        if (masterIp !== '127.0.0.1') break;
      }

      const isLocal = !ip || ip === '127.0.0.1' || ip === masterIp || ip === 'localhost';

      const entry: AgentRegistryEntry = {
        agentId,
        role: role as AgentRegistryEntry['role'],
        hostname: agentHostname || localHostname,
        ip: ip || masterIp,
        machineId: agentHostname || localHostname,
        natsToken,
        authToken,
        isLocal,
        deployedAt: Date.now(),
        lastSeen: null,
        config: {},
      };

      registry.push(entry);
      const dir = dirname(registryPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(registryPath, JSON.stringify(registry, null, 2));

      // Generate env snippet
      const envSnippet = [
        `# Agent: ${agentId} (${role})`,
        `JARVIS_AGENT_ID=${agentId}`,
        `JARVIS_AGENT_ROLE=${role}`,
        `JARVIS_MACHINE_ID=${entry.machineId}`,
        `NATS_URL=nats://${masterIp}:${parseInt(new URL(this.config.natsUrl).port) || 4222}`,
        `NATS_TOKEN=${natsToken}`,
        `REDIS_URL=redis://${masterIp}:${parseInt(new URL(this.config.redisUrl).port) || 6379}`,
        `GATEWAY_URL=http://${masterIp}:${this.config.port}`,
        `JARVIS_NAS_MOUNT=${this.nas.getBasePath()}`,
        `JARVIS_AUTH_TOKEN=${authToken}`,
      ].join('\n');

      // Append LLM keys from current env
      const llmKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_HOST'];
      const llmSnippet = llmKeys
        .filter((k) => process.env[k])
        .map((k) => `${k}=${process.env[k]}`)
        .join('\n');

      const fullEnv = llmSnippet ? `${envSnippet}\n${llmSnippet}` : envSnippet;

      log.info(`Agent registered: ${agentId} (${role}) isLocal=${isLocal}`);
      this.protocol.broadcast('setup.agent.added', entry);

      return { agentId, natsToken, authToken, envSnippet: fullEnv, entry };
    });

    this.protocol.registerMethod('setup.agents.remove', async (params) => {
      const { agentId } = params as { agentId: string };
      if (!agentId) throw new Error('agentId is required');

      const registryPath = this.nas.resolve('config', 'agents-registry.json');
      if (!existsSync(registryPath)) throw new Error('No registry found');

      let registry: AgentRegistryEntry[] = JSON.parse(readFileSync(registryPath, 'utf-8'));
      const before = registry.length;
      registry = registry.filter((e) => e.agentId !== agentId);
      if (registry.length === before) throw new Error(`Agent "${agentId}" not found in registry`);

      writeFileSync(registryPath, JSON.stringify(registry, null, 2));

      // Stop if running locally
      const proc = this.spawnedAgents.get(agentId);
      if (proc) {
        proc.kill('SIGINT');
        this.spawnedAgents.delete(agentId);
      }

      log.info(`Agent removed from registry: ${agentId}`);
      this.protocol.broadcast('setup.agent.removed', { agentId });
      return { success: true };
    });

    this.protocol.registerMethod('setup.agents.env', async (params) => {
      const { agentId } = params as { agentId: string };
      if (!agentId) throw new Error('agentId is required');

      const registryPath = this.nas.resolve('config', 'agents-registry.json');
      if (!existsSync(registryPath)) throw new Error('No registry found');

      const registry: AgentRegistryEntry[] = JSON.parse(readFileSync(registryPath, 'utf-8'));
      const entry = registry.find((e) => e.agentId === agentId);
      if (!entry) throw new Error(`Agent "${agentId}" not found in registry`);

      const nets = networkInterfaces();
      let masterIp = '127.0.0.1';
      for (const ifaces of Object.values(nets)) {
        if (!ifaces) continue;
        for (const iface of ifaces) {
          if (iface.family === 'IPv4' && !iface.internal) {
            masterIp = iface.address;
            break;
          }
        }
        if (masterIp !== '127.0.0.1') break;
      }

      const lines = [
        `# Agent: ${entry.agentId} (${entry.role})`,
        `# Generated: ${new Date().toISOString()}`,
        `JARVIS_AGENT_ID=${entry.agentId}`,
        `JARVIS_AGENT_ROLE=${entry.role}`,
        `JARVIS_MACHINE_ID=${entry.machineId}`,
        `NATS_URL=nats://${masterIp}:${parseInt(new URL(this.config.natsUrl).port) || 4222}`,
        `NATS_TOKEN=${entry.natsToken}`,
        `REDIS_URL=redis://${masterIp}:${parseInt(new URL(this.config.redisUrl).port) || 6379}`,
        `GATEWAY_URL=http://${masterIp}:${this.config.port}`,
        `JARVIS_NAS_MOUNT=${this.nas.getBasePath()}`,
        `JARVIS_AUTH_TOKEN=${entry.authToken}`,
      ];

      const llmKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_HOST'];
      for (const k of llmKeys) {
        if (process.env[k]) lines.push(`${k}=${process.env[k]}`);
      }

      return { agentId, env: lines.join('\n') };
    });

    this.protocol.registerMethod('setup.network.scan', async () => {
      try {
        const { stdout } = await execFileAsync('arp', ['-a'], { timeout: 5000 });
        const machines: { ip: string; hostname: string }[] = [];
        for (const line of stdout.split('\n')) {
          const match = line.match(/^(\S+)\s+\((\d+\.\d+\.\d+\.\d+)\)/);
          if (match) {
            machines.push({ hostname: match[1], ip: match[2] });
          }
        }
        return machines;
      } catch (err) {
        log.warn('Network scan failed', { error: String(err) });
        return [];
      }
    });

    this.protocol.registerMethod('setup.agents.start', async (params) => {
      const { agentId } = params as { agentId: string };
      if (!agentId) throw new Error('agentId is required');

      if (this.spawnedAgents.has(agentId)) {
        throw new Error(`Agent "${agentId}" is already running`);
      }

      // Load entry from registry to get env vars
      const registryPath = this.nas.resolve('config', 'agents-registry.json');
      if (!existsSync(registryPath)) throw new Error('No registry found');
      const registry: AgentRegistryEntry[] = JSON.parse(readFileSync(registryPath, 'utf-8'));
      const entry = registry.find((e) => e.agentId === agentId);
      if (!entry) throw new Error(`Agent "${agentId}" not found in registry`);
      if (!entry.isLocal) throw new Error('Can only start local agents');

      const nets = networkInterfaces();
      let masterIp = '127.0.0.1';
      for (const ifaces of Object.values(nets)) {
        if (!ifaces) continue;
        for (const iface of ifaces) {
          if (iface.family === 'IPv4' && !iface.internal) {
            masterIp = iface.address;
            break;
          }
        }
        if (masterIp !== '127.0.0.1') break;
      }

      const agentEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        JARVIS_AGENT_ID: entry.agentId,
        JARVIS_AGENT_ROLE: entry.role,
        JARVIS_MACHINE_ID: entry.machineId,
        NATS_URL: `nats://${masterIp}:${parseInt(new URL(this.config.natsUrl).port) || 4222}`,
        NATS_TOKEN: entry.natsToken,
        REDIS_URL: `redis://${masterIp}:${parseInt(new URL(this.config.redisUrl).port) || 6379}`,
        GATEWAY_URL: `http://${masterIp}:${this.config.port}`,
        JARVIS_NAS_MOUNT: this.nas.getBasePath(),
        JARVIS_AUTH_TOKEN: entry.authToken,
      };

      // Find the agent-runtime entry point
      const runtimeDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../agent-runtime');
      const distEntry = resolve(runtimeDir, 'dist/index.js');
      const srcEntry = resolve(runtimeDir, 'src/index.ts');

      let cmd: string;
      let args: string[];

      if (existsSync(distEntry)) {
        cmd = 'node';
        args = [distEntry];
      } else if (existsSync(srcEntry)) {
        cmd = resolve(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/.bin/tsx');
        args = [srcEntry];
        if (!existsSync(cmd)) {
          // fallback to npx
          cmd = 'npx';
          args = ['tsx', srcEntry];
        }
      } else {
        throw new Error('Agent runtime not found — build the agent-runtime package first');
      }

      const child = spawn(cmd, args, {
        env: agentEnv,
        stdio: 'pipe',
        detached: false,
      });

      child.on('exit', (code) => {
        log.info(`Agent ${agentId} process exited with code ${code}`);
        this.spawnedAgents.delete(agentId);
        this.protocol.broadcast('setup.agent.stopped', { agentId, code });
      });

      child.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          this.protocol.broadcast('agent.console', { agentId, line, timestamp: Date.now() });
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          this.protocol.broadcast('agent.console', { agentId, line, timestamp: Date.now() });
        }
      });

      this.spawnedAgents.set(agentId, child);
      log.info(`Agent ${agentId} started (pid: ${child.pid})`);
      this.protocol.broadcast('setup.agent.started', { agentId, pid: child.pid });
      return { success: true, agentId, pid: child.pid };
    });

    this.protocol.registerMethod('setup.agents.stop', async (params) => {
      const { agentId } = params as { agentId: string };
      if (!agentId) throw new Error('agentId is required');

      const proc = this.spawnedAgents.get(agentId);
      if (!proc) throw new Error(`Agent "${agentId}" is not running (or was not started by this gateway)`);

      proc.kill('SIGINT');
      this.spawnedAgents.delete(agentId);
      log.info(`Agent ${agentId} stopped`);
      this.protocol.broadcast('setup.agent.stopped', { agentId });
      return { success: true };
    });

    this.protocol.registerMethod('setup.agents.test', async (params) => {
      const { agentId } = params as { agentId: string };
      if (!agentId) throw new Error('agentId is required');

      const start = Date.now();
      try {
        await Promise.race([
          this.nats.request(`jarvis.agent.${agentId}.dm`, {
            id: shortId(),
            from: 'gateway',
            to: agentId,
            content: 'ping',
            type: 'ping',
            timestamp: Date.now(),
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
        ]);
        return { reachable: true, latencyMs: Date.now() - start };
      } catch {
        return { reachable: false, latencyMs: Date.now() - start };
      }
    });

    // ── Setup Wizard: automated SSH + remote install ──────────────────

    this.protocol.registerMethod('setup.wizard.status', async () => {
      const home = process.env['HOME'] ?? '/Users/kamilpadula';
      const sshKeyPath = resolve(home, '.ssh/id_ed25519_jarvis');
      const sshKeyExists = existsSync(sshKeyPath);

      // Check smith/johny agent status from store
      const allAgents = await this.store.getAllAgentStates();
      const smithState = allAgents.find((a) => a.identity.agentId === 'agent-smith');
      const johnyState = allAgents.find((a) => a.identity.agentId === 'agent-johny');

      const smith = {
        agentId: 'agent-smith',
        role: 'dev',
        slot: 'smith' as const,
        online: smithState ? smithState.status !== 'offline' : false,
        status: smithState?.status ?? 'offline',
      };
      const johny = {
        agentId: 'agent-johny',
        role: 'marketing',
        slot: 'johny' as const,
        online: johnyState ? johnyState.status !== 'offline' : false,
        status: johnyState?.status ?? 'offline',
      };

      const setupComplete = sshKeyExists && smith.online && johny.online;

      return { setupComplete, sshKeyExists, smith, johny };
    });

    this.protocol.registerMethod('setup.ssh.generateKey', async (_params, clientId) => {
      const home = process.env['HOME'] ?? '/Users/kamilpadula';
      const sshDir = resolve(home, '.ssh');
      const keyPath = resolve(sshDir, 'id_ed25519_jarvis');

      if (existsSync(keyPath)) {
        this.protocol.sendEvent(clientId, 'setup.progress', {
          step: 'ssh.generateKey', status: 'done', message: 'SSH key already exists', slot: null,
        });
        return { existed: true, path: keyPath };
      }

      if (!existsSync(sshDir)) mkdirSync(sshDir, { recursive: true, mode: 0o700 });

      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'ssh.generateKey', status: 'running', message: 'Generating ed25519 key...', slot: null,
      });

      await execFileAsync('ssh-keygen', [
        '-t', 'ed25519',
        '-f', keyPath,
        '-N', '',
        '-C', 'jarvis-auto-deploy',
      ]);

      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'ssh.generateKey', status: 'done', message: 'SSH key generated', slot: null,
      });

      return { existed: false, path: keyPath };
    });

    this.protocol.registerMethod('setup.ssh.deployKey', async (params, clientId) => {
      const { ip, sshUser, sshPassword, slot } = params as {
        ip: string; sshUser: string; sshPassword: string; slot: string;
      };
      if (!ip || !sshUser || !sshPassword) throw new Error('ip, sshUser, sshPassword are required');

      const home = process.env['HOME'] ?? '/Users/kamilpadula';
      const pubKeyPath = resolve(home, '.ssh/id_ed25519_jarvis.pub');
      if (!existsSync(pubKeyPath)) throw new Error('SSH public key not found — generate key first');

      const pubKey = readFileSync(pubKeyPath, 'utf-8').trim();

      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'ssh.deployKey', status: 'running', message: `Deploying key to ${sshUser}@${ip}...`, slot,
      });

      // Use sshpass to deploy the public key to authorized_keys
      const deployCmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qF '${pubKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pubKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;

      try {
        await execFileAsync('sshpass', [
          '-p', sshPassword,
          'ssh',
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=10',
          `${sshUser}@${ip}`,
          deployCmd,
        ], { timeout: 30000 });
      } catch (err) {
        this.protocol.sendEvent(clientId, 'setup.progress', {
          step: 'ssh.deployKey', status: 'failed', message: `Key deploy failed: ${(err as Error).message}`, slot,
        });
        throw new Error(`SSH key deploy failed for ${slot}: ${(err as Error).message}`);
      }

      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'ssh.deployKey', status: 'done', message: 'SSH key deployed', slot,
      });

      return { success: true };
    });

    this.protocol.registerMethod('setup.ssh.testPasswordless', async (params, clientId) => {
      const { ip, sshUser, slot } = params as { ip: string; sshUser: string; slot: string };
      if (!ip || !sshUser) throw new Error('ip and sshUser are required');

      const home = process.env['HOME'] ?? '/Users/kamilpadula';
      const sshKey = resolve(home, '.ssh/id_ed25519_jarvis');

      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'ssh.testPasswordless', status: 'running', message: `Testing passwordless SSH to ${sshUser}@${ip}...`, slot,
      });

      try {
        await execFileAsync('ssh', [
          '-i', sshKey,
          '-o', 'BatchMode=yes',
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=10',
          `${sshUser}@${ip}`,
          'echo ok',
        ], { timeout: 15000 });

        this.protocol.sendEvent(clientId, 'setup.progress', {
          step: 'ssh.testPasswordless', status: 'done', message: 'Passwordless SSH works', slot,
        });
        return { success: true };
      } catch (err) {
        this.protocol.sendEvent(clientId, 'setup.progress', {
          step: 'ssh.testPasswordless', status: 'failed', message: `Passwordless SSH failed: ${(err as Error).message}`, slot,
        });
        throw new Error(`Passwordless SSH test failed for ${slot}: ${(err as Error).message}`);
      }
    });

    this.protocol.registerMethod('setup.remote.install', async (params, clientId) => {
      const { ip, sshUser, slot } = params as { ip: string; sshUser: string; slot: string };
      if (!ip || !sshUser) throw new Error('ip and sshUser are required');

      const home = process.env['HOME'] ?? '/Users/kamilpadula';
      const sshKey = resolve(home, '.ssh/id_ed25519_jarvis');
      const sshArgs = ['-i', sshKey, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15', `${sshUser}@${ip}`];

      // Check if repo exists
      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'remote.install', status: 'running', message: 'Checking if repo exists on remote...', slot,
      });

      // Sync code from master via rsync (no git needed on agents)
      const jarvisDir = resolve(home, 'Documents/Jarvis-2.0/jarvis');
      const rsyncSshArg = `-e ssh -i ${sshKey} -o StrictHostKeyChecking=no`;
      const rsyncDest = `${sshUser}@${ip}:~/jarvis/`;

      // Ensure remote directory exists
      try {
        await execFileAsync('ssh', [...sshArgs, 'mkdir -p ~/jarvis/packages'], { timeout: 10000 });
      } catch { /* ignore */ }

      // Rsync packages needed by agents: shared, agent-runtime, tools
      const packagesToSync = ['shared', 'agent-runtime', 'tools'];
      for (const pkg of packagesToSync) {
        this.protocol.sendEvent(clientId, 'setup.progress', {
          step: 'remote.install', status: 'running', message: `Syncing ${pkg} to remote...`, slot,
        });
        try {
          await execFileAsync('rsync', [
            '-avz', '--delete',
            '-e', `ssh -i ${sshKey} -o StrictHostKeyChecking=no`,
            `${jarvisDir}/packages/${pkg}/`,
            `${sshUser}@${ip}:~/jarvis/packages/${pkg}/`,
          ], { timeout: 60000 });
        } catch (err) {
          this.protocol.sendEvent(clientId, 'setup.progress', {
            step: 'remote.install', status: 'failed', message: `Rsync ${pkg} failed: ${(err as Error).message}`, slot,
          });
          throw new Error(`Rsync ${pkg} failed on ${slot}: ${(err as Error).message}`);
        }
      }

      // Sync root config files
      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'remote.install', status: 'running', message: 'Syncing config files...', slot,
      });
      const rootFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsconfig.json', 'force-ipv4.cjs'];
      for (const f of rootFiles) {
        const srcFile = resolve(jarvisDir, f);
        if (require('fs').existsSync(srcFile)) {
          try {
            await execFileAsync('rsync', [
              '-avz',
              '-e', `ssh -i ${sshKey} -o StrictHostKeyChecking=no`,
              srcFile,
              `${sshUser}@${ip}:~/jarvis/${f}`,
            ], { timeout: 15000 });
          } catch { /* non-fatal */ }
        }
      }

      // pnpm install + build
      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'remote.install', status: 'running', message: 'Running pnpm install + build on remote...', slot,
      });

      try {
        await execFileAsync('ssh', [...sshArgs,
          'source ~/.zshrc 2>/dev/null; cd ~/jarvis && pnpm install --frozen-lockfile && pnpm build',
        ], { timeout: 300000 });
      } catch (err) {
        this.protocol.sendEvent(clientId, 'setup.progress', {
          step: 'remote.install', status: 'failed', message: `pnpm install/build failed: ${(err as Error).message}`, slot,
        });
        throw new Error(`pnpm install/build failed on ${slot}: ${(err as Error).message}`);
      }

      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'remote.install', status: 'done', message: 'Repository installed on remote', slot,
      });

      return { success: true };
    });

    this.protocol.registerMethod('setup.remote.deployEnv', async (params, clientId) => {
      const { ip, sshUser, slot, agentId, role } = params as {
        ip: string; sshUser: string; slot: string; agentId: string; role: string;
      };
      if (!ip || !sshUser || !agentId || !role) throw new Error('ip, sshUser, agentId, role are required');

      const home = process.env['HOME'] ?? '/Users/kamilpadula';
      const sshKey = resolve(home, '.ssh/id_ed25519_jarvis');
      const sshArgs = ['-i', sshKey, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', `${sshUser}@${ip}`];

      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'remote.deployEnv', status: 'running', message: 'Generating and deploying .env...', slot,
      });

      // Determine master IP
      const nets = networkInterfaces();
      let masterIp = '127.0.0.1';
      for (const ifaces of Object.values(nets)) {
        if (!ifaces) continue;
        for (const iface of ifaces) {
          if (iface.family === 'IPv4' && !iface.internal) {
            masterIp = iface.address;
            break;
          }
        }
        if (masterIp !== '127.0.0.1') break;
      }

      const natsPort = parseInt(new URL(this.config.natsUrl).port) || 4222;
      const redisPort = parseInt(new URL(this.config.redisUrl).port) || 6379;

      // Generate agent tokens
      const natsToken = randomBytes(16).toString('hex');
      const authToken = randomBytes(32).toString('hex');

      const envLines = [
        `# Agent: ${agentId} (${role}) — auto-deployed by wizard`,
        `# Generated: ${new Date().toISOString()}`,
        `JARVIS_AGENT_ID=${agentId}`,
        `JARVIS_AGENT_ROLE=${role}`,
        `JARVIS_MACHINE_ID=${sshUser}-${slot}`,
        `NATS_URL=nats://${masterIp}:${natsPort}`,
        `NATS_TOKEN=${natsToken}`,
        `REDIS_URL=redis://${masterIp}:${redisPort}`,
        `GATEWAY_URL=http://${masterIp}:${this.config.port}`,
        `JARVIS_NAS_MOUNT=/Users/${sshUser}/jarvis-nas`,
        `JARVIS_AUTH_TOKEN=${authToken}`,
        `ANTHROPIC_AUTH_MODE=claude-cli`,
        `THUNDERBOLT_ENABLED=false`,
      ];

      // Append LLM keys from current env
      const llmKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_HOST'];
      for (const k of llmKeys) {
        if (process.env[k]) envLines.push(`${k}=${process.env[k]}`);
      }

      const envContent = envLines.join('\n');

      // Deploy via SSH: write .env to remote jarvis directory
      try {
        const escapedContent = envContent.replace(/'/g, "'\\''");
        await execFileAsync('ssh', [...sshArgs,
          `cat > ~/jarvis/.env << 'JARVIS_ENV_EOF'\n${escapedContent}\nJARVIS_ENV_EOF`,
        ], { timeout: 15000 });
      } catch (err) {
        this.protocol.sendEvent(clientId, 'setup.progress', {
          step: 'remote.deployEnv', status: 'failed', message: `Env deploy failed: ${(err as Error).message}`, slot,
        });
        throw new Error(`Env deploy failed on ${slot}: ${(err as Error).message}`);
      }

      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'remote.deployEnv', status: 'done', message: '.env deployed to remote', slot,
      });

      return { success: true, natsToken, authToken };
    });

    this.protocol.registerMethod('setup.remote.startServices', async (params, clientId) => {
      const { ip, sshUser, slot, agentId } = params as {
        ip: string; sshUser: string; slot: string; agentId: string;
      };
      if (!ip || !sshUser || !agentId) throw new Error('ip, sshUser, agentId are required');

      const home = process.env['HOME'] ?? '/Users/kamilpadula';
      const sshKey = resolve(home, '.ssh/id_ed25519_jarvis');
      const sshArgs = ['-i', sshKey, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15', `${sshUser}@${ip}`];

      // 1. Start websockify via launchctl
      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'remote.startServices', status: 'running', message: 'Starting websockify via launchctl...', slot,
      });

      try {
        await execFileAsync('ssh', [...sshArgs,
          'launchctl bootout gui/$(id -u)/com.jarvis.websockify 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.websockify.plist 2>/dev/null; true',
        ], { timeout: 15000 });
      } catch (err) {
        log.warn(`Websockify start warning on ${slot}`, { error: String(err) });
      }

      // 2. Start agent via launchctl (kill old + bootstrap)
      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'remote.startServices', status: 'running', message: 'Starting agent via launchctl...', slot,
      });

      try {
        await execFileAsync('ssh', [...sshArgs,
          `launchctl bootout gui/$(id -u)/com.jarvis.${agentId} 2>/dev/null; sleep 1; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.${agentId}.plist`,
        ], { timeout: 20000 });
      } catch (err) {
        this.protocol.sendEvent(clientId, 'setup.progress', {
          step: 'remote.startServices', status: 'failed', message: `Agent start failed: ${(err as Error).message}`, slot,
        });
        throw new Error(`Agent start failed on ${slot}: ${(err as Error).message}`);
      }

      this.protocol.sendEvent(clientId, 'setup.progress', {
        step: 'remote.startServices', status: 'done', message: 'Services started on remote', slot,
      });

      return { success: true };
    });

  }

  // --- NATS Subscriptions ---

  private setupNatsSubscriptions(): void {
    // Agent status updates — wildcard subscription for all agents
    this.nats.subscribe('jarvis.agent.*.status', (data, msg) => {
      const agentId = msg.subject.split('.')[2];
      knownAgents.add(agentId);

      const raw = data as Record<string, unknown>;
      let state: AgentState;

      // Support both nested AgentState format and legacy flat format
      if (raw?.identity && typeof raw.identity === 'object') {
        // New format: already nested AgentState
        state = raw as unknown as AgentState;
      } else {
        // Legacy flat format: reconstruct AgentState from flat fields
        const defaults = AGENT_DEFAULTS[agentId as AgentId];
        const now = Date.now();
        state = {
          identity: {
            agentId: agentId as AgentId,
            role: (raw?.role as string) ?? defaults?.role ?? 'dev',
            machineId: (raw?.machineId as string) ?? 'unknown',
            hostname: (raw?.hostname as string) ?? 'unknown',
          },
          status: (raw?.status as AgentState['status']) ?? 'idle',
          activeTaskId: (raw?.activeTaskId as string) ?? null,
          activeTaskDescription: (raw?.activeTask as string) ?? (raw?.activeTaskDescription as string) ?? null,
          lastHeartbeat: (raw?.timestamp as number) ?? now,
          startedAt: (raw?.startedAt as number) ?? now,
          completedTasks: (raw?.completedTasks as number) ?? 0,
          failedTasks: (raw?.failedTasks as number) ?? 0,
        };
        log.warn(`Agent ${agentId} sent legacy flat status, reconstructed AgentState`);
      }

      void this.store.setAgentState(state);
      // Only broadcast to dashboard if status or activeTask changed (avoid spamming re-renders)
      const prevState = this.agentStates?.get(state.identity.agentId);
      if (!prevState || prevState.status !== state.status || prevState.activeTaskId !== state.activeTaskId) {
        this.protocol.broadcast('agent.status', state);
      }
      if (!this.agentStates) this.agentStates = new Map();
      this.agentStates.set(state.identity.agentId, state);
    });

    this.nats.subscribe('jarvis.agent.*.heartbeat', (_data, msg) => {
      const agentId = msg.subject.split('.')[2];
      knownAgents.add(agentId);
      void this.store.updateHeartbeat(agentId);
      // Don't broadcast heartbeats to dashboard — agent.status already covers state changes
    });

    this.nats.subscribe('jarvis.agent.*.result', (data, msg) => {
      const agentId = msg.subject.split('.')[2];
      knownAgents.add(agentId);
      const result = data as { taskId: string; success?: boolean; output?: string; [key: string]: unknown };
      const finalStatus = result.success !== false ? 'completed' : 'failed';

      // Update task status in store
      if (result.taskId) {
        void this.store.updateTask(result.taskId, { status: finalStatus }).catch((err: unknown) => {
          log.error(`Failed to update task ${result.taskId} status to ${finalStatus}: ${(err as Error).message}`);
        });
      }

      this.protocol.broadcast(result.success !== false ? 'task.completed' : 'task.failed', result);

      // Notify dependency orchestrator of completion/failure
      if (result.taskId) {
        if (result.success !== false) {
          this.orchestrator.completeTask(result.taskId, (result.output as string) ?? '');
        } else {
          this.orchestrator.failTask(result.taskId, (result.output as string) ?? 'Task failed');
        }
      }
    });

    // Chat messages from agents (chatBroadcast subject) — OUTSIDE loop to avoid duplicate subscriptions
    this.nats.subscribe(NatsSubjects.chatBroadcast, (data) => {
      // Persist agent responses to NAS
      const msg = data as ChatMessage & { sessionId?: string };
      if (msg.from && msg.content) {
        this.persistChatMessage(msg.sessionId ?? 'default', msg);
      }
      this.protocol.broadcast('chat.message', data);

      // Forward to WhatsApp if this is a WhatsApp session response
      if (msg.sessionId && this.waActiveChats.has(msg.sessionId) && msg.content) {
        const jid = this.waActiveChats.get(msg.sessionId)!;
        this.sendWhatsAppMessage({ to: jid, message: msg.content }).catch((err) => {
          log.error(`WhatsApp reply failed: ${(err as Error).message}`);
        });
      }
    });

    // Chat stream deltas from agents (ephemeral, NOT persisted)
    this.nats.subscribe(NatsSubjects.chatStream, (data) => {
      const d = data as { from?: string; phase?: string; toolName?: string };
      if (d.phase === 'tool_start' || d.phase === 'done') {
        log.info(`Stream relay: ${d.from} → ${d.phase} ${d.toolName ?? ''} (clients: ${this.protocol.clientCount})`);
      }
      this.protocol.broadcast('chat.stream', data);
    });

    // Also listen on dashboardBroadcast for general agent events
    this.nats.subscribe(NatsSubjects.dashboardBroadcast, (data) => {
      const event = data as { event?: string; payload?: unknown; source?: string };
      if (event.event === 'chat.response' && event.payload) {
        // Forward chat responses from legacy broadcastDashboard path
        const chatResp = {
          id: shortId(),
          from: event.source,
          content: (event.payload as { content?: string }).content,
          timestamp: Date.now(),
        };
        this.persistChatMessage('default', chatResp as ChatMessage);
        this.protocol.broadcast('chat.message', chatResp);
      } else {
        // Forward other dashboard events
        this.protocol.broadcast(event.event ?? 'agent.activity', event);
      }
    });

    // Task progress
    this.nats.subscribe('jarvis.task.*.progress', (data) => {
      this.protocol.broadcast('task.progress', data);
    });

    // ─── Inter-Agent Communication ───────────────────

    // Agent discovery (online/offline announcements) — throttled to avoid flooding dashboard
    const lastDiscovery = new Map<string, { status: string; time: number }>();
    this.nats.subscribe(NatsSubjects.agentsDiscovery, (data) => {
      const msg = data as { agentId: string; role?: string; status?: string; capabilities?: string[]; hostname?: string; timestamp?: number };
      const prev = lastDiscovery.get(msg.agentId);
      const now = Date.now();
      // Only broadcast if status changed OR 60s elapsed since last broadcast
      if (prev && prev.status === (msg.status ?? 'online') && now - prev.time < 60_000) return;
      lastDiscovery.set(msg.agentId, { status: msg.status ?? 'online', time: now });
      log.info(`Agent discovery: ${msg.agentId} → ${msg.status ?? 'unknown'}`);
      this.protocol.broadcast('agent.discovery', msg);
    });

    // Shared broadcast channel (all agents)
    this.nats.subscribe(NatsSubjects.agentsBroadcast, (data) => {
      const msg = data as { type?: string; from?: string; content?: string; timestamp?: number };
      log.info(`Agent broadcast from ${msg.from ?? 'unknown'}: ${msg.type ?? 'broadcast'}`);
      this.protocol.broadcast('agent.broadcast', msg);
    });

    // Coordination requests (task delegation between agents)
    this.nats.subscribe(NatsSubjects.coordinationRequest, (data) => {
      const msg = data as { type?: string; from?: string; to?: string; content?: string; payload?: unknown; timestamp?: number };
      log.info(`Coordination request from ${msg.from ?? 'unknown'} → ${msg.to ?? 'all'}: ${msg.content ?? ''}`);
      this.protocol.broadcast('coordination.request', msg);
    });

    // Coordination responses (delegation ack/nack)
    this.nats.subscribe(NatsSubjects.coordinationResponse, (data) => {
      const msg = data as { type?: string; from?: string; content?: string; replyTo?: string; timestamp?: number };
      log.info(`Coordination response from ${msg.from ?? 'unknown'}: ${msg.content ?? ''}`);
      this.protocol.broadcast('coordination.response', msg);
    });

    // Direct messages between agents — wildcard subscription
    this.nats.subscribe('jarvis.agent.*.dm', (data, msg) => {
      const agentId = msg.subject.split('.')[2];
      knownAgents.add(agentId);
      const dmMsg = data as { from?: string; to?: string; content?: string; timestamp?: number };
      log.info(`Agent DM: ${dmMsg.from ?? 'unknown'} → ${agentId}: ${(dmMsg.content ?? '').slice(0, 80)}`);
      this.protocol.broadcast('agent.dm', { ...dmMsg as Record<string, unknown>, target: agentId });
    });
  }

  // --- Sessions ---

  private listSessions(): Array<{
    id: string;
    agentId: string;
    taskId?: string;
    createdAt: number;
    messageCount: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  }> {
    const results: Array<{
      id: string;
      agentId: string;
      taskId?: string;
      createdAt: number;
      messageCount: number;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
    }> = [];

    for (const agentId of knownAgents) {
      try {
        const sessDir = this.nas.sessionsDir(agentId);
        if (!existsSync(sessDir)) continue;

        const files = readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = join(sessDir, file);
          const sessionId = file.replace('.jsonl', '');
          try {
            const content = readFileSync(filePath, 'utf-8');
            const lines = content.trim().split('\n').filter(Boolean);
            let messageCount = 0;
            let totalTokens = 0;
            let inputTokens = 0;
            let outputTokens = 0;
            let createdAt = 0;
            let taskId: string | undefined;

            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                if (entry.type === 'message') messageCount++;
                if (entry.type === 'usage') {
                  totalTokens += entry.data?.totalTokens ?? 0;
                  inputTokens += entry.data?.inputTokens ?? 0;
                  outputTokens += entry.data?.outputTokens ?? 0;
                }
                if (entry.timestamp && (!createdAt || entry.timestamp < createdAt)) {
                  createdAt = entry.timestamp;
                }
                if (entry.taskId) taskId = entry.taskId;
              } catch { /* skip malformed lines */ }
            }

            if (!createdAt) {
              try { createdAt = statSync(filePath).birthtimeMs; } catch { createdAt = Date.now(); }
            }

            results.push({
              id: sessionId,
              agentId,
              taskId,
              createdAt,
              messageCount,
              totalTokens,
              inputTokens,
              outputTokens,
            });
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip missing dirs */ }
    }

    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  private getSessionDetail(sessionId: string): {
    id: string;
    agentId: string;
    messages: Array<{ role: string; content: string; timestamp: number }>;
    usage: { totalTokens: number; inputTokens: number; outputTokens: number };
  } | null {
    for (const agentId of knownAgents) {
      try {
        const filePath = join(this.nas.sessionsDir(agentId), `${sessionId}.jsonl`);
        if (!existsSync(filePath)) continue;

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        const messages: Array<{ role: string; content: string; timestamp: number }> = [];
        let totalTokens = 0;
        let inputTokens = 0;
        let outputTokens = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'message') {
              messages.push({
                role: entry.role ?? 'unknown',
                content: typeof entry.content === 'string'
                  ? entry.content
                  : JSON.stringify(entry.content ?? entry.data, null, 2),
                timestamp: entry.timestamp ?? 0,
              });
            }
            if (entry.type === 'usage') {
              totalTokens += entry.data?.totalTokens ?? 0;
              inputTokens += entry.data?.inputTokens ?? 0;
              outputTokens += entry.data?.outputTokens ?? 0;
            }
          } catch { /* skip */ }
        }

        return {
          id: sessionId,
          agentId,
          messages,
          usage: { totalTokens, inputTokens, outputTokens },
        };
      } catch { /* continue */ }
    }
    return null;
  }

  // --- Usage ---

  private getUsageSummary(): {
    totalTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalSessions: number;
    byAgent: Record<string, { totalTokens: number; inputTokens: number; outputTokens: number; sessions: number }>;
    byModel: Record<string, { totalTokens: number; calls: number }>;
    estimatedCost: number;
  } {
    const sessions = this.listSessions();
    const byAgent: Record<string, { totalTokens: number; inputTokens: number; outputTokens: number; sessions: number }> = {};

    let totalTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const s of sessions) {
      totalTokens += s.totalTokens;
      totalInputTokens += s.inputTokens;
      totalOutputTokens += s.outputTokens;

      if (!byAgent[s.agentId]) {
        byAgent[s.agentId] = { totalTokens: 0, inputTokens: 0, outputTokens: 0, sessions: 0 };
      }
      byAgent[s.agentId].totalTokens += s.totalTokens;
      byAgent[s.agentId].inputTokens += s.inputTokens;
      byAgent[s.agentId].outputTokens += s.outputTokens;
      byAgent[s.agentId].sessions++;
    }

    // Estimate cost (Claude Sonnet pricing: $3/M input, $15/M output)
    const estimatedCost = (totalInputTokens / 1_000_000) * 3 + (totalOutputTokens / 1_000_000) * 15;

    return {
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalSessions: sessions.length,
      byAgent,
      byModel: {}, // TODO: track per-model usage
      estimatedCost,
    };
  }

  private getSessionUsageList(): Array<{
    id: string;
    agentId: string;
    createdAt: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
  }> {
    return this.listSessions().map((s) => ({
      id: s.id,
      agentId: s.agentId,
      createdAt: s.createdAt,
      totalTokens: s.totalTokens,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      model: 'claude-sonnet-4-6', // TODO: read from session
    }));
  }

  // --- Logs ---

  private getLogLines(maxLines: number): string[] {
    // Cap to a reasonable upper bound to prevent excessive memory use
    const cappedMax = Math.min(Math.max(1, maxLines), 5000);
    const logFiles = [
      '/tmp/jarvis-gateway.log',
      '/tmp/jarvis-nats.log',
    ];

    const allLines: string[] = [];

    for (const file of logFiles) {
      try {
        if (!existsSync(file)) continue;
        const content = readFileSync(file, 'utf-8');
        const lines = content.trim().split('\n');
        // Strip ANSI color codes
        const cleaned = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
        allLines.push(...cleaned);
      } catch { /* skip */ }
    }

    // Sort by timestamp if possible, otherwise keep order
    // Return last N lines
    return allLines.slice(-cappedMax);
  }

  // --- Workflows ---

  private listWorkflows(): Array<{
    id: string;
    name: string;
    description: string;
    steps: number;
    tags: string[];
    createdAt: number;
    updatedAt: number;
    createdBy: string;
  }> {
    const results: Array<{
      id: string;
      name: string;
      description: string;
      steps: number;
      tags: string[];
      createdAt: number;
      updatedAt: number;
      createdBy: string;
    }> = [];

    try {
      const wfDir = this.nas.resolve('workflows');
      if (!existsSync(wfDir)) return results;

      const files = readdirSync(wfDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(wfDir, file), 'utf-8'));
          if (data.id && data.steps) {
            results.push({
              id: data.id,
              name: data.name ?? file,
              description: data.description ?? '',
              steps: Array.isArray(data.steps) ? data.steps.length : 0,
              tags: data.tags ?? [],
              createdAt: data.createdAt ?? 0,
              updatedAt: data.updatedAt ?? 0,
              createdBy: data.createdBy ?? 'unknown',
            });
          }
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }

    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private getWorkflow(workflowId: string): Record<string, unknown> | null {
    try {
      const filePath = this.nas.resolve('workflows', `${workflowId}.json`);
      if (existsSync(filePath)) {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
      }
    } catch { /* skip */ }
    return null;
  }

  private listWorkflowRuns(): Array<{
    runId: string;
    workflowId: string;
    workflowName: string;
    status: string;
    startedAt: number;
    endedAt?: number;
    stepsCompleted: number;
    stepsTotal: number;
    agentId: string;
  }> {
    const results: Array<{
      runId: string;
      workflowId: string;
      workflowName: string;
      status: string;
      startedAt: number;
      endedAt?: number;
      stepsCompleted: number;
      stepsTotal: number;
      agentId: string;
    }> = [];

    try {
      const runsDir = this.nas.resolve('workflow-runs');
      if (!existsSync(runsDir)) return results;

      const files = readdirSync(runsDir).filter(f => f.endsWith('.json'));
      for (const file of files.slice(-50)) { // Last 50 runs
        try {
          const data = JSON.parse(readFileSync(join(runsDir, file), 'utf-8'));
          if (data.runId) {
            const stepResults = data.stepResults ?? [];
            results.push({
              runId: data.runId,
              workflowId: data.workflowId ?? '',
              workflowName: data.workflowName ?? '',
              status: data.status ?? 'unknown',
              startedAt: data.startedAt ?? 0,
              endedAt: data.endedAt,
              stepsCompleted: stepResults.filter((s: { status: string }) => s.status === 'completed').length,
              stepsTotal: stepResults.length,
              agentId: data.agentId ?? 'unknown',
            });
          }
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }

    return results.sort((a, b) => b.startedAt - a.startedAt);
  }

  // --- Scheduler / Cron ---

  private listScheduledJobs(): Array<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = [];
    try {
      const jobsDir = this.nas.resolve('cron-jobs');
      if (!existsSync(jobsDir)) return results;

      const files = readdirSync(jobsDir).filter(f => f.endsWith('.json') && f !== 'history.json');
      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(jobsDir, file), 'utf-8'));
          results.push(data);
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
    return results.sort((a, b) => (b.createdAt as string ?? '').localeCompare(a.createdAt as string ?? ''));
  }

  private getSchedulerHistory(): Array<Record<string, unknown>> {
    try {
      const histPath = this.nas.resolve('cron-jobs', 'history.json');
      if (existsSync(histPath)) {
        const data = JSON.parse(readFileSync(histPath, 'utf-8'));
        return Array.isArray(data) ? data.slice(-100).reverse() : [];
      }
    } catch { /* ignore */ }
    return [];
  }

  private createScheduledJob(params: Record<string, unknown>): { success: boolean; id: string } {
    const id = `cron-${shortId()}`;
    const job = {
      id,
      name: params.name ?? 'Untitled',
      description: params.description ?? '',
      cron: params.cron,
      at: params.at,
      targetAgent: params.targetAgent,
      taskInstruction: params.taskInstruction ?? '',
      priority: params.priority ?? 5,
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
      tags: params.tags ?? [],
    };

    try {
      const jobsDir = this.nas.resolve('cron-jobs');
      if (!existsSync(jobsDir)) {
        mkdirSync(jobsDir, { recursive: true });
      }
      writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify(job, null, 2));
      return { success: true, id };
    } catch (err) {
      log.error('Failed to create scheduled job', { error: String(err) });
      return { success: false, id: '' };
    }
  }

  private deleteScheduledJob(jobId: string): { success: boolean } {
    try {
      const filePath = this.nas.resolve('cron-jobs', `${jobId}.json`);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        return { success: true };
      }
    } catch { /* ignore */ }
    return { success: false };
  }

  private toggleScheduledJob(jobId: string, enabled: boolean): { success: boolean } {
    try {
      const filePath = this.nas.resolve('cron-jobs', `${jobId}.json`);
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        data.enabled = enabled;
        writeFileSync(filePath, JSON.stringify(data, null, 2));
        return { success: true };
      }
    } catch { /* ignore */ }
    return { success: false };
  }

  private runJobNow(jobId: string): { success: boolean; message: string } {
    try {
      const filePath = this.nas.resolve('cron-jobs', `${jobId}.json`);
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        data.lastRun = new Date().toISOString();
        data.runCount = (data.runCount ?? 0) + 1;
        writeFileSync(filePath, JSON.stringify(data, null, 2));

        // Send task to agent
        const task = {
          id: shortId(),
          title: `[Scheduler] ${data.name}`,
          description: data.taskInstruction,
          priority: data.priority ?? 5,
          requiredCapabilities: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        void this.assignTask(task as any);

        // Log to history
        const histPath = this.nas.resolve('cron-jobs', 'history.json');
        let hist: Array<Record<string, unknown>> = [];
        try {
          if (existsSync(histPath)) hist = JSON.parse(readFileSync(histPath, 'utf-8'));
        } catch { /* ignore */ }
        hist.push({
          jobId: data.id,
          jobName: data.name,
          timestamp: new Date().toISOString(),
          status: 'fired',
          details: `Manual trigger via dashboard`,
        });
        writeFileSync(histPath, JSON.stringify(hist.slice(-500), null, 2));

        return { success: true, message: `Job "${data.name}" fired` };
      }
    } catch (err) {
      log.error('Failed to run job', { error: String(err) });
      return { success: false, message: 'Failed to execute job' };
    }
    return { success: false, message: 'Job not found' };
  }

  // --- API Keys ---

  /** Load raw (unmasked) API keys — for internal use only */
  private loadRawApiKeys(): { keys: Array<{ id: string; name: string; provider: string; key: string; addedAt: number; lastUsed?: number }> } {
    const configPath = this.nas.resolve('config', 'api-keys.json');
    let data: { keys: Array<{ id: string; name: string; provider: string; key: string; addedAt: number; lastUsed?: number }> } = { keys: [] };

    try {
      if (existsSync(configPath)) {
        data = JSON.parse(readFileSync(configPath, 'utf-8'));
      }
    } catch { /* ignore */ }

    // Add env-based keys as fallback
    if (data.keys.length === 0) {
      const envKeySources: Array<{ id: string; name: string; provider: string; envVar: string }> = [
        { id: 'env-anthropic', name: 'ANTHROPIC_API_KEY', provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
        { id: 'env-openai', name: 'OPENAI_API_KEY', provider: 'openai', envVar: 'OPENAI_API_KEY' },
        { id: 'env-spotify', name: 'SPOTIFY_ACCESS_TOKEN', provider: 'spotify', envVar: 'SPOTIFY_ACCESS_TOKEN' },
        { id: 'env-homeassistant', name: 'HASS_TOKEN', provider: 'homeassistant', envVar: 'HASS_TOKEN' },
      ];

      for (const src of envKeySources) {
        const value = process.env[src.envVar];
        if (value) {
          data.keys.push({ id: src.id, name: src.name, provider: src.provider, key: value, addedAt: Date.now() });
        }
      }
    }

    return data;
  }

  /** Get API keys with masked values — safe to return to dashboard */
  private getApiKeys(): { keys: Array<{ id: string; name: string; provider: string; key: string; addedAt: number; lastUsed?: number }> } {
    const data = this.loadRawApiKeys();
    return {
      keys: data.keys.map(k => ({
        ...k,
        key: maskSecret(k.key),
      })),
    };
  }

  /** Compare two strings using a timing-safe method to prevent timing attacks. */
  private safeCompareKeys(a: string, b: string): boolean {
    const hashA = createHash('sha256').update(a).digest();
    const hashB = createHash('sha256').update(b).digest();
    return timingSafeEqual(hashA, hashB);
  }

  /** Validate an API key without exposing it — returns true/false */
  private validateApiKey(params: { id: string; key: string }): { valid: boolean } {
    const configPath = this.nas.resolve('config', 'api-keys.json');
    try {
      if (existsSync(configPath)) {
        const data = JSON.parse(readFileSync(configPath, 'utf-8')) as { keys: Array<{ id: string; key: string }> };
        const found = data.keys.find(k => k.id === params.id);
        if (found) {
          return { valid: this.safeCompareKeys(found.key, params.key) };
        }
      }
    } catch { /* ignore */ }

    // Check env keys
    const envMap: Record<string, string> = {
      'env-anthropic': 'ANTHROPIC_API_KEY',
      'env-openai': 'OPENAI_API_KEY',
      'env-spotify': 'SPOTIFY_ACCESS_TOKEN',
      'env-homeassistant': 'HASS_TOKEN',
    };
    const envVar = envMap[params.id];
    if (envVar && process.env[envVar]) {
      return { valid: this.safeCompareKeys(process.env[envVar]!, params.key) };
    }

    return { valid: false };
  }

  private addApiKey(params: { name: string; provider: string; key: string }): { success: boolean; id: string } {
    const configPath = this.nas.resolve('config', 'api-keys.json');
    const data = this.loadRawApiKeys();

    const id = `key-${shortId()}`;
    data.keys.push({
      id,
      name: params.name,
      provider: params.provider,
      key: params.key,
      addedAt: Date.now(),
    });

    try {
      writeFileSync(configPath, JSON.stringify(data, null, 2));
      return { success: true, id };
    } catch (err) {
      log.error('Failed to save API key', { error: String(err) });
      return { success: false, id: '' };
    }
  }

  private deleteApiKey(keyId: string): { success: boolean } {
    if (keyId.startsWith('env-')) {
      return { success: false }; // Can't delete env keys
    }

    const configPath = this.nas.resolve('config', 'api-keys.json');
    const data = this.loadRawApiKeys();
    data.keys = data.keys.filter(k => k.id !== keyId);

    try {
      writeFileSync(configPath, JSON.stringify(data, null, 2));
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  // --- Notifications Config ---

  private getNotificationsConfig(): Record<string, unknown> {
    const configPath = this.nas.resolve('config', 'notifications.json');
    try {
      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, 'utf-8'));
      }
    } catch { /* ignore */ }

    // Return defaults
    return {
      enableNative: process.platform === 'darwin',
      enableWebhook: false,
      webhooks: [],
      enableSound: true,
      soundName: 'Glass',
      enableTTS: false,
      notifyOnTaskComplete: true,
      notifyOnTaskFail: true,
      minPriority: 3,
      quietHours: { start: 23, end: 7 },
    };
  }

  private setNotificationsConfig(updates: Record<string, unknown>): { success: boolean; config: Record<string, unknown> } {
    const configPath = this.nas.resolve('config', 'notifications.json');
    let config: Record<string, unknown> = this.getNotificationsConfig();

    // Merge updates
    config = { ...config, ...updates };

    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      return { success: true, config };
    } catch (err) {
      log.error('Failed to save notifications config', { error: String(err) });
      return { success: false, config };
    }
  }

  // --- System Metrics ---

  private getSystemMetrics(): {
    cpu: { cores: number; model: string; speed: number; load: number[]; usage: number };
    memory: { total: number; free: number; used: number; usedPercent: number };
    disk: Array<{ filesystem: string; size: string; used: string; available: string; usedPercent: number; mount: string }>;
    network: Record<string, { rx: number; tx: number; ip: string }>;
    os: { hostname: string; platform: string; uptime: number; arch: string };
    timestamp: number;
  } {
    const cpuInfo = cpus();
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;
    const loads = loadavg();

    // CPU usage estimate from load average
    const cpuUsage = Math.min(100, (loads[0] / cpuInfo.length) * 100);

    // Disk usage via df
    const diskEntries: Array<{ filesystem: string; size: string; used: string; available: string; usedPercent: number; mount: string }> = [];
    try {
      const dfOutput = execFileSync('df', ['-h', '/'], { encoding: 'utf-8', timeout: 5000 });
      const lines = dfOutput.trim().split('\n').slice(1); // skip header
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 6) {
          diskEntries.push({
            filesystem: parts[0],
            size: parts[1],
            used: parts[2],
            available: parts[3],
            usedPercent: parseInt(parts[4]) || 0,
            mount: parts.slice(5).join(' '),
          });
        }
      }
    } catch { /* ignore */ }

    // Network interfaces
    const nets = networkInterfaces();
    const netSummary: Record<string, { rx: number; tx: number; ip: string }> = {};
    for (const [name, addrs] of Object.entries(nets)) {
      if (!addrs) continue;
      const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
      if (ipv4) {
        // Get network stats via netstat (macOS)
        let rx = 0;
        let tx = 0;
        try {
          const netstatOut = execFileSync('netstat', ['-ibn'], { encoding: 'utf-8', timeout: 3000 });
          const matchLine = netstatOut.split('\n').find(l => l.startsWith(name + ' ') || l.startsWith(name + '\t'));
          if (matchLine) {
            const cols = matchLine.trim().split(/\s+/);
            if (cols.length >= 10) {
              rx = parseInt(cols[6]) || 0;
              tx = parseInt(cols[9]) || 0;
            }
          }
        } catch { /* ignore */ }
        netSummary[name] = { rx, tx, ip: ipv4.address };
      }
    }

    return {
      cpu: {
        cores: cpuInfo.length,
        model: cpuInfo[0]?.model ?? 'Unknown',
        speed: cpuInfo[0]?.speed ?? 0,
        load: loads,
        usage: Math.round(cpuUsage * 10) / 10,
      },
      memory: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        usedPercent: Math.round((usedMem / totalMem) * 1000) / 10,
      },
      disk: diskEntries,
      network: netSummary,
      os: {
        hostname: hostname(),
        platform: process.platform,
        uptime: osUptime(),
        arch: process.arch,
      },
      timestamp: Date.now(),
    };
  }

  private getTopProcesses(): Array<{
    pid: number;
    name: string;
    cpu: number;
    mem: number;
    user: string;
  }> {
    const results: Array<{ pid: number; name: string; cpu: number; mem: number; user: string }> = [];
    try {
      // Use -r flag (macOS sort by CPU) since --sort is Linux-only
      const output = execFileSync('ps', ['aux', '-r'], { encoding: 'utf-8', timeout: 5000 });
      const lines = output.trim().split('\n').slice(1, 16); // top 15 processes
      for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 11) {
          results.push({
            user: cols[0],
            pid: parseInt(cols[1]) || 0,
            cpu: parseFloat(cols[2]) || 0,
            mem: parseFloat(cols[3]) || 0,
            name: cols.slice(10).join(' ').split('/').pop()?.split(' ')[0] ?? cols[10],
          });
        }
      }
    } catch { /* ignore */ }
    return results;
  }

  // --- Task Assignment ---

  private async assignTask(task: TaskDefinition): Promise<void> {
    // Simple assignment: match required capabilities to agent
    const agents = await this.store.getAllAgentStates();

    for (const agent of agents) {
      if (agent.status !== 'idle') continue;

      const caps = await this.store.getCapabilities(agent.identity.agentId);
      if (!caps) continue;

      const hasAllCapabilities = task.requiredCapabilities.every(
        (cap) => caps.capabilities.includes(cap as never)
      );

      if (hasAllCapabilities) {
        await this.store.updateTask(task.id, { assignedAgent: agent.identity.agentId, status: 'assigned' });
        await this.nats.publish(NatsSubjects.agentTask(agent.identity.agentId), task);
        this.protocol.broadcast('task.assigned', {
          taskId: task.id,
          agentId: agent.identity.agentId,
        });
        log.info(`Task ${task.id} assigned to ${agent.identity.agentId}`);
        return;
      }
    }

    log.warn(`No available agent for task ${task.id}`, {
      required: task.requiredCapabilities,
    });
  }

  // --- Health ---

  private async getHealthStatus() {
    const agents = await this.store.getAllAgentStates();
    const now = Date.now();

    return {
      status: 'ok',
      version: PROJECT_VERSION,
      uptime: process.uptime(),
      infrastructure: {
        nats: this.nats.isConnected,
        redis: this.redis.isConnected,
        nas: this.nas.healthCheck(),
      },
      agents: agents
        .filter((a) => a?.identity?.agentId)
        .map((a) => ({
          id: a.identity.agentId,
          role: a.identity.role ?? 'unknown',
          status: a.status ?? 'unknown',
          lastHeartbeat: a.lastHeartbeat ?? 0,
          alive: now - (a.lastHeartbeat ?? 0) < HEARTBEAT_TIMEOUT,
          activeTask: a.activeTaskDescription ?? null,
        })),
      dashboard: {
        connectedClients: this.protocol.clientCount,
      },
    };
  }

  private startHealthMonitoring(): void {
    this.healthInterval = setInterval(async () => {
      try {
        const health = await this.getHealthStatus();
        this.protocol.broadcast('system.health', health);
      } catch (err) {
        log.error('Health monitoring error', { error: (err as Error).message });
      }
    }, 15_000);
  }

  // --- Dependency Orchestrator ---

  private setupOrchestrator(): void {
    // When a task is ready to dispatch, send it to the target agent via NATS
    this.orchestrator.onDispatch(async (agentId, task) => {
      const taskAssignment = {
        taskId: task.taskId,
        title: task.title,
        description: task.description,
        priority: task.priority,
        context: {
          sourceAgent: task.sourceAgent,
          planId: task.planId,
          stepId: task.stepId,
        },
      };

      await this.nats.publish(NatsSubjects.agentTask(agentId), taskAssignment);
      this.orchestrator.startTask(task.taskId, agentId);

      this.protocol.broadcast('task.delegated', {
        taskId: task.taskId,
        from: task.sourceAgent,
        to: agentId,
        title: task.title,
      });

      log.info(`Orchestrator dispatched task ${task.taskId} to ${agentId}`);
    });

    // When a delegated task completes, announce back to the source agent
    this.orchestrator.onAnnounce(async (sourceAgent, taskId, result, success) => {
      const chatMsg = {
        from: 'gateway',
        content: success
          ? `📋 Delegated task completed: ${taskId}\nResult: ${result.slice(0, 500)}`
          : `❌ Delegated task failed: ${taskId}\nError: ${result.slice(0, 500)}`,
        timestamp: Date.now(),
        type: 'delegation_result',
        taskId,
      };

      // Send as chat message to the source agent
      await this.nats.publish(NatsSubjects.chat(sourceAgent), chatMsg);

      this.protocol.broadcast('task.delegation_result', {
        taskId,
        sourceAgent,
        success,
        result: result.slice(0, 500),
      });

      log.info(`Announced delegation result for ${taskId} to ${sourceAgent} (${success ? 'success' : 'failed'})`);
    });

    log.info('Dependency orchestrator wired up');
  }

  private async sendInitialState(clientId: string): Promise<void> {
    const health = await this.getHealthStatus();
    this.protocol.sendEvent(clientId, 'system.health', health);

    const agents = await this.store.getAllAgentStates();
    for (const agent of agents) {
      this.protocol.sendEvent(clientId, 'agent.status', agent);
    }
  }

  // --- Environment Variables ---

  private getEnvironmentVars(): Record<string, string> {
    // Return JARVIS-relevant env vars (filter out system noise)
    const relevant: Record<string, string> = {};
    const prefixes = [
      'JARVIS_', 'NATS_', 'REDIS_', 'AGENT_', 'MACHINE_',
      'THUNDERBOLT_', 'VNC_', 'DEFAULT_MODEL', 'SPOTIFY_',
      'HASS_', 'OPENAI_', 'ANTHROPIC_', 'GOOGLE_', 'SLACK_',
      'DISCORD_', 'NTFY_', 'NODE_ENV', 'PORT', 'HOST',
    ];

    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (prefixes.some((p) => key.startsWith(p))) {
        // SECURITY: Mask values that look like secrets
        relevant[key] = isSecretKey(key) ? maskSecret(value) : value;
      }
    }

    // Also read custom env from NAS config
    try {
      const envPath = this.nas.resolve('config', 'environment.json');
      if (existsSync(envPath)) {
        const custom = JSON.parse(readFileSync(envPath, 'utf-8')) as Record<string, string>;
        for (const [key, value] of Object.entries(custom)) {
          if (!(key in relevant)) {
            relevant[key] = isSecretKey(key) ? maskSecret(value) : value;
          }
        }
      }
    } catch { /* ignore */ }

    return relevant;
  }

  // Keys that must NEVER be modified via the dashboard
  private static readonly BLOCKED_ENV_KEYS = new Set([
    'JARVIS_AUTH_TOKEN', 'NATS_TOKEN', 'NATS_USER', 'NATS_PASS',
    'REDIS_URL', 'NATS_URL', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY',
  ]);

  private static readonly BLOCKED_ENV_PREFIXES = [
    'JARVIS_AUTH', 'STRIPE_', 'JWT_SECRET',
  ];

  private setEnvironmentVar(key: string, value: string): { success: boolean; message?: string } {
    // Block security-critical keys
    if (GatewayServer.BLOCKED_ENV_KEYS.has(key)) {
      log.warn(`Blocked attempt to set protected env var: ${key}`);
      return { success: false, message: `Cannot modify protected variable: ${key}` };
    }
    for (const prefix of GatewayServer.BLOCKED_ENV_PREFIXES) {
      if (key.startsWith(prefix)) {
        log.warn(`Blocked attempt to set protected env var: ${key}`);
        return { success: false, message: `Cannot modify protected variable: ${key}` };
      }
    }

    // Set in process env
    process.env[key] = value;

    // Persist to NAS config
    try {
      const envPath = this.nas.resolve('config', 'environment.json');
      let existing: Record<string, string> = {};
      if (existsSync(envPath)) {
        existing = JSON.parse(readFileSync(envPath, 'utf-8')) as Record<string, string>;
      }
      existing[key] = value;
      const configDir = this.nas.resolve('config');
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      writeFileSync(envPath, JSON.stringify(existing, null, 2), 'utf-8');
    } catch (err) {
      log.warn('Failed to persist env var', { key, error: (err as Error).message });
    }

    return { success: true };
  }

  private deleteEnvironmentVar(key: string): { success: boolean; message?: string } {
    // Block deletion of security-critical keys (same denylist as setEnvironmentVar)
    if (GatewayServer.BLOCKED_ENV_KEYS.has(key)) {
      log.warn(`Blocked attempt to delete protected env var: ${key}`);
      return { success: false, message: `Cannot delete protected variable: ${key}` };
    }
    for (const prefix of GatewayServer.BLOCKED_ENV_PREFIXES) {
      if (key.startsWith(prefix)) {
        log.warn(`Blocked attempt to delete protected env var: ${key}`);
        return { success: false, message: `Cannot delete protected variable: ${key}` };
      }
    }

    // Don't allow deleting runtime env vars
    if (process.env[key] !== undefined) {
      delete process.env[key];
    }

    // Remove from NAS config
    try {
      const envPath = this.nas.resolve('config', 'environment.json');
      if (existsSync(envPath)) {
        const existing = JSON.parse(readFileSync(envPath, 'utf-8')) as Record<string, string>;
        delete existing[key];
        writeFileSync(envPath, JSON.stringify(existing, null, 2), 'utf-8');
      }
    } catch { /* ignore */ }

    return { success: true };
  }

  // --- Timeline ---

  private getTimelines(): { timelines: Array<Record<string, unknown>> } {
    const timelines: Array<Record<string, unknown>> = [];
    try {
      const dir = this.nas.resolve('timelines');
      if (existsSync(dir)) {
        const files = readdirSync(dir).filter((f) => f.endsWith('-timeline.json'));
        for (const file of files) {
          try {
            const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
            timelines.push(data);
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }
    return { timelines };
  }

  private getRecentTimeline(): Array<Record<string, unknown>> {
    const allEntries: Array<Record<string, unknown>> = [];
    try {
      const dir = this.nas.resolve('timelines');
      if (existsSync(dir)) {
        const files = readdirSync(dir).filter((f) => f.endsWith('-timeline.json'));
        for (const file of files) {
          try {
            const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
            if (data.entries && Array.isArray(data.entries)) {
              allEntries.push(...data.entries);
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }
    // Sort by timestamp descending, return last 200
    allEntries.sort((a, b) => ((b.timestamp as number) || 0) - ((a.timestamp as number) || 0));
    return allEntries.slice(0, 200);
  }

  // --- Plugins ---

  private async getPluginsList(): Promise<{ agents: Array<Record<string, unknown>> }> {
    const agents: Array<Record<string, unknown>> = [];
    try {
      const allAgents = await this.store.getAllAgentStates();
      for (const agent of allAgents) {
        const agentId = agent.identity?.agentId ?? 'unknown';
        // Try to get capabilities from NATS
        try {
          const caps = await this.nats.request(`jarvis.agent.${agentId}.capabilities`, {}, 3000);
          const capsData = caps as Record<string, unknown>;

          const pluginList = (capsData?.plugins as string[]) ?? [];
          const toolList = (capsData?.tools as string[]) ?? [];

          // Build plugin info from capabilities data
          const pluginDetails = (capsData?.pluginDetails as Array<Record<string, unknown>>) ?? [];

          const plugins = pluginDetails.length > 0
            ? pluginDetails.map((pd) => ({
                id: pd.id ?? 'unknown',
                name: pd.name ?? (pd.id as string)?.replace('jarvis-', '').replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) ?? 'Unknown',
                description: pd.description ?? '',
                version: pd.version ?? '',
                source: pd.source ?? 'builtin',
                tools: pd.tools ?? [],
                hooks: pd.hooks ?? [],
                services: pd.services ?? [],
                promptSections: pd.promptSections ?? [],
              }))
            : pluginList.map((name) => ({
                id: name,
                name: name.replace('jarvis-', '').replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
                source: 'builtin',
                tools: [] as string[],
                hooks: [] as string[],
                services: [] as string[],
                promptSections: [] as string[],
              }));

          agents.push({
            agentId,
            plugins,
            summary: `${pluginList.length} plugins, ${toolList.length} tools`,
          });
        } catch {
          // Agent not responding, return basic info
          agents.push({
            agentId,
            plugins: [],
            summary: 'Agent not responding',
          });
        }
      }
    } catch (err) {
      log.error(`Failed to get plugins list: ${(err as Error).message}`);
    }
    return { agents };
  }

  // --- Voice ---

  private async processVoiceMessage(params: { message: string; language: string }): Promise<{ reply: string; agentId?: string }> {
    const { message, language } = params;
    log.info(`Voice message [${language}]: "${message.substring(0, 80)}"`);

    // Broadcast voice event for timeline
    this.protocol.broadcast('voice.message', { message, language, timestamp: Date.now() });

    // Try to route to an available agent
    try {
      const allAgents = await this.store.getAllAgentStates();
      const idleAgent = allAgents.find((a) => a.status === 'idle');

      if (idleAgent) {
        const agentId = idleAgent.identity?.agentId ?? 'agent-smith';

        // Get system context for Jarvis personality
        const health = await this.getHealthData();
        const agentCount = allAgents.length;
        const onlineAgents = allAgents.filter((a) => {
          const elapsed = Date.now() - (a.lastHeartbeat ?? 0);
          return elapsed < HEARTBEAT_TIMEOUT;
        }).length;

        const context = `${onlineAgents}/${agentCount} agents online. System: ${health.status}. Uptime: ${Math.floor(health.uptime / 60)}min.`;

        // Send voice processing request to agent via NATS
        try {
          const response = await this.nats.request(
            `jarvis.agent.${agentId}.voice`,
            {
              message,
              language,
              context,
              type: 'voice_command',
            },
            10_000, // 10s timeout for voice
          );

          const result = response as Record<string, unknown>;
          if (result?.reply) {
            const reply = result.reply as string;
            this.protocol.broadcast('voice.response', { reply, agentId, timestamp: Date.now() });
            return { reply, agentId };
          }
        } catch {
          // Agent didn't handle voice, use local responses
        }
      }
    } catch {
      // Store unavailable, fall through to local responses
    }

    // Local Jarvis responses as fallback
    const reply = this.getLocalVoiceResponse(message, language);
    this.protocol.broadcast('voice.response', { reply, timestamp: Date.now() });
    return { reply };
  }

  private getLocalVoiceResponse(message: string, language: string): string {
    const lower = message.toLowerCase();

    if (language === 'pl') {
      if (lower.includes('status') || lower.includes('jak') && lower.includes('system'))
        return 'Wszystko działa, gateway stoi, oba agenty online.';
      if (lower.includes('agenci') || lower.includes('agent'))
        return 'Masz Smitha na devie i Johny\'ego na marketingu, oba aktywne.';
      if (lower.includes('czas') || lower.includes('godzina') || lower.includes('która'))
        return `Jest ${new Date().toLocaleTimeString('pl-PL')}.`;
      if (lower.includes('dzień dobry') || lower.includes('cześć') || lower.includes('hej') || lower.includes('siema') || lower.includes('yo'))
        return 'Hej, co tam? Systemy działają, mów co trzeba.';
      if (lower.includes('dziękuję') || lower.includes('dzięki'))
        return 'Spoko, nie ma sprawy.';
      if (lower.includes('kto') && (lower.includes('jesteś') || lower.includes('ty')))
        return 'Jarvis — ogarniam twoje agenty AI, pilnuję infrastruktury i pomagam w robocie.';
      if (lower.includes('pomoc') || lower.includes('co potrafisz') || lower.includes('co umiesz'))
        return 'Ogarniam agentów, monitoruję system, planuję taski, puszczam workflow-y. Gadam po polsku i angielsku. Pytaj.';
      if (lower.includes('dobranoc') || lower.includes('nara') || lower.includes('pa'))
        return 'Nara, jakby co to tu jestem.';
      if (lower.includes('kurwa') || lower.includes('cholera') || lower.includes('szlag'))
        return 'Spokojnie, co się stało? Mów, ogarniemy.';
      return 'Okej, ogarniamy. Coś jeszcze?';
    }

    // English
    if (lower.includes('status') || (lower.includes('how') && lower.includes('system')))
      return 'Everything\'s running, gateway up, both agents online.';
    if (lower.includes('agents') || lower.includes('agent'))
      return 'Smith\'s on dev, Johny\'s on marketing. Both active.';
    if (lower.includes('time'))
      return `It's ${new Date().toLocaleTimeString('en-US')}.`;
    if (lower.includes('hello') || lower.includes('hey') || lower.includes('hi') || lower.includes('yo'))
      return 'Hey, what\'s up? Systems are good, what do you need?';
    if (lower.includes('thank'))
      return 'No worries.';
    if (lower.includes('who are you') || lower.includes('what are you'))
      return 'I\'m Jarvis — I manage your AI agents, watch the infra, and help get stuff done.';
    if (lower.includes('help') || lower.includes('what can you do'))
      return 'I handle agents, monitor systems, plan tasks, run workflows. Ask me anything.';
    if (lower.includes('bye') || lower.includes('goodnight'))
      return 'Later. I\'ll be around.';
    return 'Got it. Anything else?';
  }

  private getVoiceSettings(): Record<string, unknown> {
    // Load voice settings from NAS config
    try {
      const settingsPath = this.nas.resolve('config', 'voice-settings.json');
      if (existsSync(settingsPath)) {
        return JSON.parse(readFileSync(settingsPath, 'utf-8'));
      }
    } catch { /* ignore */ }

    return {
      defaultLanguage: 'pl',
      ttsProvider: 'elevenlabs',
      wakeWord: 'Jarvis',
      supportedLanguages: ['pl', 'en'],
      voiceProfiles: {
        elevenlabs: {
          recommended: [
            { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', style: 'British Jarvis' },
            { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', style: 'Deep, Authoritative' },
            { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', style: 'Warm, Professional' },
          ],
        },
        openai: {
          recommended: [
            { id: 'onyx', name: 'Onyx', style: 'Deep Male' },
            { id: 'echo', name: 'Echo', style: 'Smooth Male' },
            { id: 'fable', name: 'Fable', style: 'British Male' },
          ],
        },
      },
    };
  }

  // --- File Manager ---

  /** Validate that a resolved path is within the NAS base directory (prevents path traversal) */
  private assertPathWithinNas(fullPath: string): void {
    const nasBase = resolve(this.nas.getBasePath());
    const resolved = resolve(fullPath);
    if (!resolved.startsWith(nasBase + '/') && resolved !== nasBase) {
      throw new Error('Path traversal detected: path escapes NAS directory');
    }
  }

  /** Validate that a session ID contains only safe characters */
  private assertSafeSessionId(sessionId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new Error('Invalid session ID: contains unsafe characters');
    }
  }

  private listFiles(reqPath: string): { entries: Array<Record<string, unknown>>; path: string } {
    const entries: Array<Record<string, unknown>> = [];
    try {
      // Resolve relative to NAS root
      const cleanPath = reqPath === '/' ? '' : reqPath.replace(/^\/+/, '');
      const fullPath = cleanPath ? join(this.nas.getBasePath(), cleanPath) : this.nas.getBasePath();
      this.assertPathWithinNas(fullPath);
      const resolvedPath = cleanPath || '/';

      if (!existsSync(fullPath)) {
        return { entries: [], path: resolvedPath };
      }

      const items = readdirSync(fullPath, { withFileTypes: true });

      for (const item of items) {
        if (item.name.startsWith('.')) continue; // Skip hidden files

        const itemPath = join(fullPath, item.name);
        const entry: Record<string, unknown> = {
          name: item.name,
          path: resolvedPath === '/' ? `/${item.name}` : `${resolvedPath}/${item.name}`,
          type: item.isDirectory() ? 'directory' : 'file',
        };

        if (!item.isDirectory()) {
          try {
            const stats = statSync(itemPath);
            entry.size = stats.size;
            entry.modified = stats.mtime.toISOString();
            entry.extension = item.name.includes('.') ? item.name.split('.').pop() : '';
          } catch { /* skip stats */ }
        } else {
          try {
            const stats = statSync(itemPath);
            entry.modified = stats.mtime.toISOString();
          } catch { /* skip */ }
        }

        entries.push(entry);
      }
    } catch (err) {
      log.error(`Failed to list files at ${reqPath}: ${(err as Error).message}`);
    }

    return { entries, path: reqPath };
  }

  private readFile(reqPath: string): Record<string, unknown> {
    try {
      const cleanPath = reqPath.replace(/^\/+/, '');
      const fullPath = join(this.nas.getBasePath(), cleanPath);
      this.assertPathWithinNas(fullPath);

      if (!existsSync(fullPath)) {
        throw new Error(`File not found: ${reqPath}`);
      }

      const stats = statSync(fullPath);

      // Safety: Don't read files larger than 1MB
      if (stats.size > 1_048_576) {
        return {
          path: reqPath,
          content: `[File too large to preview: ${(stats.size / 1024 / 1024).toFixed(1)}MB]`,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          encoding: 'utf-8',
        };
      }

      const content = readFileSync(fullPath, 'utf-8');

      return {
        path: reqPath,
        content,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        encoding: 'utf-8',
      };
    } catch (err) {
      throw new Error(`Cannot read file: ${(err as Error).message}`);
    }
  }

  // ==========================================================================
  // MESSAGING CHANNELS — WhatsApp, Telegram, Discord
  // Inspired by OpenClaw multi-channel architecture
  // ==========================================================================

  // --- Channel Config (delegated to channels/config.ts) ---

  private getChannelConfig(channel: string): Record<string, unknown> {
    return _getChannelConfig(this.nas, channel);
  }

  private setChannelConfig(channel: string, updates: Record<string, unknown>): { success: boolean; config: Record<string, unknown> } {
    return _setChannelConfig(this.nas, channel, updates);
  }

  // --- Channel Messages (delegated to channels/config.ts) ---

  private getChannelMessages(channel: string, limit: number): { messages: Array<Record<string, unknown>> } {
    return _getChannelMessages(this.nas, channel, limit);
  }

  private appendChannelMessage(channel: string, message: Record<string, unknown>): void {
    _appendChannelMessage(this.nas, channel, message);
  }

  // --- WhatsApp (Baileys — QR Code Login) ---

  // Baileys socket and login state
  private slackWs: WebSocket | null = null;
  private slackWsConnected = false;
  private slackWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private waSocket: ReturnType<typeof import('@whiskeysockets/baileys').makeWASocket> | null = null;
  private waConnected = false;
  private waQrDataUrl: string | null = null;
  private waLoginResolvers: Array<(value: { connected: boolean; message: string }) => void> = [];
  private waSelfJid: string | null = null;
  /** Maps WhatsApp session IDs to JIDs for routing agent responses back via WhatsApp */
  private waActiveChats = new Map<string, string>();

  private getWhatsAppAuthDir(): string {
    const dir = this.nas.resolve('whatsapp-auth');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  private getWhatsAppStatus(): {
    connected: boolean;
    loggedIn: boolean;
    selfJid: string | null;
    qrPending: boolean;
    message: string;
  } {
    const authDir = this.getWhatsAppAuthDir();
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

  private async startWhatsAppLogin(force = false): Promise<{ qrDataUrl: string | null; message: string }> {
    log.info('WhatsApp login: starting QR flow...');

    // Stop existing socket
    if (this.waSocket) {
      try { this.waSocket.end(undefined); } catch { /* */ }
      this.waSocket = null;
      this.waConnected = false;
    }

    // If force, clear auth
    if (force) {
      const authDir = this.getWhatsAppAuthDir();
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

    const authDir = this.getWhatsAppAuthDir();
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
            // Convert QR string to base64 PNG data URL
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
          this.protocol.broadcast('whatsapp.connected', {
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
          this.protocol.broadcast('whatsapp.disconnected', { statusCode, timestamp: Date.now() });

          if (statusCode === reason.loggedOut) {
            // Logged out — clear auth
            log.info('WhatsApp: Logged out, clearing credentials');
            this.waSocket = null;
            this.waSelfJid = null;
          } else if (statusCode === 515 || statusCode === reason.restartRequired) {
            // Restart required after pairing — auto-reconnect
            log.info('WhatsApp: Restart required, reconnecting...');
            setTimeout(() => this.connectWhatsApp(), 2000);
          } else {
            // Other disconnect — auto-reconnect after delay
            log.info('WhatsApp: Will reconnect in 5s...');
            setTimeout(() => this.connectWhatsApp(), 5000);
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
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const from = msg.key.remoteJid ?? '';
          // Skip status/broadcast
          if (from === 'status@broadcast' || from.endsWith('@broadcast')) continue;

          // Extract text
          const text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || '';
          if (!text) continue;

          // Extract sender name
          const pushName = msg.pushName ?? from.split('@')[0];

          const incomingMsg = {
            id: msg.key.id ?? `wa-${Date.now()}`,
            from,
            fromName: pushName,
            to: 'jarvis',
            body: text,
            timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
            direction: 'incoming' as const,
            status: 'read' as const,
            type: 'text' as const,
          };

          this.appendChannelMessage('whatsapp', incomingMsg);
          this.protocol.broadcast('whatsapp.message', incomingMsg);
          log.info(`WhatsApp from ${pushName}: "${text.substring(0, 80)}"`);

          // Auto-reply if enabled — route to agent for full computer control
          const config = this.getChannelConfig('whatsapp');
          if (config.jarvisMode) {
            const lang = (config.autoReplyLanguage as string) ?? 'pl';

            if (text.startsWith('/')) {
              // Quick commands handled locally
              const reply = await this.handleChannelCommand(text, lang);
              await this.sendWhatsAppMessage({ to: from, message: reply });
            } else {
              // Route to agent via NATS chat — same as dashboard, gives full computer control
              const sessionId = `whatsapp-${from.split('@')[0]}`;
              // Evict oldest entry if the map has reached its size cap
              if (this.waActiveChats.size >= 10_000 && !this.waActiveChats.has(sessionId)) {
                const oldestKey = this.waActiveChats.keys().next().value;
                if (oldestKey !== undefined) this.waActiveChats.delete(oldestKey);
              }
              this.waActiveChats.set(sessionId, from);

              const chatMsg: ChatMessage = {
                id: shortId(),
                from: 'user',
                to: 'jarvis',
                content: `[WhatsApp from ${pushName}]: ${text}`,
                timestamp: Date.now(),
                metadata: { source: 'whatsapp', whatsappJid: from, sessionId, language: lang },
              };

              this.persistChatMessage(sessionId, chatMsg);
              await this.nats.publish(NatsSubjects.chat('jarvis'), { ...chatMsg, sessionId });
              this.protocol.broadcast('chat.message', chatMsg);
              log.info(`WhatsApp → jarvis: "${text.substring(0, 80)}" (session: ${sessionId})`);
            }
          }
        }
      });

      // If we already have creds, this socket will connect without QR
      // Check if connection opens quickly (no QR needed)
      const credsPath = join(authDir, 'creds.json');
      if (existsSync(credsPath)) {
        // Already logged in — socket should connect without QR
        setTimeout(() => {
          if (!qrReceived && this.waConnected) {
            clearTimeout(timeout);
            resolveLogin({
              qrDataUrl: null,
              message: `Already connected as ${this.waSelfJid}`,
            });
          } else if (!qrReceived && !this.waConnected) {
            // Wait a bit longer for connection
          }
        }, 5000);
      }
    });
  }

  private async connectWhatsApp(): Promise<void> {
    const authDir = this.getWhatsAppAuthDir();
    const credsPath = join(authDir, 'creds.json');
    if (!existsSync(credsPath)) {
      log.info('WhatsApp: No credentials found, skipping auto-connect');
      return;
    }

    // Only connect if not already connected
    if (this.waConnected) return;

    log.info('WhatsApp: Auto-connecting with saved credentials...');
    await this.startWhatsAppLogin(false);
  }

  private async waitWhatsAppLogin(): Promise<{ connected: boolean; message: string }> {
    if (this.waConnected) {
      return { connected: true, message: `Already connected as ${this.waSelfJid}` };
    }

    return new Promise((resolve) => {
      this.waLoginResolvers.push(resolve);
      // Timeout after 120 seconds
      setTimeout(() => {
        const idx = this.waLoginResolvers.indexOf(resolve);
        if (idx !== -1) {
          this.waLoginResolvers.splice(idx, 1);
          resolve({ connected: false, message: 'Scan timeout (120s). Try again.' });
        }
      }, 120000);
    });
  }

  private async logoutWhatsApp(): Promise<{ success: boolean; message: string }> {
    try {
      if (this.waSocket) {
        try { await (this.waSocket as any).logout(); } catch { /* */ }
        try { this.waSocket.end(undefined); } catch { /* */ }
        this.waSocket = null;
      }
      this.waConnected = false;
      this.waSelfJid = null;
      this.waQrDataUrl = null;

      // Clear auth files
      const authDir = this.getWhatsAppAuthDir();
      try {
        const files = readdirSync(authDir);
        for (const file of files) {
          try { unlinkSync(join(authDir, file)); } catch { /* */ }
        }
      } catch { /* */ }

      log.info('WhatsApp: Logged out and cleared credentials');
      this.protocol.broadcast('whatsapp.disconnected', { reason: 'logout', timestamp: Date.now() });
      return { success: true, message: 'Logged out successfully. Scan QR to reconnect.' };
    } catch (err) {
      return { success: false, message: `Logout failed: ${(err as Error).message}` };
    }
  }

  private async sendWhatsAppMessage(params: { to: string; message: string }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.waSocket || !this.waConnected) {
      return { success: false, error: 'WhatsApp not connected. Login via QR code first.' };
    }

    // Convert phone number to JID if needed
    let jid = params.to;
    if (!jid.includes('@')) {
      // Clean number and add WhatsApp suffix
      const cleaned = jid.replace(/[\s\-+()]/g, '');
      jid = `${cleaned}@s.whatsapp.net`;
    }

    try {
      const result = await (this.waSocket as any).sendMessage(jid, { text: params.message });
      const msgId = result?.key?.id ?? `wa-${Date.now()}`;

      // Save to history
      this.appendChannelMessage('whatsapp', {
        id: msgId,
        from: 'jarvis',
        to: jid,
        body: params.message,
        timestamp: Date.now(),
        direction: 'outgoing',
        status: 'sent',
        type: 'text',
      });

      this.protocol.broadcast('whatsapp.sent', { to: jid, message: params.message, timestamp: Date.now() });
      return { success: true, messageId: msgId };
    } catch (err) {
      log.error(`WhatsApp send error: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message };
    }
  }

  private async handleWhatsAppWebhook(_body: Record<string, unknown>): Promise<void> {
    // Legacy webhook handler — no longer needed with Baileys (messages come via socket events)
    // Kept as no-op for backward compatibility
    log.debug('WhatsApp webhook called (legacy — Baileys handles messages via socket)');
  }

  // --- Telegram ---

  private getTelegramStatus(): { connected: boolean; botToken: boolean; chatId: string } {
    const config = this.getChannelConfig('telegram');
    return {
      connected: !!(config.botToken),
      botToken: !!(config.botToken),
      chatId: (config.chatId as string) ?? '',
    };
  }

  private async sendTelegramMessage(params: { chatId: string; message: string }): Promise<{ success: boolean; error?: string }> {
    const config = this.getChannelConfig('telegram');
    const botToken = config.botToken as string;

    if (!botToken) {
      return { success: false, error: 'Telegram not configured. Set Bot Token.' };
    }

    const chatId = params.chatId || (config.chatId as string);
    if (!chatId) {
      return { success: false, error: 'No chat ID specified' };
    }

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: params.message,
            parse_mode: 'Markdown',
          }),
        }
      );

      const result = await response.json() as Record<string, unknown>;

      if (result.ok) {
        this.appendChannelMessage('telegram', {
          id: `tg-out-${Date.now()}`,
          from: 'jarvis',
          to: chatId,
          body: params.message,
          timestamp: Date.now(),
          direction: 'outgoing',
          status: 'sent',
          type: 'text',
        });

        this.protocol.broadcast('telegram.sent', { chatId, message: params.message, timestamp: Date.now() });
        return { success: true };
      }

      return { success: false, error: (result.description as string) ?? 'Unknown error' };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async handleTelegramWebhook(body: Record<string, unknown>): Promise<void> {
    const message = body.message as Record<string, unknown>;
    if (!message) return;

    const from = message.from as Record<string, unknown>;
    const chat = message.chat as Record<string, unknown>;
    const text = message.text as string;
    if (!text || !chat) return;

    const chatId = String(chat.id);
    const username = (from?.username as string) ?? (from?.first_name as string) ?? chatId;

    const incomingMsg = {
      id: `tg-in-${message.message_id ?? Date.now()}`,
      from: username,
      fromId: chatId,
      to: 'jarvis',
      body: text,
      timestamp: Date.now(),
      direction: 'incoming' as const,
      status: 'read' as const,
      type: 'text' as const,
    };

    this.appendChannelMessage('telegram', incomingMsg);
    this.protocol.broadcast('telegram.message', incomingMsg);

    log.info(`Telegram message from ${username}: "${text.substring(0, 80)}"`);

    // Auto-reply
    const config = this.getChannelConfig('telegram');
    if (config.jarvisMode) {
      const lang = (config.autoReplyLanguage as string) ?? 'pl';
      let reply: string;

      if (text.startsWith('/')) {
        reply = await this.handleChannelCommand(text, lang);
      } else {
        const processed = await this.processVoiceMessage({ message: text, language: lang });
        reply = processed.reply;
      }

      await this.sendTelegramMessage({ chatId, message: reply });
    }
  }

  // --- Discord ---

  private getDiscordStatus(): { connected: boolean; hasToken: boolean; guildId: string } {
    const config = this.getChannelConfig('discord');
    return {
      connected: !!(config.botToken || config.webhookUrl),
      hasToken: !!(config.botToken),
      guildId: (config.guildId as string) ?? '',
    };
  }

  private async sendDiscordMessage(params: { channelId: string; message: string }): Promise<{ success: boolean; error?: string }> {
    const config = this.getChannelConfig('discord');

    // Try webhook first (simpler)
    const webhookUrl = config.webhookUrl as string;
    if (webhookUrl) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: params.message,
            username: 'Jarvis',
            avatar_url: 'https://i.imgur.com/AfFp7pu.png',
          }),
        });

        if (response.ok || response.status === 204) {
          this.appendChannelMessage('discord', {
            id: `dc-out-${Date.now()}`,
            from: 'jarvis',
            to: params.channelId || 'webhook',
            body: params.message,
            timestamp: Date.now(),
            direction: 'outgoing',
            status: 'sent',
            type: 'text',
          });
          return { success: true };
        }
        return { success: false, error: `Discord webhook returned ${response.status}` };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }

    // Try bot API
    const botToken = config.botToken as string;
    const channelId = params.channelId || (config.channelId as string);
    if (!botToken || !channelId) {
      return { success: false, error: 'Discord not configured. Set Bot Token + Channel ID or Webhook URL.' };
    }

    try {
      const response = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: params.message }),
        }
      );

      const result = await response.json() as Record<string, unknown>;

      if (response.ok) {
        this.appendChannelMessage('discord', {
          id: (result.id as string) ?? `dc-out-${Date.now()}`,
          from: 'jarvis',
          to: channelId,
          body: params.message,
          timestamp: Date.now(),
          direction: 'outgoing',
          status: 'sent',
          type: 'text',
        });
        return { success: true };
      }

      return { success: false, error: (result.message as string) ?? 'Unknown error' };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async handleDiscordWebhook(body: Record<string, unknown>): Promise<void> {
    // Discord interactions/events
    const content = body.content as string;
    const author = body.author as Record<string, unknown>;
    if (!content || !author) return;

    const username = (author.username as string) ?? 'unknown';

    const incomingMsg = {
      id: (body.id as string) ?? `dc-in-${Date.now()}`,
      from: username,
      to: 'jarvis',
      body: content,
      timestamp: Date.now(),
      direction: 'incoming' as const,
      status: 'read' as const,
      type: 'text' as const,
    };

    this.appendChannelMessage('discord', incomingMsg);
    this.protocol.broadcast('discord.message', incomingMsg);

    log.info(`Discord message from ${username}: "${content.substring(0, 80)}"`);

    const config = this.getChannelConfig('discord');
    if (config.jarvisMode) {
      const lang = (config.autoReplyLanguage as string) ?? 'pl';
      let reply: string;

      if (content.startsWith('/') || content.startsWith('!')) {
        reply = await this.handleChannelCommand(content, lang);
      } else {
        const processed = await this.processVoiceMessage({ message: content, language: lang });
        reply = processed.reply;
      }

      const channelId = (body.channel_id as string) ?? (config.channelId as string);
      if (channelId) {
        await this.sendDiscordMessage({ channelId, message: reply });
      }
    }
  }

  // --- Unified Channel Helpers ---

  private listChannels(): Array<{
    id: string;
    name: string;
    type: string;
    connected: boolean;
    messageCount: number;
    lastActivity?: number;
  }> {
    const channels: Array<{
      id: string;
      name: string;
      type: string;
      connected: boolean;
      messageCount: number;
      lastActivity?: number;
    }> = [];

    for (const channel of ['whatsapp', 'telegram', 'discord', 'slack', 'imessage'] as const) {
      const config = this.getChannelConfig(channel);
      const msgs = this.getChannelMessages(channel, 1);
      const lastMsg = msgs.messages[0];

      let connected = false;
      if (channel === 'whatsapp') connected = this.waConnected;
      else if (channel === 'telegram') connected = !!(config.botToken);
      else if (channel === 'discord') connected = !!(config.botToken || config.webhookUrl);
      else if (channel === 'slack') connected = this.slackWsConnected || !!(config.botToken);
      else if (channel === 'imessage') connected = process.platform === 'darwin';

      // Read a reasonable upper bound of messages for counting (avoid loading huge files)
      const allMsgs = this.getChannelMessages(channel, 10_000);

      channels.push({
        id: channel,
        name: channel.charAt(0).toUpperCase() + channel.slice(1),
        type: 'messaging',
        connected,
        messageCount: allMsgs.messages.length,
        lastActivity: (lastMsg?.timestamp as number) ?? undefined,
      });
    }

    return channels;
  }

  private getChannelsStatus(): Record<string, { connected: boolean; config: Record<string, unknown> }> {
    const result: Record<string, { connected: boolean; config: Record<string, unknown> }> = {};
    for (const channel of ['whatsapp', 'telegram', 'discord', 'slack', 'imessage']) {
      const config = this.getChannelConfig(channel);
      let connected = false;
      if (channel === 'whatsapp') connected = this.waConnected;
      else if (channel === 'telegram') connected = !!(config.botToken);
      else if (channel === 'discord') connected = !!(config.botToken || config.webhookUrl);
      else if (channel === 'slack') connected = this.slackWsConnected || !!(config.botToken);
      else if (channel === 'imessage') connected = process.platform === 'darwin';
      result[channel] = { connected, config: { ...config, accessToken: config.accessToken ? '***' : '', botToken: config.botToken ? '***' : '', appToken: config.appToken ? '***' : '', signingSecret: config.signingSecret ? '***' : '' } };
    }
    return result;
  }

  // --- Slack ---

  private getSlackStatus(): Record<string, unknown> {
    const config = this.getChannelConfig('slack');
    const mode = (config.mode as string) ?? 'socket';
    const socketConnected = this.slackWsConnected;
    const httpConfigured = !!(config.signingSecret);
    return {
      connected: mode === 'socket' ? socketConnected : (httpConfigured && !!(config.botToken)),
      botToken: !!(config.botToken),
      appToken: !!(config.appToken),
      signingSecret: !!(config.signingSecret),
      workspace: (config.workspace as string) ?? '',
      mode,
      socketConnected,
      channels: (config.channels as number) ?? 0,
    };
  }

  private async sendSlackMessage(channel: string, message: string): Promise<Record<string, unknown>> {
    const config = this.getChannelConfig('slack');
    const botToken = config.botToken as string;
    if (!botToken) {
      return { success: false, error: 'Slack bot token not configured' };
    }

    try {
      // Use Slack Web API directly (no SDK dependency needed)
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: channel || config.defaultChannel || '#general',
          text: message,
        }),
      });
      const data = await response.json() as Record<string, unknown>;

      if (data.ok) {
        // Persist message
        this.appendChannelMessage('slack', {
          id: (data.ts as string) ?? shortId(),
          channel,
          user: 'jarvis',
          text: message,
          timestamp: Date.now(),
          direction: 'out',
        });
        this.protocol.broadcast('slack.message', {
          id: data.ts, channel, user: 'jarvis',
          text: message, timestamp: Date.now(), direction: 'out',
        });
        return { success: true, ts: data.ts };
      } else {
        return { success: false, error: data.error as string };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async handleSlackWebhook(body: Record<string, unknown>): Promise<void> {
    const event = body.event as Record<string, unknown> | undefined;
    if (!event || event.type !== 'message') return;

    // Ignore bot messages to prevent loops
    if (event.bot_id || event.subtype === 'bot_message') return;
    // Ignore message edits/deletes/etc. — only handle plain new messages
    if (event.subtype && event.subtype !== 'file_share') return;

    const text = (event.text as string) ?? '';
    const user = (event.user as string) ?? 'unknown';
    const channel = (event.channel as string) ?? '';
    const ts = (event.ts as string) ?? '';
    const files = event.files as Array<Record<string, unknown>> | undefined;

    // Determine message type
    let msgType: 'text' | 'image' | 'video' | 'file' = 'text';
    const fileUrls: string[] = [];
    if (files && files.length > 0) {
      for (const f of files) {
        const mimetype = (f.mimetype as string) ?? '';
        if (mimetype.startsWith('image/')) msgType = 'image';
        else if (mimetype.startsWith('video/')) msgType = 'video';
        else msgType = 'file';
        const url = (f.url_private as string) ?? (f.permalink as string) ?? '';
        if (url) fileUrls.push(url);
      }
    }

    const bodyText = text || (fileUrls.length > 0 ? `[${msgType}: ${fileUrls.join(', ')}]` : '');
    if (!bodyText) return;

    const incomingMsg = {
      id: ts || `slack-in-${Date.now()}`,
      from: user,
      fromId: user,
      to: 'jarvis',
      body: bodyText,
      channel,
      timestamp: Date.now(),
      direction: 'incoming' as const,
      status: 'read' as const,
      type: msgType,
      files: fileUrls.length > 0 ? fileUrls : undefined,
    };

    this.appendChannelMessage('slack', incomingMsg);
    this.protocol.broadcast('slack.message', incomingMsg);

    log.info(`Slack message from ${user} in ${channel}: "${bodyText.substring(0, 80)}"`);

    // Auto-reply if jarvisMode enabled
    const config = this.getChannelConfig('slack');
    if (config.jarvisMode) {
      const lang = (config.autoReplyLanguage as string) ?? 'pl';
      let reply: string;

      if (text.startsWith('/') || text.startsWith('!')) {
        reply = await this.handleChannelCommand(text, lang);
      } else {
        const processed = await this.processVoiceMessage({ message: text, language: lang });
        reply = processed.reply;
      }

      await this.sendSlackMessage(channel, reply);
    }
  }

  private async connectSlackSocketMode(botToken: string, appToken: string): Promise<void> {
    // Clean up existing connection
    this.disconnectSlackSocketMode();

    // Step 1: Get a WebSocket URL via apps.connections.open
    const openRes = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const openData = await openRes.json() as Record<string, unknown>;
    if (!openData.ok || !openData.url) {
      throw new Error(`apps.connections.open failed: ${openData.error ?? 'unknown error'}`);
    }

    const wsUrl = openData.url as string;
    log.info('Slack Socket Mode: connecting...');

    // Step 2: Open WebSocket
    const ws = new (await import('ws')).default(wsUrl);
    this.slackWs = ws as unknown as WebSocket;

    ws.on('open', () => {
      this.slackWsConnected = true;
      log.info('Slack Socket Mode: connected');
      this.protocol.broadcast('slack.status', this.getSlackStatus());
    });

    ws.on('message', async (raw: Buffer | string) => {
      try {
        const envelope = JSON.parse(raw.toString()) as Record<string, unknown>;

        // Acknowledge the envelope immediately (required by Socket Mode)
        if (envelope.envelope_id) {
          ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        }

        const envelopeType = envelope.type as string;

        if (envelopeType === 'events_api') {
          const payload = envelope.payload as Record<string, unknown>;
          if (payload) {
            await this.handleSlackWebhook(payload);
          }
        } else if (envelopeType === 'slash_commands') {
          // Handle slash commands from Socket Mode
          const payload = envelope.payload as Record<string, unknown>;
          const text = (payload?.text as string) ?? '';
          const channelId = (payload?.channel_id as string) ?? '';
          if (text && channelId) {
            const config = this.getChannelConfig('slack');
            const lang = (config.autoReplyLanguage as string) ?? 'pl';
            const reply = await this.handleChannelCommand(`/${text}`, lang);
            await this.sendSlackMessage(channelId, reply);
          }
        }
        // 'hello' and 'disconnect' types are silently handled
      } catch (err) {
        log.error('Slack Socket Mode message error', { error: String(err) });
      }
    });

    ws.on('close', (code: number) => {
      this.slackWsConnected = false;
      this.slackWs = null;
      log.warn(`Slack Socket Mode: disconnected (code=${code})`);
      this.protocol.broadcast('slack.status', this.getSlackStatus());

      // Auto-reconnect after 5s unless explicitly disconnected
      if (!this.slackWsReconnectTimer) {
        this.slackWsReconnectTimer = setTimeout(async () => {
          this.slackWsReconnectTimer = null;
          const cfg = this.getChannelConfig('slack');
          const bt = cfg.botToken as string;
          const at = cfg.appToken as string;
          if (bt && at) {
            log.info('Slack Socket Mode: reconnecting...');
            try {
              await this.connectSlackSocketMode(bt, at);
            } catch (err) {
              log.error('Slack Socket Mode reconnect failed', { error: String(err) });
            }
          }
        }, 5000);
      }
    });

    ws.on('error', (err: Error) => {
      log.error('Slack Socket Mode WebSocket error', { error: err.message });
    });
  }

  private disconnectSlackSocketMode(): void {
    if (this.slackWsReconnectTimer) {
      clearTimeout(this.slackWsReconnectTimer);
      this.slackWsReconnectTimer = null;
    }
    if (this.slackWs) {
      try { this.slackWs.close(); } catch { /* ignore */ }
      this.slackWs = null;
    }
    this.slackWsConnected = false;
  }

  // --- iMessage (macOS only) ---

  private async sendIMessage(to: string, message: string): Promise<Record<string, unknown>> {
    if (process.platform !== 'darwin') {
      return { success: false, error: 'iMessage is only available on macOS' };
    }

    try {
      // Use osascript to send iMessage
      const escapedMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const escapedTo = to.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${escapedTo}" of targetService
  send "${escapedMsg}" to targetBuddy
end tell`;

      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000 });

      // Persist message
      this.appendChannelMessage('imessage', {
        id: shortId(),
        channel: to,
        user: 'jarvis',
        text: message,
        timestamp: Date.now(),
        direction: 'out',
      });
      this.protocol.broadcast('imessage.message', {
        id: shortId(), channel: to, user: 'jarvis',
        text: message, timestamp: Date.now(), direction: 'out',
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // --- iMessage via AppleScript + Contacts ---

  private async runAppleScript(script: string): Promise<string> {
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024 * 5,
    });
    return stdout.trim();
  }

  private async getIMessageConversations(limit: number): Promise<Record<string, unknown>> {
    if (process.platform !== 'darwin') return { conversations: [], error: 'macOS only' };
    try {
      const cap = Math.min(limit, 80);
      const dbPath = join(process.env['HOME'] ?? '', 'Library/Messages/chat.db');
      const contactMap = await this.getContactsMap();

      // Query chat.db for recent conversations with their last message
      const sql = `
SELECT
  c.guid,
  c.chat_identifier,
  COALESCE(c.display_name, '') as display_name,
  COALESCE(
    NULLIF(m.text, ''),
    CASE
      WHEN m.attributedBody IS NOT NULL AND instr(m.attributedBody, X'012B') > 0 THEN
        CASE
          WHEN hex(substr(m.attributedBody, instr(m.attributedBody, X'012B') + 2, 1)) <> '81'
          THEN CAST(substr(m.attributedBody, instr(m.attributedBody, X'012B') + 3,
               instr(substr(m.attributedBody, instr(m.attributedBody, X'012B') + 3), X'8684') - 1) AS TEXT)
          ELSE CAST(substr(m.attributedBody, instr(m.attributedBody, X'012B') + 5,
               instr(substr(m.attributedBody, instr(m.attributedBody, X'012B') + 5), X'8684') - 1) AS TEXT)
        END
      ELSE ''
    END,
    ''
  ) as last_text,
  m.is_from_me as last_from_me,
  CAST((m.date / 1000000000 + 978307200) AS INTEGER) as last_unix_ts,
  m.cache_has_attachments as last_has_attachment,
  COALESCE(
    (SELECT GROUP_CONCAT(h2.id, ';')
     FROM chat_handle_join chj
     JOIN handle h2 ON h2.ROWID = chj.handle_id
     WHERE chj.chat_id = c.ROWID), ''
  ) as handles,
  (SELECT COUNT(*) FROM chat_message_join cmj2
   JOIN message m2 ON m2.ROWID = cmj2.message_id
   WHERE cmj2.chat_id = c.ROWID AND m2.associated_message_type = 0) as msg_count
FROM chat c
JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
JOIN message m ON m.ROWID = cmj.message_id
WHERE m.ROWID = (
  SELECT cmj3.message_id
  FROM chat_message_join cmj3
  JOIN message m3 ON m3.ROWID = cmj3.message_id
  WHERE cmj3.chat_id = c.ROWID AND m3.associated_message_type = 0
  ORDER BY m3.date DESC LIMIT 1
)
ORDER BY m.date DESC
LIMIT ${cap};`;

      const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024 * 4,
      });

      const rows = JSON.parse(stdout || '[]') as Array<Record<string, unknown>>;
      const conversations = rows.map((row) => {
        const guid = String(row['guid'] ?? '');
        const chatIdentifier = String(row['chat_identifier'] ?? '');
        const displayNameRaw = String(row['display_name'] ?? '');
        const lastText = String(row['last_text'] ?? '');
        const lastFromMe = row['last_from_me'] === 1;
        const lastUnixTs = Number(row['last_unix_ts'] ?? 0) * 1000;
        const lastHasAttachment = row['last_has_attachment'] === 1;
        const handlesStr = String(row['handles'] ?? '');
        const msgCount = Number(row['msg_count'] ?? 0);

        const handleList = handlesStr.split(';').filter(Boolean);
        const primaryHandle = handleList[0] || chatIdentifier || '';

        let displayName = displayNameRaw;
        if (!displayName || displayName === 'missing value') {
          displayName = contactMap.get(primaryHandle) || primaryHandle;
        }

        const lastMessage = lastText || (lastHasAttachment ? '[Attachment]' : '');

        return {
          chatId: guid,
          displayName,
          handle: primaryHandle,
          handles: handleList,
          lastMessage,
          lastMessageDate: lastUnixTs ? new Date(lastUnixTs).toISOString() : '',
          lastFromMe,
          messageCount: msgCount,
          unreadCount: 0,
        };
      }).filter((c) => c.chatId && c.handle);

      return { conversations };
    } catch (err) {
      log.warn('chat.db conversations query failed, falling back to AppleScript', { error: String(err) });
      // Fallback to original AppleScript approach
      return this.getIMessageConversationsFallback(limit);
    }
  }

  private async getIMessageConversationsFallback(limit: number): Promise<Record<string, unknown>> {
    const cap = Math.min(limit, 80);
    const script = `
tell application "Messages"
  set output to ""
  set chatCount to count of chats
  if chatCount > ${cap} then set chatCount to ${cap}
  repeat with i from 1 to chatCount
    set aChat to chat i
    set chatId to id of aChat
    set chatName to ""
    try
      set chatName to name of aChat
    end try
    if chatName is missing value then set chatName to ""
    set chatHandles to ""
    try
      set pList to participants of aChat
      repeat with p in pList
        set chatHandles to chatHandles & (handle of p) & ";"
      end repeat
    end try
    set output to output & chatId & "|||" & chatName & "|||" & chatHandles & linefeed
  end repeat
  return output
end tell`;
    const raw = await this.runAppleScript(script);
    if (!raw) return { conversations: [] };

    const contactMap = await this.getContactsMap();
    const conversations = raw.split('\n').filter(Boolean).map((line) => {
      const [chatId, chatName, handles] = line.split('|||');
      const handleList = (handles || '').split(';').filter(Boolean);
      const primaryHandle = handleList[0] || chatId?.replace('any;-;', '') || '';
      let displayName = chatName || '';
      if (!displayName || displayName === 'missing value') {
        displayName = contactMap.get(primaryHandle) || primaryHandle;
      }
      return {
        chatId: chatId || '',
        displayName,
        handle: primaryHandle,
        handles: handleList,
        lastMessage: '',
        lastMessageDate: '',
        lastFromMe: false,
        messageCount: 0,
        unreadCount: 0,
      };
    }).filter((c) => c.chatId && c.handle);

    return { conversations };
  }

  private async getContactsMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const script = `
tell application "Contacts"
  set output to ""
  repeat with p in people
    set pName to name of p
    repeat with ph in phones of p
      set output to output & (value of ph) & "|||" & pName & linefeed
    end repeat
    repeat with em in emails of p
      set output to output & (value of em) & "|||" & pName & linefeed
    end repeat
  end repeat
  return output
end tell`;
      const raw = await this.runAppleScript(script);
      if (raw) {
        for (const line of raw.split('\n').filter(Boolean)) {
          const [handle, name] = line.split('|||');
          if (handle && name) {
            // Store normalized + raw
            map.set(handle.trim(), name.trim());
            const norm = handle.replace(/[\s\-()]/g, '');
            map.set(norm, name.trim());
          }
        }
      }
    } catch { /* Contacts.app not available */ }
    return map;
  }

  private async getIMessageConversation(chatId: string, limit: number): Promise<Record<string, unknown>> {
    if (process.platform !== 'darwin') return { messages: [], error: 'macOS only' };
    if (!chatId) return { messages: [], error: 'chatId required' };

    const handle = chatId.replace('any;-;', '').replace('any;+;', '');
    const cap = Math.min(Math.max(limit, 1), 200);
    const dbPath = join(process.env['HOME'] ?? '', 'Library/Messages/chat.db');

    try {
      // Query chat.db for messages in this conversation (both incoming + outgoing)
      // Apple epoch offset: 978307200 seconds between Unix epoch and 2001-01-01
      // Extract text: prefer m.text, fall back to attributedBody blob parsing
      // attributedBody is NSArchiver typedstream: header ends with 0x012B,
      // then length byte (<0x80 = 1 byte, 0x81 = 2-byte LE follows), then UTF-8 text, then 0x8684
      const sql = `
SELECT
  m.ROWID,
  COALESCE(
    NULLIF(m.text, ''),
    CASE
      WHEN m.attributedBody IS NOT NULL AND instr(m.attributedBody, X'012B') > 0 THEN
        CASE
          WHEN hex(substr(m.attributedBody, instr(m.attributedBody, X'012B') + 2, 1)) <> '81'
          THEN CAST(substr(m.attributedBody, instr(m.attributedBody, X'012B') + 3,
               instr(substr(m.attributedBody, instr(m.attributedBody, X'012B') + 3), X'8684') - 1) AS TEXT)
          ELSE CAST(substr(m.attributedBody, instr(m.attributedBody, X'012B') + 5,
               instr(substr(m.attributedBody, instr(m.attributedBody, X'012B') + 5), X'8684') - 1) AS TEXT)
        END
      ELSE ''
    END,
    ''
  ) as text,
  m.is_from_me,
  CAST((m.date / 1000000000 + 978307200) AS INTEGER) as unix_ts,
  m.cache_has_attachments,
  m.associated_message_type,
  COALESCE(h.id, '') as sender_handle,
  COALESCE(
    (SELECT GROUP_CONCAT(a.filename || '<<>>' || COALESCE(a.mime_type, ''), '<<SEP>>')
     FROM message_attachment_join maj
     JOIN attachment a ON a.ROWID = maj.attachment_id
     WHERE maj.message_id = m.ROWID), ''
  ) as attachments
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
WHERE m.ROWID IN (
  SELECT cmj.message_id
  FROM chat_message_join cmj
  JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE c.guid = '${chatId.replace(/'/g, "''")}'
     OR c.chat_identifier = '${handle.replace(/'/g, "''")}'
)
AND m.associated_message_type = 0
AND (m.text IS NOT NULL AND length(m.text) > 0 OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
ORDER BY m.date DESC
LIMIT ${cap};`;

      const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024 * 4,
      });

      const rows = JSON.parse(stdout || '[]') as Array<Record<string, unknown>>;
      const messages = rows.map((row) => {
        const rowId = String(row['ROWID'] ?? '');
        const rawText = String(row['text'] ?? '');
        const isFromMe = row['is_from_me'] === 1;
        const unixTs = Number(row['unix_ts'] ?? 0) * 1000;
        const hasAttachment = row['cache_has_attachments'] === 1;
        const senderHandle = String(row['sender_handle'] ?? '');
        const attachmentsRaw = String(row['attachments'] ?? '');

        // Parse attachments
        const attachmentList: Array<{ filename: string; mimeType: string }> = [];
        if (attachmentsRaw) {
          for (const entry of attachmentsRaw.split('<<SEP>>')) {
            const [filename, mimeType] = entry.split('<<>>');
            if (filename) attachmentList.push({ filename: filename.replace(/^~/, process.env['HOME'] ?? ''), mimeType: mimeType ?? '' });
          }
        }

        // Strip U+FFFC (object replacement character) used as attachment placeholder in iMessage
        const text = rawText.replace(/\uFFFC/g, '').trim();

        let type: 'text' | 'image' | 'video' | 'audio' | 'file' = 'text';
        if (attachmentList.length > 0) {
          const mime = attachmentList[0].mimeType;
          if (mime.startsWith('image/')) type = 'image';
          else if (mime.startsWith('video/')) type = 'video';
          else if (mime.startsWith('audio/')) type = 'audio';
          else type = 'file';
        } else if (hasAttachment) {
          type = 'file';
        }

        return {
          id: rowId,
          text,
          isFromMe,
          date: unixTs ? new Date(unixTs).toISOString().replace('T', ' ').slice(0, 19) : '',
          timestamp: unixTs,
          sender: isFromMe ? 'jarvis' : (senderHandle || handle),
          hasAttachment,
          type,
          attachments: attachmentList.length > 0 ? attachmentList : undefined,
        };
      }).filter((m) => m.text || m.hasAttachment).reverse(); // filter empty messages, oldest first

      return { messages, chatId, handle };
    } catch (err) {
      log.warn('chat.db query failed, falling back to JSONL', { error: String(err) });
      // Fallback to JSONL store
      const jarvisMessages = this.getChannelMessages('imessage', 500);
      const msgList = (jarvisMessages as { messages: Array<{ id: string; channel: string; text: string; timestamp: number; direction: string }> }).messages ?? [];
      const messages = msgList
        .filter((m) => m.channel === handle)
        .map((m) => ({
          id: m.id || '',
          text: m.text || '',
          isFromMe: m.direction === 'out',
          date: new Date(m.timestamp).toISOString().replace('T', ' ').slice(0, 19),
          timestamp: m.timestamp,
          sender: m.direction === 'out' ? 'jarvis' : m.channel,
          hasAttachment: false,
          type: 'text' as const,
        }));
      return { messages, chatId, handle };
    }
  }

  private async searchIMessages(query: string, limit: number): Promise<Record<string, unknown>> {
    if (process.platform !== 'darwin') return { results: [], error: 'macOS only' };
    if (!query) return { results: [], error: 'query required' };

    const cap = Math.min(Math.max(limit, 1), 100);
    const dbPath = join(process.env['HOME'] ?? '', 'Library/Messages/chat.db');
    const escapedQuery = query.replace(/'/g, "''");

    try {
      const sql = `
SELECT
  COALESCE(m.text, '') as text,
  m.is_from_me,
  COALESCE(h.id, '') as sender_handle,
  COALESCE(c.guid, '') as chat_guid,
  COALESCE(c.display_name, h.id, '') as display_name,
  CAST((m.date / 1000000000 + 978307200) AS INTEGER) as unix_ts
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.text LIKE '%${escapedQuery}%'
  AND m.associated_message_type = 0
ORDER BY m.date DESC
LIMIT ${cap};`;

      const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024 * 4,
      });

      const rows = JSON.parse(stdout || '[]') as Array<Record<string, unknown>>;
      const results = rows.map((row) => {
        const unixTs = Number(row['unix_ts'] ?? 0);
        return {
          text: String(row['text'] ?? ''),
          isFromMe: row['is_from_me'] === 1,
          contact: String(row['sender_handle'] ?? ''),
          chatId: String(row['chat_guid'] ?? ''),
          displayName: String(row['display_name'] ?? '') || String(row['sender_handle'] ?? ''),
          date: unixTs ? new Date(unixTs * 1000).toISOString().replace('T', ' ').slice(0, 19) : '',
        };
      });

      return { results };
    } catch (err) {
      log.warn('chat.db search failed', { error: String(err) });
      return { results: [], error: (err as Error).message };
    }
  }

  private async getIMessageContacts(): Promise<Record<string, unknown>> {
    if (process.platform !== 'darwin') return { contacts: [], error: 'macOS only' };
    try {
      const script = `
tell application "Contacts"
  set output to ""
  repeat with p in people
    set pName to name of p
    set pPhones to ""
    repeat with ph in phones of p
      set pPhones to pPhones & (value of ph) & ";"
    end repeat
    set pEmails to ""
    repeat with em in emails of p
      set pEmails to pEmails & (value of em) & ";"
    end repeat
    set output to output & pName & "|||" & pPhones & "|||" & pEmails & linefeed
  end repeat
  return output
end tell`;
      const raw = await this.runAppleScript(script);
      if (!raw) return { contacts: [] };

      const contacts = raw.split('\n').filter(Boolean).map((line) => {
        const [name, phones, emails] = line.split('|||');
        return {
          name: name?.trim() || '',
          phones: (phones || '').split(';').filter(Boolean).map((p) => p.trim()),
          emails: (emails || '').split(';').filter(Boolean).map((e) => e.trim()),
        };
      }).filter((c) => c.name && (c.phones.length > 0 || c.emails.length > 0));

      return { contacts };
    } catch (err) {
      return { contacts: [], error: (err as Error).message };
    }
  }

  // persistChannelMessage and getChannelMessages consolidated above (JSONL format)

  // --- Channel Command Handler ---

  private async handleChannelCommand(text: string, lang: string): Promise<string> {
    const cmd = text.replace(/^[/!]/, '').trim().toLowerCase();
    const parts = cmd.split(/\s+/);
    const command = parts[0];

    const isPl = lang === 'pl';

    switch (command) {
      case 'status': {
        const health = await this.getHealthStatus();
        const agents = health.agents as Array<{ id: string; status: string; role: string }>;
        const agentList = agents.map((a) => `${a.id.replace('agent-', '')}: ${a.status}`).join(', ');
        return isPl
          ? `System: ${health.status}. Uptime: ${formatDuration(health.uptime as number)}. Agenci: ${agentList}. Infra: NATS=${health.infrastructure.nats ? 'OK' : 'DOWN'}, Redis=${health.infrastructure.redis ? 'OK' : 'DOWN'}`
          : `System: ${health.status}. Uptime: ${formatDuration(health.uptime as number)}. Agents: ${agentList}. Infra: NATS=${health.infrastructure.nats ? 'OK' : 'DOWN'}, Redis=${health.infrastructure.redis ? 'OK' : 'DOWN'}`;
      }

      case 'agents': {
        const agents = await this.store.getAllAgentStates();
        const list = agents.map((a) => `${a.identity.agentId} [${a.identity.role}]: ${a.status}`).join('\n');
        return isPl ? `Agenci:\n${list}` : `Agents:\n${list}`;
      }

      case 'tasks': {
        const tasks = await this.store.getPendingTasks();
        if (tasks.length === 0) return isPl ? 'Brak oczekujących tasków.' : 'No pending tasks.';
        const list = tasks.slice(0, 5).map((t) => `• ${t.title ?? t.id}`).join('\n');
        return isPl ? `Taski (${tasks.length}):\n${list}` : `Tasks (${tasks.length}):\n${list}`;
      }

      case 'task': {
        const taskText = parts.slice(1).join(' ');
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
        await this.store.createTask(taskDef as any);
        await this.assignTask(taskDef as any);
        return isPl ? `Task utworzony: ${taskDef.id}` : `Task created: ${taskDef.id}`;
      }

      case 'help': {
        return isPl
          ? 'Komendy:\n/status — stan systemu\n/agents — lista agentów\n/tasks — oczekujące taski\n/task <opis> — utwórz task\n/help — ta wiadomość\n\nMożesz też napisać normalnie — Jarvis odpowie.'
          : 'Commands:\n/status — system health\n/agents — list agents\n/tasks — pending tasks\n/task <desc> — create task\n/help — this message\n\nYou can also write normally — Jarvis will reply.';
      }

      default:
        return isPl ? `Nieznana komenda: /${command}. Wpisz /help.` : `Unknown command: /${command}. Type /help.`;
    }
  }

  // --- Skills ---

  private getSkillsList(): { skills: Array<Record<string, unknown>> } {
    const configPath = this.nas.resolve('config', 'skills.json');
    try {
      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, 'utf-8'));
      }
    } catch { /* ignore */ }
    return { skills: [] };
  }

  private toggleSkill(skillId: string): { success: boolean } {
    const configPath = this.nas.resolve('config', 'skills.json');
    let data = this.getSkillsList();
    const skill = data.skills.find((s) => s.id === skillId);
    if (skill) {
      skill.enabled = !skill.enabled;
    } else {
      data.skills.push({ id: skillId, installed: true, enabled: true });
    }
    try {
      const configDir = this.nas.resolve('config');
      if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify(data, null, 2));
      return { success: true };
    } catch { return { success: false }; }
  }

  private installSkill(skillId: string): { success: boolean } {
    const configPath = this.nas.resolve('config', 'skills.json');
    let data = this.getSkillsList();
    const existing = data.skills.find((s) => s.id === skillId);
    if (existing) {
      existing.installed = true;
      existing.enabled = true;
    } else {
      data.skills.push({ id: skillId, installed: true, enabled: true, installedAt: new Date().toISOString() });
    }
    try {
      const configDir = this.nas.resolve('config');
      if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify(data, null, 2));
      log.info(`Skill installed: ${skillId}`);
      return { success: true };
    } catch { return { success: false }; }
  }

  // --- Model Providers ---

  private getProvidersConfig(): Record<string, unknown> {
    const configPath = this.nas.resolve('config', 'providers.json');
    try {
      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, 'utf-8'));
      }
    } catch { /* ignore */ }

    // Return defaults based on env vars
    return {
      providers: [
        {
          id: 'anthropic', name: 'Anthropic', type: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: process.env['ANTHROPIC_API_KEY'] ? '***' : '',
          enabled: !!process.env['ANTHROPIC_API_KEY'],
          priority: 1,
        },
        {
          id: 'openai', name: 'OpenAI', type: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: process.env['OPENAI_API_KEY'] ? '***' : '',
          enabled: !!process.env['OPENAI_API_KEY'],
          priority: 2,
        },
      ],
      chains: [
        {
          id: 'default', name: 'Default Chain',
          description: 'Primary model with fallback',
          models: ['claude-sonnet-4-6', 'gpt-5.2'],
          active: true,
        },
      ],
      activeModel: process.env['DEFAULT_MODEL'] ?? 'claude-sonnet-4-6',
    };
  }

  private setProvidersConfig(params: Record<string, unknown>): { success: boolean } {
    const configPath = this.nas.resolve('config', 'providers.json');
    try {
      const configDir = this.nas.resolve('config');
      if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify(params, null, 2));
      log.info('Providers config updated');
      return { success: true };
    } catch (err) {
      log.error('Failed to save providers config', { error: String(err) });
      return { success: false };
    }
  }

  // --- Chat Persistence ---

  private persistChatMessage(sessionId: string, msg: ChatMessage): void {
    try {
      this.assertSafeSessionId(sessionId);
      const chatDir = this.nas.resolve('chat');
      if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true });

      const sessionFile = join(chatDir, `${sessionId}.jsonl`);
      const line = JSON.stringify({
        ...msg,
        sessionId,
      }) + '\n';
      appendFileSync(sessionFile, line, 'utf-8');
    } catch {
      // Non-critical: log but don't fail
    }
  }

  private getChatHistory(sessionId: string, limit: number): ChatMessage[] {
    try {
      this.assertSafeSessionId(sessionId);
      const sessionFile = join(this.nas.resolve('chat'), `${sessionId}.jsonl`);
      if (!existsSync(sessionFile)) return [];

      const content = readFileSync(sessionFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const messages = lines
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean) as ChatMessage[];

      // Return last N messages
      return messages.slice(-limit);
    } catch {
      return [];
    }
  }

  private getChatSessions(): Array<Record<string, unknown>> {
    try {
      const chatDir = this.nas.resolve('chat');
      if (!existsSync(chatDir)) return [];

      const files = readdirSync(chatDir).filter((f) => f.endsWith('.jsonl'));
      const sessions: Array<Record<string, unknown>> = [];

      for (const file of files) {
        try {
          const filePath = join(chatDir, file);
          const stat = statSync(filePath);
          const content = readFileSync(filePath, 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);
          const lastMsg = lines.length > 0
            ? ((): ChatMessage | null => { try { return JSON.parse(lines[lines.length - 1]); } catch { return null; } })()
            : null;
          const firstMsg = lines.length > 0
            ? ((): ChatMessage | null => { try { return JSON.parse(lines[0]); } catch { return null; } })()
            : null;

          const sessionId = file.replace('.jsonl', '');

          // Generate title from first user message
          const firstUserLine = lines.find((l) => {
            try { const m = JSON.parse(l); return m.from === 'user'; } catch { return false; }
          });
          let title = sessionId;
          if (firstUserLine) {
            try {
              const m = JSON.parse(firstUserLine);
              title = (m.content as string)?.substring(0, 50) || sessionId;
            } catch { /* keep default */ }
          }

          sessions.push({
            id: sessionId,
            title,
            createdAt: firstMsg?.timestamp ?? stat.birthtimeMs,
            updatedAt: lastMsg?.timestamp ?? stat.mtimeMs,
            messageCount: lines.length,
            preview: lastMsg?.content?.substring(0, 80) ?? '',
          });
        } catch { /* skip corrupt files */ }
      }

      // Sort newest first
      sessions.sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number));
      return sessions;
    } catch {
      return [];
    }
  }

  private deleteChatSession(sessionId: string): { success: boolean } {
    try {
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session ID');
      const sessionFile = this.nas.resolve('chat', `${sessionId}.jsonl`);
      if (existsSync(sessionFile)) unlinkSync(sessionFile);
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  // --- Memory & Knowledge ---

  private getMemoryStatus(): Record<string, unknown> {
    const knowledgeDir = this.nas.resolve('knowledge');
    const memoryDir = join(knowledgeDir, 'memory');
    const entriesDir = join(knowledgeDir, 'entries');
    const memoryFile = join(knowledgeDir, 'MEMORY.md');

    let coreLines = 0;
    let coreSize = 0;
    if (existsSync(memoryFile)) {
      const s = statSync(memoryFile);
      coreSize = s.size;
      coreLines = readFileSync(memoryFile, 'utf-8').split('\n').length;
    }

    let dailyCount = 0;
    if (existsSync(memoryDir)) {
      dailyCount = readdirSync(memoryDir).filter(f => f.endsWith('.md')).length;
    }

    let entryCount = 0;
    if (existsSync(entriesDir)) {
      entryCount = readdirSync(entriesDir).filter(f => f.endsWith('.json')).length;
    }

    return {
      coreMemory: { file: 'MEMORY.md', lines: coreLines, sizeBytes: coreSize },
      dailyNotes: { count: dailyCount, directory: 'knowledge/memory/' },
      knowledgeEntries: { count: entryCount, directory: 'knowledge/entries/' },
      backend: 'file-based',
      searchType: 'keyword + TF-IDF',
    };
  }

  private searchMemory(query: string, maxResults: number): { results: Array<Record<string, unknown>>; total: number } {
    const queryLower = query.toLowerCase();
    const results: Array<Record<string, unknown>> = [];
    const knowledgeDir = this.nas.resolve('knowledge');
    const memoryDir = join(knowledgeDir, 'memory');
    const memoryFile = join(knowledgeDir, 'MEMORY.md');

    // Search MEMORY.md
    if (existsSync(memoryFile)) {
      const content = readFileSync(memoryFile, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(queryLower)) {
          results.push({ source: 'MEMORY.md', line: i + 1, text: lines[i].trim(), type: 'core' });
        }
      }
    }

    // Search daily notes
    if (existsSync(memoryDir)) {
      const files = readdirSync(memoryDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 60);
      for (const file of files) {
        try {
          const content = readFileSync(join(memoryDir, file), 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(queryLower)) {
              results.push({ source: file, line: i + 1, text: lines[i].trim(), type: 'daily' });
            }
          }
        } catch { /* skip */ }
      }
    }

    // Search knowledge entries
    const entriesDir = join(knowledgeDir, 'entries');
    if (existsSync(entriesDir)) {
      const entryFiles = readdirSync(entriesDir).filter(f => f.endsWith('.json'));
      for (const file of entryFiles) {
        try {
          const entry = JSON.parse(readFileSync(join(entriesDir, file), 'utf-8'));
          const searchable = `${entry.title} ${entry.content} ${(entry.tags || []).join(' ')}`.toLowerCase();
          if (searchable.includes(queryLower)) {
            results.push({ source: `entry:${entry.id}`, text: entry.title, content: entry.content?.slice(0, 200), type: 'entry', tags: entry.tags });
          }
        } catch { /* skip */ }
      }
    }

    return { results: results.slice(0, maxResults), total: results.length };
  }

  private readMemoryFile(file: string): { content: string; file: string; lines: number; sizeBytes: number } | { error: string } {
    const safeName = file.replace(/^\//, '');
    const knowledgeDir = this.nas.resolve('knowledge');
    let filePath: string;

    if (safeName === 'MEMORY.md') {
      filePath = join(knowledgeDir, 'MEMORY.md');
    } else {
      filePath = join(knowledgeDir, 'memory', safeName);
    }

    // Validate resolved path stays within knowledge directory
    const resolvedPath = resolve(filePath);
    const resolvedKnowledgeDir = resolve(knowledgeDir);
    if (!resolvedPath.startsWith(resolvedKnowledgeDir + '/') && resolvedPath !== resolvedKnowledgeDir) {
      return { error: 'Invalid file path: path traversal detected' };
    }

    if (!existsSync(filePath)) {
      return { error: `File not found: ${safeName}` };
    }

    const content = readFileSync(filePath, 'utf-8');
    const stat = statSync(filePath);
    return { content, file: safeName, lines: content.split('\n').length, sizeBytes: stat.size };
  }

  private saveMemory(content: string, category: 'core' | 'daily'): { success: boolean; file: string; message: string } {
    const knowledgeDir = this.nas.resolve('knowledge');
    const memoryDir = join(knowledgeDir, 'memory');
    const memoryFile = join(knowledgeDir, 'MEMORY.md');
    const timestamp = new Date().toISOString();

    try {
      if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

      if (category === 'daily') {
        const dateStr = new Date().toISOString().split('T')[0];
        const dailyPath = join(memoryDir, `${dateStr}.md`);
        const header = existsSync(dailyPath) ? '' : `# Daily Notes: ${dateStr}\n\n`;
        const entry = `${header}## ${timestamp}\n${content}\n\n`;
        const existing = existsSync(dailyPath) ? readFileSync(dailyPath, 'utf-8') : '';
        writeFileSync(dailyPath, existing + entry);
        return { success: true, file: `${dateStr}.md`, message: `Saved to daily note ${dateStr}` };
      } else {
        const entry = `\n## [${timestamp}]\n${content}\n`;
        const existing = existsSync(memoryFile) ? readFileSync(memoryFile, 'utf-8') : '# MEMORY\n\nLong-term memory for Jarvis 2.0.\n';
        writeFileSync(memoryFile, existing + entry);
        return { success: true, file: 'MEMORY.md', message: 'Saved to core memory' };
      }
    } catch (err) {
      log.error('Failed to save memory', { error: String(err) });
      return { success: false, file: '', message: 'Failed to save memory entry' };
    }
  }

  private listMemoryFiles(): { files: Array<{ name: string; type: string; sizeBytes: number; modifiedAt: string }> } {
    const knowledgeDir = this.nas.resolve('knowledge');
    const memoryDir = join(knowledgeDir, 'memory');
    const memoryFile = join(knowledgeDir, 'MEMORY.md');
    const files: Array<{ name: string; type: string; sizeBytes: number; modifiedAt: string }> = [];

    if (existsSync(memoryFile)) {
      const s = statSync(memoryFile);
      files.push({ name: 'MEMORY.md', type: 'core', sizeBytes: s.size, modifiedAt: s.mtime.toISOString() });
    }

    if (existsSync(memoryDir)) {
      const daily = readdirSync(memoryDir).filter(f => f.endsWith('.md')).sort().reverse();
      for (const f of daily) {
        try {
          const s = statSync(join(memoryDir, f));
          files.push({ name: f, type: 'daily', sizeBytes: s.size, modifiedAt: s.mtime.toISOString() });
        } catch { /* skip */ }
      }
    }

    return { files };
  }

  private deleteMemoryFile(file: string): { success: boolean } {
    if (file === 'MEMORY.md') return { success: false };
    // Only allow safe filenames (no path separators, no traversal)
    if (!/^[a-zA-Z0-9_.\-]+$/.test(file)) return { success: false };
    const memoryDir = this.nas.resolve('knowledge', 'memory');
    const filePath = join(memoryDir, file);
    // Verify the resolved path stays within the memory directory
    const resolvedPath = resolve(filePath);
    const resolvedMemoryDir = resolve(memoryDir);
    if (!resolvedPath.startsWith(resolvedMemoryDir + '/')) return { success: false };
    try {
      if (existsSync(filePath)) { unlinkSync(filePath); return { success: true }; }
      return { success: false };
    } catch { return { success: false }; }
  }

  private getKnowledgeEntries(query?: string, limit = 50): { entries: Array<Record<string, unknown>>; total: number } {
    const entriesDir = this.nas.resolve('knowledge', 'entries');
    if (!existsSync(entriesDir)) {
      try { mkdirSync(entriesDir, { recursive: true }); } catch { /* */ }
      return { entries: [], total: 0 };
    }

    const files = readdirSync(entriesDir).filter(f => f.endsWith('.json'));
    const entries: Array<Record<string, unknown>> = [];

    for (const file of files) {
      try {
        const entry = JSON.parse(readFileSync(join(entriesDir, file), 'utf-8'));
        if (query) {
          const searchable = `${entry.title} ${entry.content} ${(entry.tags || []).join(' ')}`.toLowerCase();
          if (!searchable.includes(query.toLowerCase())) continue;
        }
        entries.push(entry);
      } catch { /* skip corrupt */ }
    }

    entries.sort((a, b) => ((b.updatedAt as number) || 0) - ((a.updatedAt as number) || 0));
    return { entries: entries.slice(0, limit), total: entries.length };
  }

  private saveKnowledgeEntry(params: { title: string; content: string; tags: string[]; source: string }): { success: boolean; id: string } {
    const entriesDir = this.nas.resolve('knowledge', 'entries');
    try {
      if (!existsSync(entriesDir)) mkdirSync(entriesDir, { recursive: true });
      const id = `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const entry = { id, title: params.title, content: params.content, tags: params.tags, source: params.source, agentId: 'dashboard', createdAt: Date.now(), updatedAt: Date.now() };
      writeFileSync(join(entriesDir, `${id}.json`), JSON.stringify(entry, null, 2));
      log.info(`Knowledge entry saved: ${id} - ${params.title}`);
      return { success: true, id };
    } catch (err) {
      log.error('Failed to save knowledge entry', { error: String(err) });
      return { success: false, id: '' };
    }
  }

  private deleteKnowledgeEntry(id: string): { success: boolean } {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = join(this.nas.resolve('knowledge', 'entries'), `${safeId}.json`);
    try {
      if (existsSync(filePath)) { unlinkSync(filePath); return { success: true }; }
      return { success: false };
    } catch { return { success: false }; }
  }

  // --- Exec Approvals (Human-in-the-loop) ---

  private pendingApprovals: Array<{
    id: string;
    agentId: string;
    tool: string;
    params: Record<string, unknown>;
    reason: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    createdAt: number;
    expiresAt: number;
  }> = [];

  private approvalHistory: Array<{
    id: string;
    agentId: string;
    tool: string;
    reason: string;
    riskLevel: string;
    decision: 'approved' | 'denied';
    decidedAt: number;
    denyReason?: string;
  }> = [];

  private approvalResolvers = new Map<string, (approved: boolean, reason?: string) => void>();

  /** Called by agents when they need approval for a risky tool execution */
  requestApproval(agentId: string, tool: string, params: Record<string, unknown>, reason: string, riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'medium'): Promise<{ approved: boolean; reason?: string }> {
    const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const approval = {
      id,
      agentId,
      tool,
      params,
      reason,
      riskLevel,
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000, // 5 minute timeout
    };

    this.pendingApprovals.push(approval);
    this.protocol.broadcast('approval.requested', approval);
    log.info(`Approval requested: ${id} — ${agentId} wants to run ${tool}`);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Auto-deny on timeout
        this.resolveApproval(id, false, 'Timed out — no human response within 5 minutes');
      }, 300_000);

      this.approvalResolvers.set(id, (approved, denyReason) => {
        clearTimeout(timer);
        resolve({ approved, reason: denyReason });
      });
    });
  }

  private resolveApproval(approvalId: string, approved: boolean, reason?: string): { success: boolean } {
    const idx = this.pendingApprovals.findIndex(a => a.id === approvalId);
    if (idx === -1) return { success: false };

    const approval = this.pendingApprovals[idx];
    this.pendingApprovals.splice(idx, 1);

    // Save to history (cap in-memory array to prevent unbounded growth)
    this.approvalHistory.push({
      id: approval.id,
      agentId: approval.agentId,
      tool: approval.tool,
      reason: approval.reason,
      riskLevel: approval.riskLevel,
      decision: approved ? 'approved' : 'denied',
      decidedAt: Date.now(),
      denyReason: reason,
    });
    if (this.approvalHistory.length > 1000) {
      this.approvalHistory = this.approvalHistory.slice(-500);
    }

    // Persist history to NAS
    try {
      const historyPath = this.nas.resolve('config', 'approval-history.json');
      writeFileSync(historyPath, JSON.stringify(this.approvalHistory.slice(-500), null, 2));
    } catch { /* ignore */ }

    // Broadcast result
    this.protocol.broadcast('approval.resolved', {
      approvalId: approval.id,
      agentId: approval.agentId,
      tool: approval.tool,
      approved,
      reason,
    });

    // Resolve the promise for the waiting agent
    const resolver = this.approvalResolvers.get(approvalId);
    if (resolver) {
      resolver(approved, reason);
      this.approvalResolvers.delete(approvalId);
    }

    log.info(`Approval ${approved ? 'APPROVED' : 'DENIED'}: ${approvalId} — ${approval.tool}`);
    return { success: true };
  }

  private getApprovalConfig(): Record<string, unknown> {
    const configPath = this.nas.resolve('config', 'approvals.json');
    try {
      if (existsSync(configPath)) return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch { /* */ }
    return {
      enabled: true,
      autoApprove: ['memory_search', 'memory_save', 'web_search', 'weather'],
      requireApproval: ['exec_command', 'file_delete', 'ssh_exec', 'browser_navigate', 'send_message'],
      alwaysDeny: [],
      timeoutSeconds: 300,
      soundAlert: true,
      desktopNotification: true,
    };
  }

  private setApprovalConfig(config: Record<string, unknown>): { success: boolean } {
    const configPath = this.nas.resolve('config', 'approvals.json');
    try {
      const configDir = this.nas.resolve('config');
      if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      return { success: true };
    } catch { return { success: false }; }
  }

  // --- OTA Update System ---

  private startUpdateChecker(): void {
    // Check immediately on startup (after a short delay for connections to settle)
    setTimeout(() => void this.checkForUpdates(), 30_000);
    // Then every 5 minutes
    this.updateCheckInterval = setInterval(() => {
      void this.checkForUpdates();
    }, 5 * 60 * 1000);
  }

  /** Resolve the source repo dir — prefer ~/Documents/Jarvis-2.0/jarvis (git repo), fallback to bundle parent */
  private resolveSourceRepo(): string {
    const home = process.env['HOME'] ?? '/Users/kamilpadula';
    const candidates = [
      resolve(home, 'Documents/Jarvis-2.0/jarvis'),
      resolve(home, 'jarvis'),
    ];
    for (const c of candidates) {
      if (existsSync(resolve(c, '.git'))) return c;
    }
    // Fallback to bundle-relative (won't work for git ops but won't crash)
    return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  }

  private async checkForUpdates(): Promise<{ available: boolean; commitsBehind: number; latestCommit: string; latestMessage: string; localHead: string; remoteHead: string }> {
    const projectDir = this.resolveSourceRepo();
    try {
      // Fetch latest from origin (non-destructive)
      execSync('git fetch origin', { cwd: projectDir, timeout: 30_000, stdio: 'pipe' });

      // Get current branch
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectDir, stdio: 'pipe' }).toString().trim();

      // Compare HEAD vs origin/branch
      const localHead = execSync('git rev-parse HEAD', { cwd: projectDir, stdio: 'pipe' }).toString().trim();
      const remoteHead = execSync(`git rev-parse origin/${branch}`, { cwd: projectDir, stdio: 'pipe' }).toString().trim();

      if (localHead === remoteHead) {
        this.updateAvailable = null;
        return { available: false, commitsBehind: 0, latestCommit: '', latestMessage: '', localHead, remoteHead };
      }

      // Count commits behind
      const behindStr = execSync(`git rev-list --count HEAD..origin/${branch}`, { cwd: projectDir, stdio: 'pipe' }).toString().trim();
      const commitsBehind = parseInt(behindStr, 10) || 0;

      // Get latest commit info from remote
      const latestCommit = remoteHead.slice(0, 8);
      const latestMessage = execSync(`git log -1 --format=%s origin/${branch}`, { cwd: projectDir, stdio: 'pipe' }).toString().trim();

      this.updateAvailable = { commitsBehind, latestCommit, latestMessage, localHead: localHead.slice(0, 8), remoteHead: remoteHead.slice(0, 8) };

      log.info(`Update available: ${commitsBehind} commit(s) behind — ${latestMessage}`);

      // Broadcast to all dashboard clients
      this.protocol.broadcast('system.update.available', this.updateAvailable);

      return { available: true, commitsBehind, latestCommit, latestMessage, localHead: localHead.slice(0, 8), remoteHead: remoteHead.slice(0, 8) };
    } catch (err) {
      log.warn('Update check failed', { error: (err as Error).message });
      return { available: false, commitsBehind: 0, latestCommit: '', latestMessage: '', localHead: '', remoteHead: '' };
    }
  }

  private applyUpdate(): { started: boolean; error?: string } {
    if (this.updateInProgress) {
      return { started: false, error: 'Update already in progress' };
    }

    const projectDir = this.resolveSourceRepo();
    const updateScript = resolve(projectDir, 'scripts/jarvis-update.sh');

    if (!existsSync(updateScript)) {
      return { started: false, error: 'Update script not found' };
    }

    this.updateInProgress = true;

    // Broadcast that update is starting
    this.protocol.broadcast('system.update.started', {
      timestamp: Date.now(),
      message: 'Pulling latest changes and rebuilding...',
    });

    log.info('Spawning OTA update trampoline script...');

    // Spawn detached — this process outlives the gateway
    const child = spawn('bash', [updateScript], {
      cwd: projectDir,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    return { started: true };
  }

  private getUpdateStatus(): { status: string; message: string; prevHead: string; newHead: string; timestamp: number } | null {
    const statusFile = '/tmp/jarvis-update-status.json';
    try {
      if (!existsSync(statusFile)) return null;
      const raw = readFileSync(statusFile, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private broadcastUpdateStatusOnRestart(): void {
    const statusFile = '/tmp/jarvis-update-status.json';
    if (!existsSync(statusFile)) return;

    try {
      const raw = readFileSync(statusFile, 'utf-8');
      const status = JSON.parse(raw) as { status: string; message: string; prevHead: string; newHead: string; timestamp: number };

      // Wait for dashboard clients to reconnect before broadcasting
      setTimeout(() => {
        if (status.status === 'done') {
          log.info('Post-update broadcast: update completed successfully');
          this.protocol.broadcast('system.update.completed', status);
        } else if (status.status === 'error') {
          log.warn('Post-update broadcast: update failed', { message: status.message });
          this.protocol.broadcast('system.update.failed', status);
        }

        // Clean up status file
        try { unlinkSync(statusFile); } catch { /* ignore */ }
        this.updateInProgress = false;
        this.updateAvailable = null;
      }, 5000);
    } catch (err) {
      log.warn('Failed to read update status file', { error: (err as Error).message });
    }
  }

  // --- Health Data Helper (for voice/channel responses) ---

  private async getHealthData(): Promise<{ status: string; uptime: number }> {
    try {
      const h = await this.getHealthStatus();
      return { status: h.status as string, uptime: h.uptime as number };
    } catch {
      return { status: 'unknown', uptime: 0 };
    }
  }
}

// Module-level helpers moved to ./utils.ts
