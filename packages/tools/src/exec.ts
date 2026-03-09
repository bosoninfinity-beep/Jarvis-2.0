/**
 * Exec Tool — OpenClaw-inspired shell execution with:
 * - Auto-backgrounding for long-running commands (yieldMs)
 * - Security tiers (deny, allowlist, full)
 * - Safe bins with argv profiles
 * - Environment injection and PATH prepend
 * - PTY support for interactive processes
 * - Background session management
 */

import { spawn } from 'node:child_process';
import { createLogger, getAuditLogger } from '@jarvis/shared';
import type { AgentTool, ToolContext, ToolResult } from './base.js';
import { createToolResult, createErrorResult } from './base.js';

const log = createLogger('tool:exec');

const MAX_OUTPUT_SIZE = 100_000; // 100KB max output
const DEFAULT_TIMEOUT = 120_000; // 2 minutes
const DEFAULT_YIELD_MS = 10_000; // Auto-background after 10s (OpenClaw default)
const SESSION_TAIL_SIZE = 3_000; // chars of output to show for in-progress sessions
const SESSION_CLEANUP_MS = 5 * 60 * 1000; // 5 minutes before cleaning up finished sessions
const SESSION_PARTIAL_PREVIEW = 2_000; // chars of partial output in auto-background message

// ─── Security Configuration ───────────────────────────────────────────

export type SecurityMode = 'deny' | 'allowlist' | 'full';

export interface ExecSecurityConfig {
  /** Security mode: deny (block all), allowlist (approved only), full (allow all) */
  mode: SecurityMode;
  /** Allowlisted command patterns (regex strings) */
  allowlist?: string[];
  /** Safe binaries that bypass allowlist (stdin-only stream filters) */
  safeBins?: string[];
  /** Directories where safe bins are trusted */
  safeBinTrustedDirs?: string[];
  /** Blocked destructive command patterns */
  blockedPatterns?: RegExp[];
  /** PATH directories to prepend */
  pathPrepend?: string[];
}

const DEFAULT_BLOCKED_PATTERNS = [
  // Destructive file operations (with escape/alias bypass prevention)
  /(?:^|[;&|`$\(])\s*(?:\\)?r(?:\\)?m\s+.*-[a-z]*r[a-z]*f/i,
  /(?:^|[;&|`$\(])\s*(?:\\)?r(?:\\)?m\s+-rf\s+\//,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /:()\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bsystemctl\s+(stop|disable|mask)\s+/i,
  /\blaunchctl\s+(unload|bootout)\b/i,
  // Pipe to shell (curl/wget download & execute)
  /\b(?:curl|wget)\b.*\|\s*(?:ba)?sh\b/i,
  /\b(?:curl|wget)\b.*\|\s*(?:z|k|c|fi|da|tc)?sh\b/i,
  // Dangerous eval/exec
  /\beval\s+/,
  /\bexec\s+[^-]/,
  // Inline code execution in scripting languages
  /\bpython[23]?\s+-c\b/i,
  /\bnode\s+-e\b/i,
  /\bruby\s+-e\b/i,
  /\bperl\s+-e\b/i,
  // Fork bombs and resource exhaustion
  /\bfork\s*\(\s*\)/,
  /while\s+true.*do.*done/i,
  // Reverse shells
  /\/dev\/(tcp|udp)\//i,
  /\bmkfifo\b/i,
  /\bnc\s+.*-[a-z]*e\b/i,
  // Privilege escalation
  /\bchmod\s+[0-7]*s/i,
  /\bchmod\s+4755\b/,
  // History/credential theft
  /\.bash_history/,
  /\.ssh\/id_/,
  /\.gnupg\//,
  /\/etc\/shadow/,
];

const DEFAULT_SAFE_BINS = [
  'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep', 'awk', 'sed',
  'cut', 'tr', 'tee', 'xargs', 'jq', 'yq', 'less', 'more',
];

const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'USER', 'SHELL',
  'LOGNAME', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DISPLAY', 'COLORTERM',
  'EDITOR', 'VISUAL', 'PAGER', 'LESS', 'HOSTNAME',
]);

const BLOCKED_ENV_PATTERNS = [
  /_API_KEY$/i, /_SECRET$/i, /_TOKEN$/i, /_PASSWORD$/i,
  /^NATS_/i, /^REDIS_/i, /^ANTHROPIC_/i, /^OPENAI_/i,
  /^GOOGLE_/i, /^SLACK_/i, /^DISCORD_/i, /^SPOTIFY_/i,
  /^HASS_/i, /^AWS_/i, /^AZURE_/i, /^GCP_/i,
];

function filterEnvVars(): Record<string, string> {
  const env: Record<string, string> = {};

  // Add all safe env vars first
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key] as string;
    }
  }

  // Add remaining env vars that don't match blocked patterns
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_KEYS.has(key)) continue; // Already added
    if (value === undefined) continue;
    const isBlocked = BLOCKED_ENV_PATTERNS.some(pattern => pattern.test(key));
    if (!isBlocked) {
      env[key] = value;
    }
  }

  // Always force TERM to dumb
  env['TERM'] = 'dumb';

  return env;
}

// ─── Background Sessions ─────────────────────────────────────────────

interface BackgroundSession {
  id: string;
  command: string;
  pid: number;
  startedAt: number;
  output: string;
  exitCode: number | null;
  finished: boolean;
}

const backgroundSessions = new Map<string, BackgroundSession>();

// ─── Exec Tool ────────────────────────────────────────────────────────

export class ExecTool implements AgentTool {
  private security: ExecSecurityConfig;

  constructor(securityConfig?: Partial<ExecSecurityConfig>) {
    this.security = {
      mode: securityConfig?.mode ?? 'allowlist',
      allowlist: securityConfig?.allowlist ?? [],
      safeBins: securityConfig?.safeBins ?? DEFAULT_SAFE_BINS,
      safeBinTrustedDirs: securityConfig?.safeBinTrustedDirs ?? ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'],
      blockedPatterns: securityConfig?.blockedPatterns ?? DEFAULT_BLOCKED_PATTERNS,
      pathPrepend: securityConfig?.pathPrepend ?? [],
    };
  }

  definition = {
    name: 'exec',
    description: [
      'Execute a shell command. Returns stdout and stderr.',
      'Use for running build commands, scripts, git operations, package managers, etc.',
      '',
      'Features:',
      '- Auto-backgrounds commands that exceed yieldMs (default: 10s)',
      '- Background sessions can be checked with background=true + sessionId',
      '- Environment overrides via env parameter',
      '- Working directory via cwd parameter',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (defaults to agent workspace)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 120000, max: 1800000)',
        },
        env: {
          type: 'object',
          description: 'Environment variable overrides (key-value pairs)',
          additionalProperties: { type: 'string' },
        },
        background: {
          type: 'boolean',
          description: 'Run command in background immediately. Returns session ID.',
        },
        yieldMs: {
          type: 'number',
          description: 'Auto-background after this many ms if still running (default: 10000). Set 0 to disable.',
        },
        sessionId: {
          type: 'string',
          description: 'Check status of a background session by ID',
        },
      },
      required: ['command'],
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Check background session status
    if (params['sessionId']) {
      return this.checkSession(params['sessionId'] as string);
    }

    const command = params['command'] as string;
    const cwd = (params['cwd'] as string) || context.cwd || context.workspacePath;
    const timeout = Math.min((params['timeout'] as number) || DEFAULT_TIMEOUT, 1_800_000);
    const envOverrides = (params['env'] as Record<string, string>) || {};
    const background = params['background'] as boolean;
    const yieldMs = params['yieldMs'] !== undefined ? (params['yieldMs'] as number) : DEFAULT_YIELD_MS;

    if (!command) return createErrorResult('Missing required parameter: command');

    // ─── Security checks ───

    // Blocked patterns (always checked regardless of mode)
    for (const pattern of this.security.blockedPatterns ?? []) {
      if (pattern.test(command)) {
        log.warn(`Blocked dangerous command: ${command.slice(0, 100)}`);
        getAuditLogger().logEvent('security.blocked_command', 'exec-tool', {
          command: command.slice(0, 500),
          pattern: pattern.toString(),
          agentId: context.agentId,
        });
        return createErrorResult(`Blocked dangerous command pattern. This command is not allowed for safety reasons.`);
      }
    }

    // Security mode checks
    if (this.security.mode === 'deny') {
      // In deny mode, block any command chaining (pipes/semicolons/&&/||) and only allow safe bins
      if (/[;&|`$()]/.test(command)) {
        return createErrorResult('Exec security mode is \'deny\'. Command chaining (;, &, |, etc.) is not allowed.');
      }
      const bin = command.trim().split(/\s+/)[0] ?? '';
      if (!this.isSafeBin(bin)) {
        return createErrorResult(`Exec security mode is 'deny'. Only safe bins are allowed: ${this.security.safeBins?.join(', ')}`);
      }
    } else if (this.security.mode === 'allowlist') {
      // In allowlist mode, also check for command chaining that could bypass the allowlist
      const hasChaining = /[;&`]|\|\||\$\(/.test(command);
      const bin = command.trim().split(/\s+/)[0] ?? '';
      const isAllowed = this.security.allowlist?.some(pattern => new RegExp(pattern).test(command)) ?? false;
      const isSafe = this.isSafeBin(bin);
      if (hasChaining && !isAllowed) {
        return createErrorResult('Command chaining detected. In allowlist mode, chained commands must match an allowlist pattern.');
      }
      if (!isAllowed && !isSafe) {
        return createErrorResult(`Command not in allowlist. Add to exec security allowlist or use a safe bin.`);
      }
    }
    // mode === 'full' — allow everything (still blocked patterns checked)

    getAuditLogger().logEvent('exec.command', 'exec-tool', {
      command: command.slice(0, 500),
      mode: this.security.mode,
      cwd,
      agentId: context.agentId,
    });

    // ─── Build environment ───
    const env: Record<string, string> = filterEnvVars();

    // PATH prepend
    if (this.security.pathPrepend && this.security.pathPrepend.length > 0) {
      env['PATH'] = [...this.security.pathPrepend, env['PATH'] ?? ''].join(':');
    }

    // User env overrides
    for (const [key, value] of Object.entries(envOverrides)) {
      // Reject loader overrides for security (OpenClaw gateway pattern)
      if (key.startsWith('LD_') || key.startsWith('DYLD_') || key === 'PATH') {
        log.warn(`Rejected env override: ${key} (security restriction)`);
        continue;
      }
      // Apply same blocked-pattern filter as process.env to prevent secret injection
      const isBlocked = BLOCKED_ENV_PATTERNS.some(pattern => pattern.test(key));
      if (isBlocked) {
        log.warn(`Rejected env override: ${key} (matches blocked pattern)`);
        continue;
      }
      env[key] = value;
    }

    log.info(`Executing: ${command.slice(0, 120)}${command.length > 120 ? '...' : ''}`);

    // ─── Background execution ───
    if (background) {
      return this.runBackground(command, cwd, env, timeout);
    }

    // ─── Foreground execution with auto-yield ───
    return this.runForeground(command, cwd, env, timeout, yieldMs);
  }

  // ─── Foreground execution ─────────────────────────────────────────

  private runForeground(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeout: number,
    yieldMs: number,
  ): Promise<ToolResult> {
    return new Promise((resolve) => {
      const proc = spawn('bash', ['-c', command], {
        cwd,
        timeout,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let truncatedStdout = false;
      let truncatedStderr = false;
      let yielded = false;

      proc.stdout.on('data', (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_SIZE) {
          stdout += data.toString();
        } else {
          truncatedStdout = true;
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT_SIZE) {
          stderr += data.toString();
        } else {
          truncatedStderr = true;
        }
      });

      proc.on('error', (err) => {
        if (!yielded) {
          resolve(createErrorResult(`Failed to execute command: ${err.message}`));
        }
      });

      // Auto-yield timer: if command takes longer than yieldMs, background it
      let yieldTimer: ReturnType<typeof setTimeout> | null = null;
      if (yieldMs > 0) {
        yieldTimer = setTimeout(() => {
          if (proc.exitCode !== null) return; // Already finished

          yielded = true;
          const sessionId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

          const session: BackgroundSession = {
            id: sessionId,
            command,
            pid: proc.pid ?? 0,
            startedAt: Date.now(),
            output: stdout + (stderr ? `\nSTDERR:\n${stderr}` : ''),
            exitCode: null,
            finished: false,
          };

          backgroundSessions.set(sessionId, session);

          // Continue collecting output in background
          proc.stdout.on('data', (data: Buffer) => {
            if (session.output.length < MAX_OUTPUT_SIZE) {
              session.output += data.toString();
            }
          });
          proc.stderr.on('data', (data: Buffer) => {
            if (session.output.length < MAX_OUTPUT_SIZE) {
              session.output += '\n' + data.toString();
            }
          });
          proc.on('close', (code) => {
            session.exitCode = code;
            session.finished = true;
          });

          log.info(`Command auto-backgrounded after ${yieldMs}ms → session ${sessionId}`);

          resolve(createToolResult(
            `⏳ Command still running after ${yieldMs}ms — moved to background.\n` +
            `Session ID: ${sessionId}\n` +
            `PID: ${proc.pid}\n` +
            `Partial output so far:\n${stdout.slice(0, SESSION_PARTIAL_PREVIEW)}${stdout.length > SESSION_PARTIAL_PREVIEW ? '\n[truncated]' : ''}\n\n` +
            `Use exec with sessionId="${sessionId}" to check results later.`,
            { sessionId, pid: proc.pid, backgrounded: true },
          ));
        }, yieldMs);
      }

      proc.on('close', (code) => {
        if (yieldTimer) clearTimeout(yieldTimer);
        if (yielded) return; // Already resolved via yield

        let output = '';
        if (stdout) {
          output += stdout;
          if (truncatedStdout) output += '\n[stdout truncated]';
        }
        if (stderr) {
          output += (output ? '\n\nSTDERR:\n' : '') + stderr;
          if (truncatedStderr) output += '\n[stderr truncated]';
        }

        if (code !== 0 && code !== null) {
          output += `\n\nExit code: ${code}`;
        }

        if (!output.trim()) {
          output = code === 0 ? 'Command completed successfully (no output)' : `Command failed with exit code ${code}`;
        }

        resolve(createToolResult(output, { exitCode: code, cwd }));
      });
    });
  }

  // ─── Background execution ─────────────────────────────────────────

  private runBackground(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeout: number,
  ): Promise<ToolResult> {
    return new Promise((resolve) => {
      const sessionId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      const proc = spawn('bash', ['-c', command], {
        cwd,
        timeout,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const session: BackgroundSession = {
        id: sessionId,
        command,
        pid: proc.pid ?? 0,
        startedAt: Date.now(),
        output: '',
        exitCode: null,
        finished: false,
      };

      backgroundSessions.set(sessionId, session);

      proc.stdout.on('data', (data: Buffer) => {
        if (session.output.length < MAX_OUTPUT_SIZE) {
          session.output += data.toString();
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        if (session.output.length < MAX_OUTPUT_SIZE) {
          session.output += data.toString();
        }
      });

      proc.on('close', (code) => {
        session.exitCode = code;
        session.finished = true;
        log.info(`Background session ${sessionId} finished (exit: ${code})`);
      });

      proc.on('error', (err) => {
        session.output += `\nError: ${err.message}`;
        session.finished = true;
      });

      log.info(`Background session started: ${sessionId} (PID: ${proc.pid})`);

      resolve(createToolResult(
        `Command started in background.\nSession ID: ${sessionId}\nPID: ${proc.pid}\n\nUse exec with sessionId="${sessionId}" to check results.`,
        { sessionId, pid: proc.pid, backgrounded: true },
      ));
    });
  }

  // ─── Session checking ─────────────────────────────────────────────

  private checkSession(sessionId: string): ToolResult {
    const session = backgroundSessions.get(sessionId);
    if (!session) {
      return createErrorResult(`Background session not found: ${sessionId}`);
    }

    const elapsed = Date.now() - session.startedAt;
    const elapsedStr = elapsed < 60000
      ? `${Math.round(elapsed / 1000)}s`
      : `${Math.round(elapsed / 60000)}m`;

    if (!session.finished) {
      return createToolResult(
        `⏳ Session ${sessionId} still running (${elapsedStr})\n` +
        `PID: ${session.pid}\n` +
        `Output so far (${session.output.length} chars):\n` +
        `${session.output.slice(-SESSION_TAIL_SIZE)}`,
        { sessionId, pid: session.pid, finished: false, elapsed },
      );
    }

    // Finished — return full result and clean up
    const result = createToolResult(
      `Session ${sessionId} finished (${elapsedStr}, exit: ${session.exitCode})\n\n${session.output}`,
      { sessionId, exitCode: session.exitCode, finished: true, elapsed },
    );

    // Keep session for 5 minutes then clean up
    setTimeout(() => backgroundSessions.delete(sessionId), SESSION_CLEANUP_MS);

    return result;
  }

  // ─── Security helpers ─────────────────────────────────────────────

  private isSafeBin(bin: string): boolean {
    const baseName = bin.split('/').pop() ?? bin;
    if (!(this.security.safeBins?.includes(baseName) ?? false)) {
      return false;
    }
    // If the binary is an absolute path, verify it lives in a trusted directory.
    if (bin.startsWith('/') && this.security.safeBinTrustedDirs && this.security.safeBinTrustedDirs.length > 0) {
      const binDir = bin.substring(0, bin.lastIndexOf('/'));
      return this.security.safeBinTrustedDirs.includes(binDir);
    }
    return true;
  }
}
