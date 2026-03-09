import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '@jarvis/shared';
import type { AgentTool, ToolContext, ToolResult } from './base.js';
import { createToolResult, createErrorResult } from './base.js';

const log = createLogger('tool:ssh');

const MAX_OUTPUT_SIZE = 200_000; // 200KB max output
const DEFAULT_TIMEOUT = 120_000; // 2 minutes
const SSH_READY_TIMEOUT = 10_000; // 10s SSH connection handshake timeout

const KNOWN_HOSTS_PATH = join(process.env['HOME'] || '~', '.ssh', 'known_hosts');

/**
 * Parse ~/.ssh/known_hosts into a Map of hostname -> Set<fingerprint>.
 * Each fingerprint is the SHA-256 hex digest of the raw key data stored in known_hosts.
 */
function parseKnownHosts(): Map<string, Set<string>> {
  const hostsMap = new Map<string, Set<string>>();

  if (!existsSync(KNOWN_HOSTS_PATH)) {
    return hostsMap;
  }

  try {
    const content = readFileSync(KNOWN_HOSTS_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Format: hostname key-type base64-key [comment]
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;

      const hostnames = parts[0]!.split(',');
      const keyBase64 = parts[2]!;

      try {
        const keyBuffer = Buffer.from(keyBase64, 'base64');
        const fingerprint = createHash('sha256').update(keyBuffer).digest('hex');

        for (const hostname of hostnames) {
          const clean = hostname.replace(/^\[|\]:\d+$/g, '').trim();
          if (!clean) continue;

          if (!hostsMap.has(clean)) {
            hostsMap.set(clean, new Set());
          }
          hostsMap.get(clean)!.add(fingerprint);
        }
      } catch {
        // Skip malformed entries
        continue;
      }
    }
  } catch (err) {
    log.warn(`Failed to read known_hosts: ${(err as Error).message}`);
  }

  return hostsMap;
}

/**
 * Create a host key verifier that checks against ~/.ssh/known_hosts.
 * Unknown hosts are REJECTED — no TOFU (Trust On First Use).
 * Add hosts to known_hosts manually or via ssh-keyscan before using this tool.
 */
function createHostVerifier(hostname: string): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    const fingerprint = createHash('sha256').update(key).digest('hex');
    const knownHosts = parseKnownHosts();
    const knownFingerprints = knownHosts.get(hostname);

    if (knownFingerprints) {
      // Host is in known_hosts — verify the fingerprint matches
      if (knownFingerprints.has(fingerprint)) {
        return true;
      }
      log.error(
        `HOST KEY VERIFICATION FAILED for ${hostname}! ` +
        `Key fingerprint SHA-256:${fingerprint} does not match known_hosts. ` +
        `Possible MITM attack. Connection rejected.`
      );
      return false;
    }

    // Host not in known_hosts — REJECT (no auto-trust)
    log.error(
      `SSH host ${hostname} not found in known_hosts. Connection rejected. ` +
      `Add the host key manually: ssh-keyscan ${hostname} >> ~/.ssh/known_hosts`
    );
    return false;
  };
}

export interface SshHostConfig {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly password?: string;
  readonly privateKeyPath?: string;
}

/** Build the ssh2 connection config from a SshHostConfig */
function buildConnectConfig(host: SshHostConfig): Record<string, unknown> {
  const config: Record<string, unknown> = {
    host: host.host,
    port: host.port || 22,
    username: host.username,
    hostVerifier: createHostVerifier(host.host),
    readyTimeout: SSH_READY_TIMEOUT,
  };

  // Prefer key-based auth over password
  if (host.privateKeyPath) {
    try {
      config['privateKey'] = readFileSync(host.privateKeyPath);
      log.info(`SSH using private key: ${host.privateKeyPath}`);
    } catch (err) {
      log.warn(`Failed to read private key ${host.privateKeyPath}: ${(err as Error).message}`);
      // Fall back to password if key read fails
      if (host.password) config['password'] = host.password;
    }
  } else if (host.password) {
    config['password'] = host.password;
  }

  return config;
}

export interface SshToolConfig {
  /** Map of agentId -> SSH host config for target machines */
  readonly hosts: Record<string, SshHostConfig>;
}

/**
 * SSH Tool - Execute commands on remote machines via SSH.
 * Each agent is mapped to a target machine (e.g., agent-smith -> Agent Smith Mac Mini).
 * Uses ssh2 library for password-based authentication.
 */
export class SshTool implements AgentTool {
  definition = {
    name: 'ssh_exec',
    description: 'Execute a command on the remote machine assigned to this agent via SSH. Use this for running commands on the target Mac Mini (installing software, managing files, running scripts, etc.). The remote machine is automatically determined based on the agent identity.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute on the remote machine',
        },
        target: {
          type: 'string',
          description: 'Optional: specific target host ID (e.g., "agent-smith", "agent-johny"). Defaults to the current agent\'s assigned machine.',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 120000)',
        },
      },
      required: ['command'],
    },
  };

  constructor(private config: SshToolConfig) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = params['command'] as string;
    const target = (params['target'] as string) || context.agentId;
    const timeout = (params['timeout'] as number) || DEFAULT_TIMEOUT;

    if (!command) return createErrorResult('Missing required parameter: command');

    // Resolve target host config
    const hostConfig = this.config.hosts[target];
    if (!hostConfig) {
      const available = Object.keys(this.config.hosts).join(', ');
      return createErrorResult(`No SSH host configured for target "${target}". Available targets: ${available}`);
    }

    log.info(`SSH exec on ${hostConfig.host} (target: ${target}): ${command.slice(0, 100)}`);

    try {
      return await this.sshExec(hostConfig, command, timeout);
    } catch (err) {
      log.error(`SSH exec failed: ${(err as Error).message}`);
      return createErrorResult(`SSH execution failed: ${(err as Error).message}`);
    }
  }

  /** Execute a command via SSH and return the result */
  private sshExec(host: SshHostConfig, command: string, timeout: number): Promise<ToolResult> {
    return new Promise((resolve) => {
      const conn = new Client();
      let stdout = '';
      let stderr = '';
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          conn.end();
          resolve(createErrorResult(`SSH command timed out after ${timeout}ms`));
        }
      }, timeout);

      conn.on('ready', () => {
        log.info(`SSH connected to ${host.host}`);
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            resolved = true;
            conn.end();
            resolve(createErrorResult(`SSH exec error: ${err.message}`));
            return;
          }

          stream.on('close', (code: number) => {
            clearTimeout(timer);
            if (!resolved) {
              resolved = true;
              conn.end();

              let output = '';
              if (stdout) output += stdout.slice(0, MAX_OUTPUT_SIZE);
              if (stderr) output += (output ? '\n\nSTDERR:\n' : '') + stderr.slice(0, MAX_OUTPUT_SIZE);
              if (code !== 0 && code !== null) {
                output += `\n\nExit code: ${code}`;
              }
              if (!output.trim()) {
                output = code === 0 ? 'Command completed successfully (no output)' : `Command failed with exit code ${code}`;
              }

              resolve(createToolResult(output, { exitCode: code, host: host.host }));
            }
          });

          stream.on('data', (data: Buffer) => {
            if (stdout.length < MAX_OUTPUT_SIZE) {
              stdout += data.toString();
            }
          });

          stream.stderr.on('data', (data: Buffer) => {
            if (stderr.length < MAX_OUTPUT_SIZE) {
              stderr += data.toString();
            }
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          log.error(`SSH connection error: ${err.message}`);
          resolve(createErrorResult(`SSH connection failed to ${host.host}: ${err.message}`));
        }
      });

      // Warn if password auth is used when key auth is available
      if (host.password && host.privateKeyPath) {
        log.warn(
          `SSH to ${host.host}: password auth is being used, but a private key is also configured ` +
          `at "${host.privateKeyPath}". Prefer key-based auth for better security.`
        );
      }

      conn.connect(buildConnectConfig(host) as unknown as Record<string, unknown>);
    });
  }
}

/**
 * Helper: Execute a single SSH command and return stdout.
 * Used internally by ComputerUseTool.
 */
export async function sshExecSimple(
  host: SshHostConfig,
  command: string,
  timeout = 30000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        conn.end();
        reject(new Error(`SSH command timed out after ${timeout}ms`));
      }
    }, timeout);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          resolved = true;
          conn.end();
          reject(err);
          return;
        }

        stream.on('close', (code: number) => {
          clearTimeout(timer);
          if (!resolved) {
            resolved = true;
            conn.end();
            resolve({ stdout, stderr, code });
          }
        });

        stream.on('data', (data: Buffer) => {
          if (stdout.length < MAX_OUTPUT_SIZE) {
            stdout += data.toString();
          }
        });

        stream.stderr.on('data', (data: Buffer) => {
          if (stderr.length < MAX_OUTPUT_SIZE) {
            stderr += data.toString();
          }
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    conn.connect(buildConnectConfig(host) as unknown as Record<string, unknown>);
  });
}

/**
 * Helper: Execute SSH command and get raw binary stdout (for screenshots).
 */
const MAX_BINARY_SIZE = 10_000_000; // 10MB max binary output

export async function sshExecBinary(
  host: SshHostConfig,
  command: string,
  timeout = 30000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        conn.end();
        reject(new Error(`SSH binary command timed out after ${timeout}ms`));
      }
    }, timeout);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          resolved = true;
          conn.end();
          reject(err);
          return;
        }

        stream.on('close', (code: number) => {
          clearTimeout(timer);
          if (!resolved) {
            resolved = true;
            conn.end();
            if (code !== 0) {
              reject(new Error(`Command exited with code ${code}`));
            } else {
              resolve(Buffer.concat(chunks));
            }
          }
        });

        stream.on('data', (data: Buffer) => {
          if (totalSize < MAX_BINARY_SIZE) {
            chunks.push(data);
            totalSize += data.length;
          }
        });

        stream.stderr.on('data', (data: Buffer) => {
          // Log stderr but don't fail
          log.warn(`SSH stderr: ${data.toString().slice(0, 200)}`);
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    conn.connect(buildConnectConfig(host) as unknown as Record<string, unknown>);
  });
}
