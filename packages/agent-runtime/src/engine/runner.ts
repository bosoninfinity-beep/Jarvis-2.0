import { createLogger, type AgentId } from '@jarvis/shared';
import {
  ProviderRegistry, type ProviderRegistryConfig,
  type ChatRequest, type ChatResponse, type ChatChunk,
  type Message, type ContentBlock, type ToolUseBlock, type ToolResultBlock, type ThinkingBlock, type TextBlock,
  createUsageAccumulator, mergeUsage, type UsageAccumulator, type TokenUsage,
} from '../llm/index.js';
import { type ToolRegistry, MessageAgentTool } from '@jarvis/tools';
import { NatsHandler, type NatsHandlerConfig, type TaskAssignment, type InterAgentMsg } from '../communication/nats-handler.js';
import { SessionManager } from '../sessions/session-manager.js';
import { buildSystemPrompt, type AgentRole, type PromptContext } from '../system-prompt/index.js';
import {
  loadPlugins,
  loadSkills,
  buildSkillsPromptSection,
  type LoadedPluginSystem,
  type HookRunner,
  type PluginRegistry as PluginReg,
} from '../plugins/index.js';
import type { PluginRuntimeConfig } from '../plugins/types.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const log = createLogger('agent:runner');

const MAX_TOOL_ROUNDS = 10;
const MAX_CONSECUTIVE_ERRORS = 5;
const TOOL_TIMEOUT_MS = 120_000; // 2 minutes (was 5 — prevents long-hanging tools)
/** Default max output tokens per LLM request.
 *  Claude Opus 4.6: 32k, Sonnet 4.6: 64k output tokens max. */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
/** Approximate char budget for the full prompt (system + tools + messages).
 *  Claude CLI's `-p` mode pipes everything as a single string; keeping it
 *  well under the 200k-token context avoids "Prompt is too long" errors.
 *  ~150k chars ≈ ~40k tokens, leaving room for system prompt + tool defs.
 *  Bumped to 150k for Marketing Hub v4 (75k prompt + agent template + core). */
const MAX_PROMPT_CHARS = 150_000;

/**
 * Replace base64 image data in older tool results with a short text placeholder.
 * Keeps only the most recent N messages with images intact (for the current round).
 * This prevents VNC screenshots from blowing up the context window.
 */
function stripOldImages(messages: Message[], keepRecentCount = 4): Message[] {
  const result: Message[] = [];
  const stripThreshold = messages.length - keepRecentCount;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (i < stripThreshold && msg.role === 'user' && Array.isArray(msg.content)) {
      // Check if any content block contains image data (top-level or inside tool_result)
      const hasImage = (msg.content as Array<{ type: string }>).some(
        (b) => b.type === 'image' || (
          b.type === 'tool_result' &&
          Array.isArray((b as { content?: unknown }).content) &&
          ((b as { content: Array<{ type: string }> }).content).some((c) => c.type === 'image')
        ),
      );

      if (hasImage) {
        // Replace image blocks with text placeholders
        const stripped = (msg.content as Array<Record<string, unknown>>).map((block) => {
          // Top-level image blocks
          if (block.type === 'image') {
            return { type: 'text', text: '[Screenshot removed to save context]' };
          }
          // Images inside tool_result blocks
          if (block.type === 'tool_result' && Array.isArray(block.content)) {
            const newContent = (block.content as Array<Record<string, unknown>>).map((c) => {
              if (c.type === 'image') {
                return { type: 'text', text: '[Screenshot removed to save context]' };
              }
              return c;
            });
            return { ...block, content: newContent };
          }
          return block;
        });
        result.push({ role: msg.role, content: stripped as ContentBlock[] });
        continue;
      }
    }
    result.push(msg);
  }

  return result;
}

/** Max chars for a single tool_use input block (code/text in tool args) */
const MAX_TOOL_USE_CHARS = 6_000;
/** Max chars for a single tool_result content */
const MAX_TOOL_RESULT_CHARS = 8_000;
/** Max tool_use/tool_result blocks to keep per message after truncation */
const MAX_BLOCKS_PER_MESSAGE = 12;
/** Max consecutive empty (zero-token / no-content) responses before giving up */
const MAX_EMPTY_RETRIES = 2;

/**
 * Compact `write` tool_use blocks in conversation history.
 * When an agent writes a large file (e.g. 40KB HTML game), the full content
 * stays in the conversation as a tool_use block. On the next round, buildPrompt
 * serializes this back into the prompt — blowing up context for no benefit.
 *
 * This replaces the file content in older write/edit tool_use blocks with a short summary.
 * Only compacts messages older than `keepRecent` from the end.
 */
function compactWriteToolUse(messages: Message[], keepRecent = 4): Message[] {
  const threshold = messages.length - keepRecent;
  return messages.map((msg, i) => {
    if (i >= threshold) return msg; // keep recent messages intact
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;

    let changed = false;
    const newContent = (msg.content as Array<Record<string, unknown>>).map((block) => {
      if (block.type !== 'tool_use') return block;
      const name = block.name as string;
      const input = block.input as Record<string, unknown> | undefined;
      if (!input) return block;

      // Compact 'write' tool: replace large content with summary
      if (name === 'write' && typeof input.content === 'string' && (input.content as string).length > 500) {
        changed = true;
        const path = input.path ?? 'unknown';
        const size = (input.content as string).length;
        return {
          ...block,
          input: {
            ...input,
            content: `[File written: ${path}, ${(size / 1024).toFixed(1)}KB — content removed from history to save context]`,
          },
        };
      }

      // Compact 'edit' tool: replace large old_string/new_string
      if (name === 'edit') {
        const oldStr = input.old_string as string | undefined;
        const newStr = input.new_string as string | undefined;
        if ((oldStr && oldStr.length > 500) || (newStr && newStr.length > 500)) {
          changed = true;
          return {
            ...block,
            input: {
              ...input,
              old_string: oldStr && oldStr.length > 500 ? `[${oldStr.length} chars — trimmed]` : oldStr,
              new_string: newStr && newStr.length > 500 ? `[${newStr.length} chars — trimmed]` : newStr,
            },
          };
        }
      }

      return block;
    });

    return changed ? { ...msg, content: newContent as ContentBlock[] } : msg;
  });
}

/**
 * Estimate the total character size of a set of messages (including system + tools overhead).
 */
function estimateMessagesSize(msgs: Message[], systemPromptLen: number, toolDefsLen: number): number {
  let size = systemPromptLen + toolDefsLen;
  for (const m of msgs) {
    if (!m.content) continue;
    if (typeof m.content === 'string') {
      size += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        switch (block.type) {
          case 'text':
            size += block.text?.length ?? 0;
            break;
          case 'thinking':
            size += block.thinking?.length ?? 0;
            break;
          case 'tool_result':
            size += block.content == null ? 0 : (typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length);
            break;
          case 'tool_use':
            size += block.input ? JSON.stringify(block.input).length : 0;
            break;
          default:
            try { size += JSON.stringify(block).length; } catch { /* skip */ }
        }
      }
    }
  }
  return size;
}

/**
 * Truncate text content within a single block to a max length.
 */
function truncateBlockContent(block: Record<string, unknown>, maxLen: number): Record<string, unknown> {
  // tool_use: truncate input arguments (large code blocks)
  if (block.type === 'tool_use' && block.input) {
    const inputStr = JSON.stringify(block.input);
    if (inputStr.length > maxLen) {
      const truncInput = inputStr.slice(0, maxLen);
      return { ...block, input: { _truncated: true, summary: truncInput + '...[truncated]' } };
    }
  }
  // tool_result: truncate content
  if (block.type === 'tool_result') {
    const content = block.content;
    if (typeof content === 'string' && content.length > maxLen) {
      return { ...block, content: content.slice(0, maxLen) + '\n...[truncated from ' + content.length + ' chars]' };
    }
    // Array content (may contain images or text blocks)
    if (Array.isArray(content)) {
      const truncated = (content as Array<Record<string, unknown>>).map((c) => {
        if (c.type === 'image') {
          return { type: 'text', text: '[Image removed to save context]' };
        }
        if (c.type === 'text' && typeof c.text === 'string' && (c.text as string).length > maxLen) {
          return { type: 'text', text: (c.text as string).slice(0, maxLen) + '...[truncated]' };
        }
        return c;
      });
      return { ...block, content: truncated };
    }
  }
  return block;
}

/**
 * Shrink a single message by truncating individual blocks and dropping excess blocks.
 * Preserves assistant/user message structure and tool_use/tool_result pairing.
 */
function shrinkMessage(msg: Message, aggressive: boolean): Message {
  if (!msg.content) return msg;
  if (typeof msg.content === 'string') {
    const limit = aggressive ? 2_000 : 6_000;
    if (msg.content.length > limit) {
      return { ...msg, content: msg.content.slice(0, limit) + '\n...[truncated]' };
    }
    return msg;
  }
  if (!Array.isArray(msg.content)) return msg;

  let blocks = msg.content as Array<Record<string, unknown>>;
  const maxLen = aggressive ? 2_000 : (msg.role === 'assistant' ? MAX_TOOL_USE_CHARS : MAX_TOOL_RESULT_CHARS);
  const maxBlocks = aggressive ? 6 : MAX_BLOCKS_PER_MESSAGE;

  // Truncate individual block contents
  blocks = blocks.map((b) => truncateBlockContent(b, maxLen));

  // Drop excess blocks (keep first few + last few for context)
  if (blocks.length > maxBlocks) {
    if (msg.role === 'user') {
      // User messages contain tool_result blocks — each must keep its original tool_use_id
      // to match the preceding assistant's tool_use blocks. Inserting a synthetic block
      // with a fake tool_use_id causes an API 400. Instead, truncate content of all kept
      // blocks more aggressively rather than dropping any.
      const hardLimit = Math.min(500, maxLen);
      blocks = blocks.map((b) => truncateBlockContent(b, hardLimit));
    } else {
      // Assistant messages: safe to insert a text placeholder for dropped blocks
      const keepStart = Math.ceil(maxBlocks / 2);
      const keepEnd = Math.floor(maxBlocks / 2);
      const dropped = blocks.length - maxBlocks;
      blocks = [
        ...blocks.slice(0, keepStart),
        { type: 'text', content: `[...${dropped} blocks removed to save context...]` } as Record<string, unknown>,
        ...blocks.slice(blocks.length - keepEnd),
      ];
    }
  }

  return { ...msg, content: blocks as ContentBlock[] };
}

/**
 * Trim messages to stay within the prompt size budget.
 *
 * Strategy (applied in order until within budget):
 * 1. Drop middle message pairs (keep front 2 + tail 2)
 * 2. Shrink remaining messages by truncating large tool blocks
 * 3. Aggressive truncation — heavily shrink all remaining messages
 */
function trimMessagesToFit(messages: Message[], systemPromptLen: number, toolDefsLen: number): Message[] {
  const estimate = (msgs: Message[]) => estimateMessagesSize(msgs, systemPromptLen, toolDefsLen);

  if (estimate(messages) <= MAX_PROMPT_CHARS) return messages;

  // Phase 1: Drop middle message pairs (validate proper assistant+user pairing)
  const keepFront = Math.min(2, messages.length);
  const front = messages.slice(0, keepFront);
  let tail = messages.slice(keepFront);

  while (tail.length > 2 && estimate([...front, ...tail]) > MAX_PROMPT_CHARS) {
    // Drop in valid pairs: (assistant, user) or (user, assistant)
    if (tail[0]?.role === 'assistant' && tail[1]?.role === 'user') {
      tail = tail.slice(2);
    } else if (tail[0]?.role === 'user' && tail[1]?.role === 'assistant') {
      tail = tail.slice(2);
    } else {
      // Can't safely drop a pair — skip to next phase
      break;
    }
  }

  let trimmed = [...front, ...tail];
  if (estimate(trimmed) <= MAX_PROMPT_CHARS) {
    if (trimmed.length < messages.length) {
      log.info(`Context trimmed: ${messages.length} → ${trimmed.length} messages (phase 1: drop middle)`);
    }
    return trimmed;
  }

  // Phase 2: Shrink individual messages (truncate large tool blocks)
  trimmed = trimmed.map((m) => shrinkMessage(m, false));
  if (estimate(trimmed) <= MAX_PROMPT_CHARS) {
    log.info(`Context trimmed: ${messages.length} → ${trimmed.length} messages (phase 2: shrink blocks)`);
    return trimmed;
  }

  // Phase 3: Aggressive truncation — heavily cut all content
  trimmed = trimmed.map((m) => shrinkMessage(m, true));
  const finalSize = estimate(trimmed);
  if (finalSize <= MAX_PROMPT_CHARS) {
    log.info(`Context trimmed: ${messages.length} → ${trimmed.length} messages (phase 3: aggressive, ${finalSize} chars)`);
    return trimmed;
  }

  // Phase 4: Nuclear — keep only the first user message with a summary
  log.warn(`Context still too large after aggressive trim (${finalSize} chars). Resetting to initial prompt only.`);
  const firstMsg = messages[0];
  const summary: Message = {
    role: 'assistant',
    content: '[Previous conversation was too large and has been dropped. Continue the task based on the original instructions above.]',
  };
  // Anthropic requires the first message to be a user message.
  // If the oldest retained message is an assistant message (e.g. loaded from context),
  // prepend a synthetic user message so the array starts with role 'user'.
  if (firstMsg.role === 'assistant') {
    const syntheticUser: Message = { role: 'user', content: '[conversation resumed]' };
    return [syntheticUser, firstMsg, summary];
  }
  return [firstMsg, summary];
}

/**
 * Sanitize messages array to ensure valid Anthropic API format.
 * Ensures every tool_use block has a matching tool_result in the next user message.
 * Removes orphaned tool_use blocks that would cause API 400 errors.
 */
function sanitizeMessages(messages: Message[]): Message[] {
  const sanitized: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolUseBlocks = (msg.content as Array<{ type: string; id?: string }>)
        .filter((b) => b.type === 'tool_use' && b.id);

      if (toolUseBlocks.length > 0) {
        // Check if the next message has matching tool_results
        const nextMsg = messages[i + 1];
        const hasResults = nextMsg?.role === 'user' && Array.isArray(nextMsg.content) &&
          (nextMsg.content as Array<{ type: string }>).some((b) => b.type === 'tool_result');

        if (!hasResults) {
          // Strip tool_use blocks from this assistant message, keep only text
          const textBlocks = (msg.content as Array<{ type: string }>).filter((b) => b.type === 'text');
          if (textBlocks.length > 0) {
            sanitized.push({ role: 'assistant', content: textBlocks as ContentBlock[] });
          } else {
            sanitized.push({ role: 'assistant', content: '(tool execution was interrupted)' });
          }
          log.warn(`Sanitized orphaned tool_use blocks from message ${i}`);
          continue;
        }
      }
    }

    sanitized.push(msg);
  }

  return sanitized;
}

export interface AgentRunnerConfig {
  agentId: AgentId;
  role: AgentRole;
  machineId: string;
  hostname: string;
  natsUrl: string;
  natsUrlThunderbolt?: string;
  nasMountPath: string;
  workspacePath: string;
  capabilities: string[];
  llm: ProviderRegistryConfig;
  defaultModel: string;
  tools: ToolRegistry;
  socialConfig?: Record<string, unknown>;
}

/**
 * AgentRunner - Core execution engine that runs on each Mac Mini.
 *
 * Lifecycle:
 * 1. Connect to NATS and register with Gateway
 * 2. Load plugins, skills, and hooks
 * 3. Subscribe to task assignments
 * 4. For each task: build context -> hooks -> LLM loop -> tools -> hooks -> report result
 * 5. Send heartbeats
 *
 * Adapted from OpenClaw's Pi Agent runner pattern, with full plugin lifecycle hooks.
 */
export class AgentRunner {
  private running = false;
  private nats: NatsHandler;
  private providers: ProviderRegistry;
  private sessions: SessionManager;
  private tools: ToolRegistry;
  private currentTask: TaskAssignment | null = null;
  private taskProcessing = false; // mutex flag to prevent race conditions
  private chatProcessing = false;
  private currentSessionId: string | null = null;
  private taskSessionId: string | null = null; // separate from chat session
  private chatSessionTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Pending chat queue — chats that arrive while busy are queued instead of dropped */
  private chatQueue: Array<{ from: string; content: string; sessionId?: string; metadata?: Record<string, unknown>; queuedAt: number }> = [];
  private static readonly MAX_CHAT_QUEUE_SIZE = 3;

  // Plugin system
  private runtimeConfig!: PluginRuntimeConfig;
  private pluginSystem: LoadedPluginSystem | null = null;
  private hooks: HookRunner | null = null;
  private pluginRegistry: PluginReg | null = null;
  private serviceStopFns: Array<() => void> = [];

  constructor(private readonly config: AgentRunnerConfig) {
    this.providers = new ProviderRegistry(config.llm);
    this.tools = config.tools;
    this.sessions = new SessionManager(config.nasMountPath, config.agentId);
    this.nats = new NatsHandler({
      agentId: config.agentId,
      role: config.role as 'orchestrator' | 'dev' | 'marketing',
      natsUrl: config.natsUrl,
      natsUrlThunderbolt: config.natsUrlThunderbolt,
      capabilities: config.capabilities,
      machineId: config.machineId,
      hostname: config.hostname,
    });
  }

  async start(): Promise<void> {
    log.info(`Starting agent ${this.config.agentId} (${this.config.role}) on ${this.config.hostname}`);
    this.running = true;

    // Initialize sessions directory
    await this.sessions.init();

    // ─── Connect to NATS first (before plugins to avoid networking issues) ───
    await this.nats.connect();

    // ─── Load Plugin System ───
    this.runtimeConfig = {
      agentId: this.config.agentId,
      role: this.config.role,
      hostname: this.config.hostname,
      workspacePath: this.config.workspacePath,
      nasPath: this.config.nasMountPath,
      defaultModel: this.config.defaultModel,
      socialConfig: this.config.socialConfig,
    };

    try {
      const pluginPromise = loadPlugins({
        runtimeConfig: this.runtimeConfig,
        nasPath: this.config.nasMountPath,
        enableBuiltins: true,
      });
      // Timeout plugin loading to prevent blocking startup indefinitely
      this.pluginSystem = await Promise.race([
        pluginPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Plugin load timeout (30s)')), 30_000)),
      ]);
      this.hooks = this.pluginSystem.hookRunner;
      this.pluginRegistry = this.pluginSystem.registry;

      // Start plugin services (with separate timeout)
      try {
        this.serviceStopFns = await Promise.race([
          this.pluginSystem.registry.startServices(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Service start timeout (15s)')), 15_000)),
        ]);
      } catch (svcErr) {
        log.warn(`Plugin services failed to start (plugins still available): ${(svcErr as Error).message}`);
      }

      log.info(`Plugin system ready: ${this.pluginSystem.registry.getSummary()}`);
    } catch (err) {
      log.warn(`Plugin system failed to load (continuing without plugins): ${(err as Error).message}`);
    }

    // ─── Fire agent_start hook ───
    if (this.hooks) {
      await this.hooks.runAgentStart(
        { agentId: this.config.agentId, role: this.config.role, hostname: this.config.hostname },
        { agentId: this.config.agentId },
      );
    }

    // ─── Wire inter-agent tools to NATS ───
    this.tools.register(new MessageAgentTool(
      (subject, data) => this.nats.publish(subject, data),
    ));
    this.runtimeConfig.delegateTask = (targetAgent, task) =>
      this.nats.delegateTask(targetAgent, task);
    log.info('Inter-agent tools wired to NATS');

    // Set up task handler
    this.nats.onTask((task) => {
      this.handleTask(task).catch((err) => {
        log.error(`Task handler error: ${(err as Error).message}`);
      });
    });

    // Set up chat handler
    this.nats.onChat((msg) => {
      this.handleChat(msg).catch((err) => {
        log.error(`Chat handler error: ${(err as Error).message}`);
      });
    });

    // Set up inter-agent communication handlers
    this.nats.onDM((msg) => {
      log.info(`Received DM from ${msg.from}: ${(msg.content || '').slice(0, 80)}`);
      this.handleInterAgentMessage(msg).catch((err) => {
        log.error(`DM handler error: ${(err as Error).message}`);
      });
    });

    this.nats.onBroadcast((msg) => {
      log.info(`Received broadcast from ${msg.from}: ${(msg.content || '').slice(0, 80)}`);
      // Only process broadcasts that need action (e.g., queries)
      if (msg.type === 'query') {
        this.handleInterAgentMessage(msg).catch((err) => {
          log.error(`Broadcast handler error: ${(err as Error).message}`);
        });
      }
    });

    this.nats.onCoordination((msg) => {
      log.info(`Received coordination from ${msg.from}: ${(msg.content || '').slice(0, 80)}`);
      this.handleCoordinationRequest(msg).catch((err) => {
        log.error(`Coordination handler error: ${(err as Error).message}`);
      });
    });

    log.info(`Agent ${this.config.agentId} is ready and listening for tasks (peers: ${this.nats.getPeers().length})`);
  }

  async stop(): Promise<void> {
    log.info(`Stopping agent ${this.config.agentId}`);
    this.running = false;

    // Fire agent_end hook
    if (this.hooks) {
      await this.hooks.runAgentEnd(
        { agentId: this.config.agentId, reason: 'shutdown' },
        { agentId: this.config.agentId },
      );
    }

    // Stop plugin services
    for (const stopFn of this.serviceStopFns) {
      try { stopFn(); } catch { /* ignore */ }
    }

    await this.nats.updateStatus('offline');
    await this.nats.disconnect();
  }

  /** Pending task queue — tasks that arrive while busy are queued instead of dropped */
  private taskQueue: Array<TaskAssignment & { queuedAt: number }> = [];
  private static readonly MAX_QUEUE_SIZE = 5;
  private static readonly TASK_QUEUE_TTL_MS = 5 * 60 * 1000; // 5 min TTL for queued tasks

  /** Handle an incoming task assignment */
  private async handleTask(task: TaskAssignment): Promise<void> {
    // Mutex: prevent race condition when two tasks arrive simultaneously
    if (this.taskProcessing || this.currentTask) {
      if (this.taskQueue.length < AgentRunner.MAX_QUEUE_SIZE) {
        this.taskQueue.push({ ...task, queuedAt: Date.now() });
        log.info(`Queued task ${task.taskId} (queue size: ${this.taskQueue.length})`);
        await this.nats.publishProgress(task.taskId, { step: 'queued', log: `Task queued behind ${this.currentTask?.taskId ?? 'processing task'}` });
      } else {
        log.warn(`Task queue full (${AgentRunner.MAX_QUEUE_SIZE}), rejecting ${task.taskId}`);
        await this.nats.publishResult(task.taskId, { success: false, output: `Agent ${this.config.agentId} queue full — task rejected` });
      }
      return;
    }

    this.taskProcessing = true;
    this.currentTask = task;
    log.info(`Starting task: ${task.taskId} - ${task.title}`);

    // Fire task_assigned hook
    if (this.hooks) {
      await this.hooks.runTaskAssigned(
        { taskId: task.taskId, title: task.title, description: task.description, priority: task.priority },
        { agentId: this.config.agentId },
      );
    }

    try {
      await this.nats.updateStatus('busy', task.taskId, task.title);

      const sessionId = await this.sessions.createSession(task.taskId);
      this.taskSessionId = sessionId;

      // Fire session_start hook
      if (this.hooks) {
        await this.hooks.runSessionStart(
          { sessionId, agentId: this.config.agentId, taskId: task.taskId },
          { agentId: this.config.agentId, sessionId },
        );
      }

      const systemPrompt = await this.buildEnhancedSystemPrompt({
        currentTask: `<task_context>\n<title>${task.title}</title>\n<description>${task.description}</description>\n<priority>${task.priority}</priority>\n</task_context>`,
      });

      const userMessage = task.description || task.title;

      // Fire message_received hook
      if (this.hooks) {
        await this.hooks.runMessageReceived(
          { role: 'user', content: userMessage, source: 'task' },
          { agentId: this.config.agentId, sessionId },
        );
      }

      const result = await this.runAgentLoop(sessionId, systemPrompt, userMessage);

      // Fire session_end hook
      if (this.hooks) {
        await this.hooks.runSessionEnd(
          { sessionId, agentId: this.config.agentId, tokenUsage: result.usage },
          { agentId: this.config.agentId, sessionId },
        );
      }

      await this.nats.publishResult(task.taskId, {
        success: true,
        output: result.output,
        artifacts: result.artifacts,
      });

      // Write result file to NAS so the delegating agent can check status
      if (task.taskId.startsWith('delegated-')) {
        try {
          const plansDir = join(this.config.nasMountPath, 'plans');
          mkdirSync(plansDir, { recursive: true });
          writeFileSync(
            join(plansDir, `result-${task.taskId}.json`),
            JSON.stringify({
              taskId: task.taskId,
              title: task.title,
              status: 'completed',
              agentId: this.config.agentId,
              output: result.output.slice(0, 5000),
              artifacts: result.artifacts,
              completedAt: Date.now(),
            }, null, 2),
          );
        } catch (err) {
          log.warn(`Failed to write delegation result file: ${(err as Error).message}`);
        }
      }

      this.nats.trackTaskComplete(true);

      // Fire task_completed hook
      if (this.hooks) {
        await this.hooks.runTaskCompleted(
          { taskId: task.taskId, output: result.output, artifacts: result.artifacts },
          { agentId: this.config.agentId, sessionId },
        );
      }

      await this.nats.broadcastDashboard('task.completed', {
        taskId: task.taskId,
        agentId: this.config.agentId,
        output: result.output.slice(0, 500),
      });

      log.info(`Task completed: ${task.taskId}`);
    } catch (err) {
      log.error(`Task failed: ${task.taskId} - ${(err as Error).message}`);

      // Fire task_failed hook
      if (this.hooks) {
        await this.hooks.runTaskFailed(
          { taskId: task.taskId, error: (err as Error).message },
          { agentId: this.config.agentId },
        );
      }

      await this.nats.publishResult(task.taskId, {
        success: false,
        output: `Error: ${(err as Error).message}`,
      });

      // Write failure result file to NAS for delegating agent
      if (task.taskId.startsWith('delegated-')) {
        try {
          const plansDir = join(this.config.nasMountPath, 'plans');
          mkdirSync(plansDir, { recursive: true });
          writeFileSync(
            join(plansDir, `result-${task.taskId}.json`),
            JSON.stringify({
              taskId: task.taskId,
              title: task.title,
              status: 'failed',
              agentId: this.config.agentId,
              output: (err as Error).message,
              completedAt: Date.now(),
            }, null, 2),
          );
        } catch (writeErr) {
          log.warn(`Failed to write delegation result file: ${(writeErr as Error).message}`);
        }
      }

      this.nats.trackTaskComplete(false);

      await this.nats.broadcastDashboard('task.failed', {
        taskId: task.taskId,
        agentId: this.config.agentId,
        error: (err as Error).message,
      });
    } finally {
      this.currentTask = null;
      this.taskSessionId = null;
      this.taskProcessing = false;
      await this.nats.updateStatus('idle');

      // Expire stale queued tasks before processing next
      const now = Date.now();
      const expired = this.taskQueue.filter(t => now - t.queuedAt > AgentRunner.TASK_QUEUE_TTL_MS);
      for (const stale of expired) {
        log.warn(`Expiring stale queued task ${stale.taskId} (queued ${Math.round((now - stale.queuedAt) / 1000)}s ago)`);
        try {
          await this.nats.publishResult(stale.taskId, { success: false, output: 'Task expired while queued (TTL exceeded)' });
        } catch (err) {
          log.warn(`Failed to publish expiry result for ${stale.taskId}: ${(err as Error).message}`);
        }
      }
      this.taskQueue = this.taskQueue.filter(t => now - t.queuedAt <= AgentRunner.TASK_QUEUE_TTL_MS);

      // Process next queued task if any
      if (this.taskQueue.length > 0) {
        const next = this.taskQueue.shift()!;
        log.info(`Dequeuing next task: ${next.taskId} (remaining: ${this.taskQueue.length})`);
        this.handleTask(next).catch((err) => {
          log.error(`Queued task handler error: ${(err as Error).message}`);
        });
      }
    }
  }

  /** Handle chat messages from dashboard or external channels (WhatsApp, etc.) */
  private async handleChat(msg: { from: string; content: string; sessionId?: string; metadata?: Record<string, unknown> }): Promise<void> {
    if (this.chatProcessing) {
      // Never queue inter-agent messages — they are responses/DMs that would cause
      // re-processing loops (agent responds → queued as chat → LLM acts again → loop)
      const isAgentMessage = msg.metadata?.source === 'agent-dm';
      if (isAgentMessage) {
        log.info(`Dropping inter-agent message from ${msg.from} (busy with chat)`);
        return;
      }

      // Queue user messages instead of dropping
      if (this.chatQueue.length < AgentRunner.MAX_CHAT_QUEUE_SIZE) {
        this.chatQueue.push({ ...msg, queuedAt: Date.now() });
        log.info(`Chat queued from ${msg.from} (queue size: ${this.chatQueue.length})`);
        await this.nats.sendChatResponse(
          `Your message has been queued (position ${this.chatQueue.length}). I'm currently processing another message and will get to yours shortly.`,
          msg.sessionId ? { sessionId: msg.sessionId } : undefined,
        );
      } else {
        log.warn(`Chat queue full (${AgentRunner.MAX_CHAT_QUEUE_SIZE}), dropping message from ${msg.from}`);
        await this.nats.sendChatResponse(
          `I'm currently busy and my message queue is full. Please try again in a moment.`,
          msg.sessionId ? { sessionId: msg.sessionId } : undefined,
        );
      }
      return;
    }

    this.chatProcessing = true;
    // Track the external session ID for routing responses back
    const externalSessionId = msg.sessionId;

    try {
      // Clear idle timeout since we're starting a new chat
      if (this.chatSessionTimeout) {
        clearTimeout(this.chatSessionTimeout);
        this.chatSessionTimeout = null;
      }

      if (!this.currentSessionId) {
        const sessionId = await this.sessions.createSession();
        this.currentSessionId = sessionId;

        // Fire session_start hook for new chat session
        if (this.hooks) {
          await this.hooks.runSessionStart(
            { sessionId, agentId: this.config.agentId },
            { agentId: this.config.agentId, sessionId },
          );
        }
      }

      let systemPrompt = await this.buildEnhancedSystemPrompt();

      // Inject channel-specific instructions when message comes from an external channel
      if (msg.metadata?.source === 'whatsapp') {
        systemPrompt += `\n\n## CRITICAL: WhatsApp Channel Response Rules

This chat message arrived from WhatsApp. Your text response will be automatically delivered back to the user on WhatsApp. Follow these rules STRICTLY:

1. **NEVER use the imessage tool** to reply — your text response IS the reply. Do NOT send iMessages or SMS.
2. **NEVER use any messaging tool** (imessage, send_sms, etc.) to respond to this conversation.
3. **Just respond with text.** Whatever you write as your final response will be sent to WhatsApp automatically.
4. **You CAN and SHOULD use other tools** (browser, terminal, file operations, screenshots, etc.) to fulfill the user's request — just don't use messaging tools for the reply.
5. **Execute the user's request** — if they ask you to open YouTube, run a command, take a screenshot, etc., DO IT using the appropriate tools, then describe what you did in your text response.`;
      }

      await this.nats.updateStatus('busy', undefined, `Chat: ${msg.content.slice(0, 60)}`);
      log.info(`Processing chat from ${msg.from}: ${msg.content.slice(0, 100)}`);

      // Fire message_received hook
      if (this.hooks) {
        await this.hooks.runMessageReceived(
          { role: 'user', content: msg.content, source: msg.metadata?.source as string ?? 'chat' },
          { agentId: this.config.agentId, sessionId: this.currentSessionId },
        );
      }

      const result = await this.runAgentLoop(this.currentSessionId, systemPrompt, msg.content, externalSessionId);

      const responseMeta: Record<string, unknown> = {};
      if (externalSessionId) responseMeta.sessionId = externalSessionId;
      if (msg.metadata?.source) responseMeta.source = msg.metadata.source;
      if (result.thinking) responseMeta.thinking = result.thinking;

      await this.nats.sendChatResponse(result.output, Object.keys(responseMeta).length > 0 ? responseMeta : undefined);
      log.info(`Chat response sent (${result.output.length} chars)`);

      // Fire session_end hook for chat session
      if (this.hooks && this.currentSessionId) {
        await this.hooks.runSessionEnd(
          { sessionId: this.currentSessionId, agentId: this.config.agentId, tokenUsage: result.usage },
          { agentId: this.config.agentId, sessionId: this.currentSessionId },
        );
      }
    } catch (err) {
      log.error(`Chat error: ${(err as Error).message}`);
      const errorMeta: Record<string, unknown> = {};
      if (externalSessionId) errorMeta.sessionId = externalSessionId;
      await this.nats.sendChatResponse(`Error: ${(err as Error).message}`, Object.keys(errorMeta).length > 0 ? errorMeta : undefined);
    } finally {
      this.chatProcessing = false;
      // Keep session alive for multi-turn conversation.
      // Session will be reset after idle timeout (10 min) or when a new task starts.
      this.chatSessionTimeout = setTimeout(() => {
        this.currentSessionId = null;
        this.chatSessionTimeout = null;
      }, 10 * 60 * 1000);
      if (!this.currentTask) {
        await this.nats.updateStatus('idle');
      }

      // Drain next queued user chat message if any
      if (this.chatQueue.length > 0) {
        // Filter out any agent messages that may have been queued
        this.chatQueue = this.chatQueue.filter((m) => m.metadata?.source !== 'agent-dm');
        if (this.chatQueue.length > 0) {
          const next = this.chatQueue.shift()!;
          log.info(`Dequeuing next chat from ${next.from} (remaining: ${this.chatQueue.length})`);
          this.handleChat(next).catch((err) => {
            log.error(`Queued chat handler error: ${(err as Error).message}`);
          });
        }
      }
    }
  }

  /** Handle direct messages or queries from other agents */
  private async handleInterAgentMessage(msg: InterAgentMsg): Promise<void> {
    if (!msg.content) return;

    // Route as chat message with metadata indicating it's from another agent
    await this.handleChat({
      from: msg.from,
      content: `<inter_agent_message from="${msg.from}">\n${msg.content}\n</inter_agent_message>`,
      metadata: { source: 'agent-dm', fromAgent: msg.from, replyTo: msg.replyTo, originalType: msg.type },
    });

    // If it was a query, send response back as DM
    // The chat handler will produce the response via sendChatResponse
  }

  /** Handle coordination/delegation requests from other agents */
  private async handleCoordinationRequest(msg: InterAgentMsg): Promise<void> {
    const payload = msg.payload as { taskId?: string; title?: string; description?: string; priority?: string } | undefined;

    if (this.currentTask || this.chatProcessing) {
      // Busy — accept and queue instead of rejecting
      if (payload?.title) {
        const taskId = payload.taskId || `delegated-${msg.id}`;
        await this.nats.respondCoordination(msg.id, true);
        // Queue via handleTask which has built-in queueing
        await this.handleTask({
          taskId,
          title: payload.title,
          description: payload.description || payload.title,
          priority: payload.priority || 'normal',
          context: { delegatedBy: msg.from },
        });
        return;
      }
    }

    // Accept delegation and process as task
    if (payload?.title) {
      // Use the originator's taskId if provided, otherwise generate one
      const taskId = payload.taskId || `delegated-${msg.id}`;
      await this.nats.respondCoordination(msg.id, true);
      await this.handleTask({
        taskId,
        title: payload.title,
        description: payload.description || payload.title,
        priority: payload.priority || 'normal',
        context: { delegatedBy: msg.from },
      });
    } else {
      await this.nats.respondCoordination(msg.id, false, 'no task payload');
    }
  }

  /**
   * Build enhanced system prompt with plugin sections and skills.
   */
  private async buildEnhancedSystemPrompt(options?: { currentTask?: string }): Promise<string> {
    // Build dynamic network info from NATS peer discovery
    const peers = this.nats.getPeers();
    const natsUrl = process.env['NATS_URL'] ?? 'nats://localhost:4222';
    const gatewayUrl = process.env['GATEWAY_URL'] ?? `http://${this.nats.localIp}:18900`;
    const networkInfo = {
      selfIp: this.nats.localIp,
      natsUrl,
      gatewayUrl,
      natsAuth: !!(process.env['NATS_TOKEN'] || process.env['NATS_USER']),
      peers: peers.map((p) => ({
        agentId: p.agentId,
        role: p.role,
        hostname: p.hostname,
        ip: p.ip || '',
        status: p.status,
      })),
    };

    // Base prompt from templates
    let systemPrompt = buildSystemPrompt({
      agentId: this.config.agentId,
      role: this.config.role,
      hostname: this.config.hostname,
      workspacePath: this.config.workspacePath,
      nasPath: this.config.nasMountPath,
      currentTask: options?.currentTask,
      capabilities: this.tools.listTools(),
      network: networkInfo,
    });

    // ─── Add skills section ───
    const skills = loadSkills(this.config.nasMountPath);
    if (skills.length > 0) {
      systemPrompt += '\n\n' + buildSkillsPromptSection(skills);
    }

    // ─── Add inter-agent awareness ───
    if (peers.length > 0) {
      const peerLines = peers.map((p) =>
        `- **${p.agentId}** (role: ${p.role}, machine: ${p.hostname}${p.ip ? ` / ${p.ip}` : ''}, status: ${p.status}, capabilities: ${p.capabilities.join(', ')})`
      ).join('\n');
      systemPrompt += `\n\n## Connected Agents\n\nYou are part of a multi-agent system. The following agents are currently online:\n${peerLines}\n\nYou can coordinate with them using:\n- \`message_agent\` — send messages, queries, notifications, or delegation requests to other agents\n- \`delegate_to_agent\` — delegate a structured task to another agent (non-blocking, with progress tracking)`;
    } else {
      systemPrompt += `\n\n## Connected Agents\n\nYou are part of a multi-agent system but no other agents are currently online. You are operating solo.`;
    }

    // ─── Add plugin prompt sections ───
    if (this.pluginRegistry) {
      const sections = this.pluginRegistry.getPromptSections();
      for (const section of sections) {
        systemPrompt += `\n\n## ${section.title}\n\n${section.content}`;
      }
    }

    // ─── Fire before_prompt_build hook ───
    if (this.hooks) {
      const hookResult = await this.hooks.runBeforePromptBuild(
        {
          role: this.config.role,
          agentId: this.config.agentId,
          currentTask: options?.currentTask,
        },
        { agentId: this.config.agentId, sessionId: this.taskSessionId ?? this.currentSessionId ?? undefined },
      );

      if (hookResult) {
        if (hookResult.systemPromptOverride) {
          systemPrompt = hookResult.systemPromptOverride;
        }
        if (hookResult.prependContext) {
          systemPrompt = hookResult.prependContext + '\n\n' + systemPrompt;
        }
        if (hookResult.appendContext) {
          systemPrompt += '\n\n' + hookResult.appendContext;
        }
      }
    }

    return systemPrompt;
  }

  /**
   * Get combined tool definitions (core tools + plugin tools).
   */
  private getToolDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    const coreTools = this.tools.getDefinitions();

    // Add plugin tools
    if (this.pluginRegistry) {
      const pluginTools = this.pluginRegistry.resolveTools({
        agentId: this.config.agentId,
        workspacePath: this.config.workspacePath,
        nasPath: this.config.nasMountPath,
        sessionId: this.taskSessionId ?? this.currentSessionId ?? undefined,
      });

      const pluginDefs = pluginTools.map((t) => t.definition);
      // Deduplicate by name (core tools take priority)
      const coreNames = new Set(coreTools.map(t => t.name));
      const uniquePluginDefs = pluginDefs.filter(d => !coreNames.has(d.name));

      return [...coreTools, ...uniquePluginDefs];
    }

    return coreTools;
  }

  /**
   * Execute a tool by name, checking core tools first then plugin tools.
   */
  private async executeTool(
    name: string,
    params: Record<string, unknown>,
    context: { agentId: string; workspacePath: string; nasPath: string; sessionId: string },
  ) {
    // Try core tools first
    if (this.tools.has(name)) {
      return this.tools.execute(name, params, context);
    }

    // Try plugin tools
    if (this.pluginRegistry) {
      const pluginTools = this.pluginRegistry.resolveTools({
        agentId: context.agentId,
        workspacePath: context.workspacePath,
        nasPath: context.nasPath,
        sessionId: context.sessionId,
      });

      const pluginTool = pluginTools.find(t => t.definition.name === name);
      if (pluginTool) {
        return pluginTool.execute(params, context);
      }
    }

    return { type: 'error' as const, content: `Unknown tool: ${name}` };
  }

  /**
   * Consume a streaming response from chatStream, accumulating into a ChatResponse.
   * Publishes throttled deltas via NATS for real-time dashboard updates.
   */
  private async consumeStream(
    stream: AsyncIterable<ChatChunk>,
    sessionId: string,
    round: number,
  ): Promise<ChatResponse> {
    const content: ContentBlock[] = [];
    let currentText = '';
    let currentThinking = '';
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';
    let stopReason: ChatResponse['stopReason'] = 'end_turn';
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    // Throttle: send at most one delta per 100ms per phase
    let lastStreamTime = 0;
    const THROTTLE_MS = 100;

    const sendThrottled = async (phase: 'thinking' | 'text' | 'tool_start', text?: string, toolName?: string) => {
      const now = Date.now();
      if (now - lastStreamTime < THROTTLE_MS) return;
      lastStreamTime = now;
      try {
        await this.nats.sendChatStream({ phase, text, toolName, sessionId, round });
      } catch { /* non-critical */ }
    };

    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'thinking_start':
          currentThinking = '';
          break;

        case 'thinking_delta':
          currentThinking += chunk.thinking ?? '';
          await sendThrottled('thinking', currentThinking);
          break;

        case 'thinking_end':
          if (currentThinking) {
            content.push({ type: 'thinking', thinking: currentThinking });
          }
          break;

        case 'text_delta':
          currentText += chunk.text ?? '';
          await sendThrottled('text', currentText);
          break;

        case 'tool_use_start':
          // Flush accumulated text (strip any <tool_call> XML from CLI provider)
          if (currentText) {
            const cleaned = currentText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
            if (cleaned) content.push({ type: 'text', text: cleaned });
            currentText = '';
          }
          currentToolId = chunk.toolCall?.id ?? '';
          currentToolName = chunk.toolCall?.name ?? '';
          currentToolInput = '';
          await sendThrottled('tool_start', undefined, currentToolName);
          break;

        case 'tool_use_delta':
          currentToolInput = chunk.toolCall?.input ?? currentToolInput;
          break;

        case 'tool_use_end': {
          let parsedInput: Record<string, unknown> = {};
          try { parsedInput = JSON.parse(currentToolInput || '{}'); } catch { /* empty */ }
          content.push({
            type: 'tool_use',
            id: currentToolId,
            name: currentToolName,
            input: parsedInput,
          });
          currentToolId = '';
          currentToolName = '';
          currentToolInput = '';
          break;
        }

        case 'message_end':
          // Flush remaining text (strip any <tool_call> XML from CLI provider)
          if (currentText) {
            const cleanedEnd = currentText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
            if (cleanedEnd) content.push({ type: 'text', text: cleanedEnd });
            currentText = '';
          }
          if (chunk.stopReason) stopReason = chunk.stopReason;
          if (chunk.usage) {
            usage.inputTokens += chunk.usage.inputTokens;
            usage.outputTokens += chunk.usage.outputTokens;
            usage.totalTokens += chunk.usage.totalTokens;
            if (chunk.usage.cacheReadTokens) usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + chunk.usage.cacheReadTokens;
            if (chunk.usage.cacheWriteTokens) usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + chunk.usage.cacheWriteTokens;
          }
          break;

        case 'error':
          throw new Error(`Stream error: ${chunk.error}`);
      }
    }

    // Flush any remaining text that wasn't flushed (strip any <tool_call> XML)
    if (currentText) {
      const cleanedFinal = currentText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
      if (cleanedFinal) content.push({ type: 'text', text: cleanedFinal });
    }

    // Compute totalTokens from accumulated input + output (avoids double-counting
    // when the provider emits partial totals in individual chunks).
    usage.totalTokens = usage.inputTokens + usage.outputTokens;

    // NOTE: Do NOT send 'done' here — it kills the stream indicator in the dashboard
    // while tools are still executing. 'done' is sent at the end of runAgentLoop instead.

    return {
      content,
      stopReason,
      usage,
      model: '',
    };
  }

  /**
   * Core agent loop: LLM -> parse -> tools -> LLM -> repeat
   *
   * This is the heart of the agent execution engine.
   * Now with full plugin hook integration.
   */
  private async runAgentLoop(
    sessionId: string,
    systemPrompt: string,
    userMessage: string,
    streamSessionId?: string,
  ): Promise<{ output: string; artifacts: string[]; thinking?: string; usage: TokenUsage }> {
    let messages: Message[] = [];
    const usage = createUsageAccumulator();
    const artifacts: string[] = [];
    let allThinking = '';
    let consecutiveErrors = 0;
    let emptyRetries = 0;
    let activeModel = this.config.defaultModel;

    // Load existing context if resuming, sanitize to prevent API errors
    const existingMessages = await this.sessions.loadMessagesForContext(sessionId);
    messages.push(...sanitizeMessages(existingMessages));

    // Add the new user message
    messages.push({ role: 'user', content: userMessage });
    await this.sessions.appendMessage(sessionId, 'user', userMessage);

    // ─── Hook: before_model_resolve ───
    if (this.hooks) {
      const modelResult = await this.hooks.runBeforeModelResolve(
        { prompt: userMessage, currentModel: activeModel },
        { agentId: this.config.agentId, sessionId },
      );
      if (modelResult?.modelOverride) {
        log.info(`Model overridden by plugin: ${activeModel} -> ${modelResult.modelOverride}`);
        activeModel = modelResult.modelOverride;
      }
    }

    const sendDone = async () => {
      try {
        await this.nats.sendChatStream({ phase: 'done', sessionId: streamSessionId ?? sessionId, round: 0 });
      } catch { /* non-critical */ }
    };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (!this.running) break;

      log.info(`Agent loop round ${round + 1}/${MAX_TOOL_ROUNDS}`);

      const toolDefs = this.getToolDefinitions();
      const toolDefsLen = JSON.stringify(toolDefs).length;

      // Strip base64 images from older messages before trimming
      messages = stripOldImages(messages);
      // Compact large write/edit tool_use blocks in older messages (e.g. 40KB HTML files)
      messages = compactWriteToolUse(messages);
      // Trim context if it's getting too large to prevent "Prompt is too long"
      messages = trimMessagesToFit(messages, systemPrompt.length, toolDefsLen);

      const request: ChatRequest = {
        model: activeModel,
        messages,
        system: systemPrompt,
        tools: toolDefs,
        max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
        stream: true,
      };

      // ─── Hook: llm_input ───
      if (this.hooks) {
        const llmInputResult = await this.hooks.runLlmInput(
          {
            model: activeModel,
            messages: messages as unknown[],
            systemPrompt,
            tools: toolDefs as unknown[],
          },
          { agentId: this.config.agentId, sessionId },
        );
        if (llmInputResult?.systemPromptOverride) {
          request.system = llmInputResult.systemPromptOverride;
        }
      }

      // Call LLM via streaming
      let response: ChatResponse;
      try {
        const stream = this.providers.chatStream(request);
        response = await this.consumeStream(stream, streamSessionId ?? sessionId, round + 1);
        response.model = activeModel;
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        log.error(`LLM call failed (attempt ${consecutiveErrors}): ${(err as Error).message}`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error(`LLM failed ${MAX_CONSECUTIVE_ERRORS} times consecutively`);
        }
        // Exponential backoff: 2s, 4s, 8s, 16s, capped at 30s
        const backoffMs = Math.min(2000 * Math.pow(2, consecutiveErrors - 1), 30_000);
        log.info(`Retrying in ${backoffMs}ms...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      // Track usage
      mergeUsage(usage, response.usage);
      await this.sessions.appendUsage(sessionId, response.usage);

      // Guard: ensure response.content is always an array
      if (!response.content || !Array.isArray(response.content)) {
        log.warn('Response has no content array — treating as empty response');
        response.content = [];
      }

      // ─── Hook: llm_output (after content guard) ───
      if (this.hooks) {
        await this.hooks.runLlmOutput(
          {
            model: activeModel,
            content: response.content as unknown[],
            stopReason: response.stopReason,
            usage: response.usage,
          },
          { agentId: this.config.agentId, sessionId },
        );
      }

      // Add assistant response to messages
      messages.push({ role: 'assistant', content: response.content });
      await this.sessions.appendMessage(sessionId, 'assistant', response.content);

      // Collect thinking from this round
      const roundThinking = response.content
        .filter((b): b is ThinkingBlock => b.type === 'thinking')
        .map((b) => b.thinking)
        .join('\n');
      if (roundThinking) {
        allThinking += (allThinking ? '\n\n' : '') + roundThinking;
      }

      // Log progress
      this.logRound(round, response, usage);

      // Stream: send text content from this round so dashboard shows what agent is saying
      const roundText = response.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .trim();
      if (roundText) {
        try {
          await this.nats.sendChatStream({
            phase: 'text',
            text: roundText,
            sessionId: streamSessionId ?? sessionId,
            round: round + 1,
          });
        } catch { /* non-critical */ }
      }

      // Detect empty/zero-token responses (rate limiting, CLI failures, etc.)
      const hasAnyContent = response.content.some(
        (b) => (b.type === 'text' && b.text?.trim()) || b.type === 'tool_use',
      );
      if (!hasAnyContent && response.usage.totalTokens === 0) {
        emptyRetries++;
        log.warn(`Empty response (0 tokens, no content) — retry ${emptyRetries}/${MAX_EMPTY_RETRIES}`);
        // Remove the empty assistant message from history
        if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
          messages.pop();
        }
        if (emptyRetries >= MAX_EMPTY_RETRIES) {
          log.error('Max empty retries reached — giving up');
          await sendDone();
          return {
            output: '(Task failed: LLM returned empty responses — possible rate limiting)',
            artifacts,
            thinking: allThinking || undefined,
            usage,
          };
        }
        const backoffMs = 3000 * emptyRetries;
        log.info(`Waiting ${backoffMs}ms before retry...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      emptyRetries = 0; // reset on successful response

      // Check if assistant is done (no tool calls)
      if (response.stopReason !== 'tool_use') {
        const textContent = response.content
          .filter((b): b is TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        await sendDone();
        return {
          output: textContent || '(Task completed with no text output)',
          artifacts,
          thinking: allThinking || undefined,
          usage,
        };
      }

      // Execute tool calls
      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) {
        const textContent = response.content
          .filter((b): b is TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        await sendDone();
        return {
          output: textContent || '(Task completed)',
          artifacts,
          thinking: allThinking || undefined,
          usage,
        };
      }

      const toolResults: ContentBlock[] = [];

      for (const toolUse of toolUses) {
        log.info(`Executing tool: ${toolUse.name} (${toolUse.id})`);
        await this.sessions.appendToolCall(sessionId, toolUse.name, toolUse.id, toolUse.input);

        // ─── Hook: before_tool_call ───
        let toolInput = toolUse.input;
        if (this.hooks) {
          const beforeResult = await this.hooks.runBeforeToolCall(
            { toolName: toolUse.name, toolId: toolUse.id, input: toolUse.input },
            { agentId: this.config.agentId, sessionId },
          );
          if (beforeResult?.block) {
            log.warn(`Tool ${toolUse.name} blocked by plugin: ${beforeResult.blockReason ?? 'no reason'}`);
            const blockedResult: ToolResultBlock = {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Tool blocked by policy: ${beforeResult.blockReason ?? 'blocked by plugin hook'}`,
              is_error: true,
            };
            toolResults.push(blockedResult);
            continue;
          }
          if (beforeResult?.inputOverride) {
            toolInput = beforeResult.inputOverride;
          }
        }

        // Broadcast tool activity to dashboard
        await this.nats.broadcastDashboard('agent.activity', {
          agentId: this.config.agentId,
          type: 'tool_call',
          tool: toolUse.name,
          input: JSON.stringify(toolInput).slice(0, 200),
        });

        // Stream event: tool execution start (visible in dashboard chat)
        try {
          await this.nats.sendChatStream({
            phase: 'tool_start',
            toolName: toolUse.name,
            sessionId: streamSessionId ?? sessionId,
            round: round + 1,
          });
        } catch { /* non-critical */ }

        const startTime = Date.now();
        let result: Awaited<ReturnType<typeof this.executeTool>>;
        try {
          result = await Promise.race([
            this.executeTool(toolUse.name, toolInput, {
              agentId: this.config.agentId,
              workspacePath: this.config.workspacePath,
              nasPath: this.config.nasMountPath,
              sessionId,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Tool '${toolUse.name}' timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)
            ),
          ]);
        } catch (err) {
          log.error(`Tool ${toolUse.name} failed: ${(err as Error).message}`);
          result = { type: 'error' as const, content: (err as Error).message };
        }
        const elapsed = Date.now() - startTime;

        // Stream event: tool result summary (visible in dashboard chat)
        try {
          const summary = result.type === 'error'
            ? `❌ ${toolUse.name}: ${result.content.slice(0, 100)}`
            : result.type === 'image'
              ? `📸 ${toolUse.name}: screenshot captured`
              : `✅ ${toolUse.name} (${elapsed}ms)`;
          await this.nats.sendChatStream({
            phase: 'text',
            text: summary,
            sessionId: streamSessionId ?? sessionId,
            round: round + 1,
          });
        } catch { /* non-critical */ }

        // ─── Hook: after_tool_call ───
        if (this.hooks) {
          const afterResult = await this.hooks.runAfterToolCall(
            { toolName: toolUse.name, toolId: toolUse.id, input: toolInput, result, elapsed },
            { agentId: this.config.agentId, sessionId },
          );
          if (afterResult?.resultOverride) {
            result = afterResult.resultOverride;
          }
        }

        await this.sessions.appendToolResult(sessionId, toolUse.id, result);

        if (result.metadata?.['filePath']) {
          artifacts.push(result.metadata['filePath'] as string);
        }

        let toolResultContent: string | ContentBlock[];

        if (result.type === 'image') {
          // Image result (e.g., from screenshot) — send as image content block
          toolResultContent = [
            {
              type: 'image' as const,
              data: result.content,
              mediaType: (result.metadata?.['mediaType'] as 'image/png') || 'image/png',
            },
          ];
          log.info(`Tool ${toolUse.name} returned image (${(result.content.length / 1024).toFixed(0)}KB)`);
        } else {
          // Cap text tool results at 10k chars to prevent context bloat
          toolResultContent = typeof result.content === 'string' && result.content.length > 10_000
            ? result.content.slice(0, 10_000) + '\n...[truncated, output was ' + result.content.length + ' chars]'
            : result.content;
        }

        const toolResultBlock: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: toolResultContent,
          is_error: result.type === 'error',
        };

        toolResults.push(toolResultBlock);
      }

      // Add tool results as user message (Anthropic format)
      messages.push({ role: 'user', content: toolResults });

      // Report task progress
      if (this.currentTask) {
        await this.nats.publishProgress(this.currentTask.taskId, {
          step: `Round ${round + 1}: Executed ${toolUses.length} tool(s)`,
          percentage: Math.min(95, (round / MAX_TOOL_ROUNDS) * 100),
          log: toolUses.map((t) => t.name).join(', '),
        });
      }
    }

    // Hit max rounds
    await sendDone();
    const lastText = messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => typeof m.content === 'string' ? [m.content] : m.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text))
      .pop();

    return {
      output: lastText ?? `(Task ended after ${MAX_TOOL_ROUNDS} rounds)`,
      artifacts,
      thinking: allThinking || undefined,
      usage,
    };
  }

  private logRound(round: number, response: ChatResponse, usage: UsageAccumulator): void {
    const blocks = response.content ?? [];
    const toolCount = blocks.filter((b) => b.type === 'tool_use').length;
    const textLength = blocks
      .filter((b): b is TextBlock => b.type === 'text')
      .reduce((sum, b) => sum + (b.text?.length ?? 0), 0);

    log.info(
      `Round ${round + 1}: ${toolCount} tool calls, ${textLength} chars text, ` +
      `${response.usage.totalTokens} tokens (total: ${usage.totalTokens}), ` +
      `stop: ${response.stopReason}`,
    );
  }
}
