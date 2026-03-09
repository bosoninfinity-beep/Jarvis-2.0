import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@jarvis/shared';
import type { AgentTool, ToolContext, ToolResult } from './base.js';
import { createToolResult, createErrorResult } from './base.js';
import { sshExecSimple, type SshHostConfig } from './ssh.js';

const log = createLogger('tool:computer-use');

const SCREENSHOT_TIMEOUT = 30_000; // 30s for screenshot capture
const ACTION_TIMEOUT = 15_000; // 15s for mouse/keyboard actions
const OPEN_APP_TIMEOUT = 15_000; // 15s for app launch via SSH
const MAX_SCREENSHOT_KB = 500; // 500KB max base64 screenshot size

export interface VncHostConfig {
  /** VNC host IP */
  readonly host: string;
  /** VNC port (default: 5900) */
  readonly vncPort?: number;
  /** VNC password for VNCAuth */
  readonly vncPassword: string;
  /** SSH config for commands that need SSH (open_app, etc.) */
  readonly ssh?: SshHostConfig;
}

export interface ComputerUseConfig {
  /** Map of agentId -> VNC host config for target machines */
  readonly hosts: Record<string, VncHostConfig>;
}

type ComputerAction =
  | 'screenshot'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'type'
  | 'key'
  | 'key_combo'
  | 'scroll'
  | 'move'
  | 'drag'
  | 'open_app'
  | 'get_screen_size';

/**
 * ComputerUseTool - Screen capture + mouse/keyboard control for remote Mac Minis.
 *
 * Uses VNC protocol directly for:
 * - Screenshots (framebuffer capture via RFB protocol)
 * - Mouse events (click, move, drag via RFB PointerEvent)
 * - Keyboard events (type, key press via RFB KeyEvent)
 *
 * Falls back to SSH for:
 * - Opening applications (macOS `open -a` command)
 *
 * This approach bypasses macOS Screen Recording permission issues
 * because the VNC server already has the permission.
 *
 * Inspired by OpenClaw's Peekaboo and Anthropic's Computer Use API.
 */
export class ComputerUseTool implements AgentTool {
  definition = {
    name: 'computer',
    description: `Control the remote Mac computer assigned to this agent. Take screenshots to see the screen, click on elements, type text, press keyboard shortcuts, scroll, and open apps.

WORKFLOW:
1. Take a screenshot first to see the current screen state
2. Identify coordinates of elements you want to interact with
3. Click, type, or perform keyboard actions
4. Take another screenshot to verify the result

COORDINATE SYSTEM: Origin (0,0) is top-left corner. Use get_screen_size to know dimensions.

KEY COMBOS: Use key_combo with format like "cmd+c", "cmd+shift+s", "ctrl+a"`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'screenshot',
            'click',
            'double_click',
            'right_click',
            'type',
            'key',
            'key_combo',
            'scroll',
            'move',
            'drag',
            'open_app',
            'get_screen_size',
          ],
          description: 'The action to perform on the remote computer',
        },
        x: {
          type: 'number',
          description: 'X coordinate (pixels from left). Required for click, double_click, right_click, move actions.',
        },
        y: {
          type: 'number',
          description: 'Y coordinate (pixels from top). Required for click, double_click, right_click, move actions.',
        },
        text: {
          type: 'string',
          description: 'Text to type (for "type" action), key name (for "key" action like "return", "tab", "escape"), or key combo (for "key_combo" action like "cmd+c", "cmd+shift+s")',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Scroll direction (for "scroll" action)',
        },
        amount: {
          type: 'number',
          description: 'Scroll amount (for "scroll" action, default: 3)',
        },
        end_x: {
          type: 'number',
          description: 'End X coordinate for drag action',
        },
        end_y: {
          type: 'number',
          description: 'End Y coordinate for drag action',
        },
        app_name: {
          type: 'string',
          description: 'Application name to open (for "open_app" action, e.g., "Safari", "Terminal", "Google Chrome")',
        },
        target: {
          type: 'string',
          description: 'Optional: specific target agent ID. Defaults to the current agent\'s machine.',
        },
      },
      required: ['action'],
    },
  };

  private vncControlScript: string;

  constructor(private config: ComputerUseConfig) {
    // Resolve path to vnc-control.py
    // Priority: env var > package root > src dir > cwd-based
    if (process.env['JARVIS_VNC_CONTROL_SCRIPT']) {
      this.vncControlScript = process.env['JARVIS_VNC_CONTROL_SCRIPT'];
    } else {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      // When running from dist/, the script is at ../vnc-control.py
      // When running from src/, it's at ./vnc-control.py
      this.vncControlScript = resolve(thisDir, '..', 'vnc-control.py');
    }
    log.info(`VNC control script: ${this.vncControlScript}`);
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params['action'] as ComputerAction;
    const target = (params['target'] as string) || context.agentId;

    if (!action) return createErrorResult('Missing required parameter: action');

    // Resolve target host
    const hostConfig = this.config.hosts[target];
    if (!hostConfig) {
      const available = Object.keys(this.config.hosts).join(', ');
      return createErrorResult(`No host configured for target "${target}". Available: ${available}`);
    }

    log.info(`Computer action: ${action} on ${hostConfig.host} (target: ${target})`);

    try {
      switch (action) {
        case 'screenshot':
          return await this.vncAction(hostConfig, 'screenshot');

        case 'click':
          return await this.vncAction(hostConfig, 'click', [String(params['x']), String(params['y'])]);

        case 'double_click':
          return await this.vncAction(hostConfig, 'doubleclick', [String(params['x']), String(params['y'])]);

        case 'right_click':
          return await this.vncAction(hostConfig, 'rightclick', [String(params['x']), String(params['y'])]);

        case 'type':
          return await this.vncAction(hostConfig, 'type', [params['text'] as string]);

        case 'key':
          return await this.vncAction(hostConfig, 'key', [params['text'] as string]);

        case 'key_combo':
          return await this.vncAction(hostConfig, 'keycombo', [params['text'] as string]);

        case 'scroll': {
          const dir = (params['direction'] as string) || 'down';
          const amt = String(params['amount'] ?? 3);
          const args = [dir, amt];
          if (params['x'] !== undefined) args.push(String(params['x']), String(params['y']));
          return await this.vncAction(hostConfig, 'scroll', args);
        }

        case 'move':
          return await this.vncAction(hostConfig, 'move', [String(params['x']), String(params['y'])]);

        case 'drag':
          return await this.vncAction(hostConfig, 'drag', [
            String(params['x']), String(params['y']),
            String(params['end_x']), String(params['end_y']),
          ]);

        case 'open_app':
          return await this.openApp(hostConfig, params['app_name'] as string);

        case 'get_screen_size':
          return await this.vncAction(hostConfig, 'screensize');

        default:
          return createErrorResult(`Unknown action: ${action}`);
      }
    } catch (err) {
      log.error(`Computer action ${action} failed: ${(err as Error).message}`);
      return createErrorResult(`Computer action failed: ${(err as Error).message}`);
    }
  }

  /** Execute a VNC control action via the Python helper script */
  private vncAction(host: VncHostConfig, action: string, params: string[] = []): Promise<ToolResult> {
    return new Promise((resolve) => {
      const args = [
        this.vncControlScript,
        host.host,
        String(host.vncPort || 5900),
        action,
        ...params,
      ];

      log.info(`VNC: ${action} ${params.join(' ')}`);

      // Pass VNC password via stdin (not env var) to prevent exposure in ps output
      const proc = spawn('python3', args, {
        timeout: action === 'screenshot' ? SCREENSHOT_TIMEOUT : ACTION_TIMEOUT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });

      // Write password to stdin and close it immediately
      if (host.vncPassword && proc.stdin) {
        proc.stdin.write(host.vncPassword);
        proc.stdin.end();
      } else if (proc.stdin) {
        proc.stdin.end();
      }

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        resolve(createErrorResult(`VNC control failed: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          resolve(createErrorResult(`VNC action failed: ${stderr || stdout}`));
          return;
        }

        const output = stdout.trim();

        // Handle screenshot (output is base64 PNG)
        if (action === 'screenshot') {
          const sizeKB = output.length / 1024;
          log.info(`Screenshot captured: ${sizeKB.toFixed(0)}KB base64`);

          // Safety cap: if base64 still > MAX_SCREENSHOT_KB after Python resize, replace with text
          if (sizeKB > MAX_SCREENSHOT_KB) {
            log.warn(`Screenshot too large (${sizeKB.toFixed(0)}KB), returning text description instead`);
            resolve(createToolResult(
              `Screenshot captured but too large to display (${sizeKB.toFixed(0)}KB). ` +
              `Screen size: the image was captured successfully. ` +
              `Try performing the action and take another screenshot to verify.`,
            ));
            return;
          }

          resolve({
            type: 'image',
            content: output,
            metadata: {
              mediaType: 'image/jpeg',
            },
          });
          return;
        }

        // Handle screensize
        if (action === 'screensize') {
          const [w, h] = output.split('x').map(Number);
          resolve(createToolResult(`Screen size: ${w}x${h}`, { width: w, height: h }));
          return;
        }

        // All other actions return OK:action:details
        resolve(createToolResult(output));
      });
    });
  }

  /** Open an app via SSH */
  private async openApp(host: VncHostConfig, appName: string): Promise<ToolResult> {
    if (!appName) return createErrorResult('Missing required parameter: app_name');

    // Validate appName to prevent shell injection via SSH command
    if (!/^[a-zA-Z0-9 ._-]+$/.test(appName)) {
      return createErrorResult('Invalid app_name: only alphanumeric characters, spaces, dots, underscores, and hyphens are allowed');
    }

    if (!host.ssh) {
      return createErrorResult('SSH config not available for open_app action');
    }

    const result = await sshExecSimple(host.ssh,
      `open -a "${appName}" 2>&1 || open -a "${appName}.app" 2>&1`,
      OPEN_APP_TIMEOUT
    );

    if (result.code !== 0) {
      return createErrorResult(`Failed to open ${appName}: ${result.stderr || result.stdout}`);
    }

    return createToolResult(`Opened application: ${appName}`);
  }
}
