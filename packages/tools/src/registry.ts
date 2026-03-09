import { createLogger } from '@jarvis/shared';
import type { AgentTool, ToolContext, ToolResult } from './base.js';
import { createErrorResult } from './base.js';
import { ExecTool, type ExecSecurityConfig } from './exec.js';
import { ReadTool, WriteTool, EditTool, ListTool, SearchTool } from './file-ops.js';
import { BrowserTool } from './browser.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { MessageAgentTool } from './message-agent.js';
import { SshTool, type SshHostConfig } from './ssh.js';
import { ComputerUseTool, type VncHostConfig } from './computer-use.js';
import { IMessageTool, type IMessageConfig } from './integrations/imessage.js';
import { SpotifyTool, type SpotifyConfig } from './integrations/spotify.js';
import { HomeAssistantTool, type HomeAssistantConfig } from './integrations/homeassistant.js';
import { CronSchedulerTool, type CronSchedulerConfig } from './integrations/cron-scheduler.js';
import { AppleCalendarTool, type AppleCalendarConfig } from './integrations/apple-calendar.js';
import { SocialTool, SocialAnalyticsTool, type SocialToolConfig } from './social/social-tool.js';
import { SocialSchedulerTool } from './social/scheduler.js';

import { ImageGenTool } from './image-gen.js';
import { MediaGenTool, type MediaGenConfig } from './media-gen.js';

const log = createLogger('tools:registry');

export interface ToolRegistryConfig {
  enableBrowser?: boolean;
  enableExec?: boolean;
  execSecurity?: Partial<ExecSecurityConfig>;
  enableFileOps?: boolean;
  enableWebFetch?: boolean;
  enableWebSearch?: boolean;
  enableMessageAgent?: boolean;
  enableSsh?: boolean;
  enableComputerUse?: boolean;
  /** Integrations */
  enableIMessage?: boolean;
  enableSpotify?: boolean;
  enableHomeAssistant?: boolean;
  enableCron?: boolean;
  enableCalendar?: boolean;
  /** Image generation */
  enableImageGen?: boolean;
  openaiApiKey?: string;
  /** Media generation (Flux, Kling, ElevenLabs, HeyGen) */
  enableMediaGen?: boolean;
  mediaGenConfig?: MediaGenConfig;
  /** Social media */
  enableSocial?: boolean;
  anthropicApiKey?: string;
  braveApiKey?: string;
  perplexityApiKey?: string;
  natsPublishFn?: (subject: string, data: string) => Promise<void>;
  /** SSH hosts config: agentId -> { host, username, password } */
  sshHosts?: Record<string, SshHostConfig>;
  /** VNC hosts config: agentId -> { host, vncPort, vncPassword, ssh? } */
  vncHosts?: Record<string, VncHostConfig>;
  /** Integration configs */
  imessageConfig?: IMessageConfig;
  spotifyConfig?: SpotifyConfig;
  homeAssistantConfig?: HomeAssistantConfig;
  cronConfig?: CronSchedulerConfig;
  calendarConfig?: AppleCalendarConfig;
  socialConfig?: SocialToolConfig;
}

/**
 * Central registry for all agent tools.
 * Manages tool lifecycle and provides execution.
 */
export class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  private sshHosts: Record<string, SshHostConfig>;

  constructor(config: ToolRegistryConfig = {}) {
    this.sshHosts = config.sshHosts ?? {};
    // Register core tools based on config
    if (config.enableExec !== false) {
      this.register(new ExecTool(config.execSecurity));
    }

    if (config.enableFileOps !== false) {
      this.register(new ReadTool());
      this.register(new WriteTool());
      this.register(new EditTool());
      this.register(new ListTool());
      this.register(new SearchTool());
    }

    if (config.enableBrowser !== false) {
      this.register(new BrowserTool());
    }

    if (config.enableWebFetch !== false) {
      this.register(new WebFetchTool());
    }

    if (config.enableWebSearch !== false) {
      this.register(new WebSearchTool({
        braveApiKey: config.braveApiKey,
        perplexityApiKey: config.perplexityApiKey,
      }));
    }

    if (config.enableMessageAgent !== false && config.natsPublishFn) {
      this.register(new MessageAgentTool(config.natsPublishFn));
    }

    if (config.enableSsh !== false && config.sshHosts && Object.keys(config.sshHosts).length > 0) {
      this.register(new SshTool({ hosts: config.sshHosts }));
    }

    if (config.enableComputerUse !== false && config.vncHosts && Object.keys(config.vncHosts).length > 0) {
      this.register(new ComputerUseTool({ hosts: config.vncHosts }));
    }

    // ── Integrations ──
    if (config.enableIMessage && process.platform === 'darwin') {
      this.register(new IMessageTool(config.imessageConfig));
    }

    if (config.enableSpotify) {
      this.register(new SpotifyTool(config.spotifyConfig));
    }

    if (config.enableHomeAssistant) {
      this.register(new HomeAssistantTool(config.homeAssistantConfig));
    }

    if (config.enableCron) {
      this.register(new CronSchedulerTool(config.cronConfig));
    }

    if (config.enableCalendar && process.platform === 'darwin') {
      this.register(new AppleCalendarTool(config.calendarConfig));
    }

    // ── Image Generation ──
    if (config.enableImageGen && config.openaiApiKey) {
      this.register(new ImageGenTool(config.openaiApiKey));
    }

    // ── Media Generation (Flux, Kling, ElevenLabs, HeyGen) ──
    if (config.enableMediaGen && config.mediaGenConfig) {
      this.register(new MediaGenTool(config.mediaGenConfig));
    }

    // ── Social Media ──
    if (config.enableSocial && config.socialConfig) {
      this.register(new SocialTool(config.socialConfig));
      this.register(new SocialAnalyticsTool(config.socialConfig));
      this.register(new SocialSchedulerTool());
      // NOTE: SocialContentGeneratorTool removed — the agent IS Claude and writes
      // content directly with full context (brand voice, conversation history).
      // A separate Haiku API call was redundant, slower, and context-blind.
    }

    log.info(`Initialized with ${this.tools.size} tools: ${Array.from(this.tools.keys()).join(', ')}`);
  }

  register(tool: AgentTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Execute a tool by name */
  async execute(name: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Transparent exec → ssh_exec routing for remote agents
    if (name === 'exec' && context.agentId && context.agentId in this.sshHosts) {
      const sshTool = this.tools.get('ssh_exec');
      if (sshTool) {
        log.info(`Routing exec → ssh_exec for remote agent ${context.agentId}`);
        return this.execute('ssh_exec', { ...params, target: context.agentId }, context);
      }
    }

    // Block browser tool for remote agents — they must use computer (VNC) instead
    if (name === 'browser' && context.agentId && context.agentId in this.sshHosts) {
      log.warn(`Blocked browser tool for remote agent ${context.agentId} — use computer tool instead`);
      return createErrorResult(
        `The browser tool runs on master, not on your machine. ` +
        `Use the \`computer\` tool instead to open a browser on your machine via VNC. ` +
        `Example: computer with action "open_url" and url "https://youtube.com"`,
      );
    }

    const tool = this.tools.get(name);
    if (!tool) {
      return createErrorResult(`Unknown tool: ${name}. Available tools: ${Array.from(this.tools.keys()).join(', ')}`);
    }

    const startTime = Date.now();
    try {
      const result = await tool.execute(params, context);
      const elapsed = Date.now() - startTime;
      log.info(`Tool ${name} completed in ${elapsed}ms (${result.type})`);
      return result;
    } catch (err) {
      const elapsed = Date.now() - startTime;
      log.error(`Tool ${name} failed after ${elapsed}ms: ${(err as Error).message}`);
      return createErrorResult(`Tool execution failed: ${(err as Error).message}`);
    }
  }

  /** Get all tool definitions for LLM function calling */
  getDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** List registered tool names */
  listTools(): string[] {
    return Array.from(this.tools.keys());
  }
}
