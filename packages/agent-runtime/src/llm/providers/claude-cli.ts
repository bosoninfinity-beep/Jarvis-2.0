/**
 * ClaudeCliProvider — Uses `claude` CLI subprocess as LLM backend.
 *
 * Bills to Claude Max subscription (no API key costs).
 * Spawns `claude -p` for each turn, parses JSON output.
 *
 * Tool handling: Tool definitions are passed via --system-prompt flag
 * (separate from conversation text) so they're always visible to the model.
 * Claude outputs <tool_call> JSON blocks which we parse into ToolUseBlock objects.
 */
import { createLogger } from '@jarvis/shared';
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type {
  LLMProvider, ChatRequest, ChatResponse, ChatChunk,
  ModelInfo, ContentBlock, Message, ToolDefinition, TokenUsage,
} from '../types.js';

const log = createLogger('llm:claude-cli');

/** Resolve claude binary path — check common locations */
function resolveClaudeBin(): string {
  if (process.env['CLAUDE_BIN']) return process.env['CLAUDE_BIN'];

  // Try `which claude` first
  try {
    const bin = execSync('which claude', { encoding: 'utf-8', timeout: 3000, env: { ...process.env, CLAUDECODE: '' } }).trim();
    if (bin) return bin;
  } catch { /* ignore */ }

  // Common NVM / Homebrew / local locations
  const candidates = [
    `${process.env['HOME']}/.local/bin/claude`,
    `${process.env['HOME']}/.nvm/versions/node/${process.version}/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'claude'; // fallback
}

const CLAUDE_BIN = resolveClaudeBin();

/** Timeout for Claude CLI subprocess (10 minutes) */
const SPAWN_TIMEOUT_MS = 600_000;

/** Jarvis tools that have built-in Claude CLI equivalents — skip from text injection */
const CLI_BUILTIN_TOOL_NAMES = new Set([
  'exec',        // → Bash
  'read',        // → Read
  'write',       // → Write
  'edit',        // → Edit
  'list',        // → Glob
  'search',      // → Grep
  'web_fetch',   // → WebFetch
  'web_search',  // → WebSearch
]);

/** Claude CLI built-in tools to enable via --tools flag */
const CLI_BUILTIN_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch';

/** Per-role MCP server configs — injected via --mcp-config */
const ROLE_MCP_CONFIGS: Record<string, Record<string, { command?: string; args?: string[]; url?: string; headers?: Record<string, string> }>> = {
  marketing: {
    // Gmail MCP for email outreach, newsletters, follow-ups
    ...(process.env['GMAIL_MCP_ENABLED'] === '1' ? {
      gmail: { command: 'npx', args: ['-y', '@anthropic/mcp-gmail'] },
    } : {}),
    // Google Calendar for content scheduling
    ...(process.env['GOOGLE_CALENDAR_MCP_ENABLED'] === '1' ? {
      'google-calendar': { command: 'npx', args: ['-y', '@anthropic/mcp-google-calendar'] },
    } : {}),
  },
  dev: {
    // GitHub for issues, PRs, repos
    ...(process.env['GITHUB_PERSONAL_ACCESS_TOKEN'] ? {
      github: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${process.env['GITHUB_PERSONAL_ACCESS_TOKEN']}` } },
    } : {}),
    // Firebase for Firestore, Hosting, Functions
    ...(process.env['FIREBASE_MCP_ENABLED'] === '1' ? {
      firebase: { command: 'npx', args: ['-y', 'firebase-tools@latest', 'mcp'] },
    } : {}),
  },
};

/** Per-role allowed tools — restricts what CLI built-ins each role can use */
const ROLE_ALLOWED_TOOLS: Record<string, string> = {
  marketing: 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch',
  dev: 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch',
  orchestrator: 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch',
};

/** Max API budget per CLI invocation (USD). 0 = unlimited (Max subscription). */
const MAX_BUDGET_USD = parseFloat(process.env['CLAUDE_CLI_MAX_BUDGET_USD'] ?? '0');

const ALLOWED_MODELS = new Set(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);

const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6 (CLI)', provider: 'claude-cli', contextWindow: 200000, maxOutputTokens: 32000, supportsTools: true, supportsVision: true, costPerInputToken: 0, costPerOutputToken: 0 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (CLI)', provider: 'claude-cli', contextWindow: 200000, maxOutputTokens: 64000, supportsTools: true, supportsVision: true, costPerInputToken: 0, costPerOutputToken: 0 },
];

/** Check if `claude` CLI is available */
function isClaudeAvailable(): boolean {
  try {
    const version = execSync(`"${CLAUDE_BIN}" --version`, { encoding: 'utf-8', timeout: 5000, env: { ...process.env, CLAUDECODE: '' } }).trim();
    log.info(`Claude CLI found: ${CLAUDE_BIN} (${version})`);
    return true;
  } catch (err) {
    log.warn(`Claude CLI check failed (${CLAUDE_BIN}): ${(err as Error).message?.slice(0, 100)}`);
    return false;
  }
}

/**
 * Build system prompt for --system-prompt flag.
 * Contains agent identity, instructions, and tool definitions.
 * Passed via CLI flag so it's ALWAYS visible to the model (never buried in text).
 */
function buildSystemPrompt(request: ChatRequest): string {
  const parts: string[] = [];

  if (request.system) {
    parts.push(request.system);
  }

  // Only inject CUSTOM tool definitions — built-in tools are handled natively by Claude CLI
  const customTools = request.tools?.filter(t => !CLI_BUILTIN_TOOL_NAMES.has(t.name)) ?? [];
  if (customTools.length > 0) {
    parts.push(buildToolPrompt(customTools));
  }

  return parts.join('\n\n');
}

/**
 * Build conversation prompt for stdin.
 * Contains ONLY conversation history (no system prompt, no tool definitions).
 * Tool definitions are in --system-prompt flag, so they don't get lost here.
 */
function buildConversationPrompt(request: ChatRequest): string {
  const parts: string[] = [];

  for (const msg of request.messages) {
    if (msg.role === 'system') continue;

    if (typeof msg.content === 'string') {
      parts.push(`${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}`);
    } else {
      // Handle content blocks
      const textParts = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text);

      // Serialize tool_use blocks back as <tool_call> tags so Claude sees its own tool calls in history
      // Compact large write/edit inputs to prevent context bloat (40KB HTML files etc.)
      const toolUseParts = msg.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const tu = b as { name: string; input: Record<string, unknown> };
          let input = tu.input;
          // Compact write tool: if content > 1KB, replace with summary
          if (tu.name === 'write' && typeof input?.content === 'string' && (input.content as string).length > 1000) {
            input = { ...input, content: `[File content: ${((input.content as string).length / 1024).toFixed(1)}KB — omitted from history]` };
          }
          // Compact edit tool: if old_string/new_string > 500 chars, truncate
          if (tu.name === 'edit') {
            const updated = { ...input };
            if (typeof updated.old_string === 'string' && (updated.old_string as string).length > 500) {
              updated.old_string = (updated.old_string as string).slice(0, 200) + '...[truncated]';
            }
            if (typeof updated.new_string === 'string' && (updated.new_string as string).length > 500) {
              updated.new_string = (updated.new_string as string).slice(0, 200) + '...[truncated]';
            }
            input = updated;
          }
          return `<tool_call>\n${JSON.stringify({ name: tu.name, input })}\n</tool_call>`;
        });

      const toolResults = msg.content
        .filter((b) => b.type === 'tool_result')
        .map((b) => {
          const tr = b as { tool_use_id: string; content: unknown; is_error?: boolean };
          const content = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
          return `[Tool Result for ${tr.tool_use_id}]: ${tr.is_error ? 'ERROR: ' : ''}${content}`;
        });

      const allText = [...textParts, ...toolUseParts, ...toolResults].join('\n');
      if (allText) {
        parts.push(`${msg.role === 'user' ? 'Human' : 'Assistant'}: ${allText}`);
      }
    }
  }

  // Compact tool reminder — only for CUSTOM tools (built-in tools are handled natively by CLI)
  const customTools = request.tools?.filter(t => !CLI_BUILTIN_TOOL_NAMES.has(t.name)) ?? [];
  if (customTools.length > 0) {
    const toolNames = customTools.map(t => t.name).join(', ');
    parts.push(`[SYSTEM: Custom tools available: ${toolNames}. Use <tool_call> tags. For file/shell/web operations, use your built-in tools directly.]`);
  }

  return parts.join('\n\n');
}

/**
 * Build tool definition prompt section.
 * Instructs Claude to output tool calls in a parseable JSON format.
 */
function buildToolPrompt(tools: ToolDefinition[]): string {
  const toolDefs = tools.map((t) => {
    const params = t.input_schema.properties
      ? Object.entries(t.input_schema.properties as Record<string, { type?: string; description?: string }>)
          .map(([name, schema]) => `    - ${name} (${schema.type || 'any'}): ${schema.description || ''}`)
          .join('\n')
      : '    (no parameters)';
    const required = (t.input_schema.required as string[]) || [];
    return `  ${t.name}: ${t.description}\n    Required: [${required.join(', ')}]\n${params}`;
  }).join('\n\n');

  return `## Available Tools

You have access to the following tools. To call a tool, output a JSON block wrapped in <tool_call> tags:

<tool_call>
{"name": "tool_name", "input": {"param1": "value1"}}
</tool_call>

You may call multiple tools by outputting multiple <tool_call> blocks.
After outputting tool calls, STOP and wait for results.
If you don't need any tools, just respond with text normally.

Tools:
${toolDefs}`;
}

/**
 * Parse tool calls from Claude's text response.
 * Looks for <tool_call>...</tool_call> blocks.
 */
function parseToolCalls(text: string): { textContent: string; toolCalls: Array<{ name: string; input: Record<string, unknown> }> } {
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let textContent = text;

  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as { name: string; input: Record<string, unknown> };
      if (parsed.name) {
        toolCalls.push({ name: parsed.name, input: parsed.input || {} });
      }
    } catch (err) {
      log.warn(`Failed to parse tool call: ${(err as Error).message}`);
    }
    // Remove tool call from text content
    textContent = textContent.replace(match[0], '').trim();
  }

  return { textContent, toolCalls };
}

/**
 * Build role-specific CLI args (MCP config, allowed tools, budget cap).
 * Reads AGENT_ROLE from env to determine which MCP servers to attach.
 */
function buildRoleArgs(): string[] {
  const role = process.env['AGENT_ROLE'] ?? process.env['JARVIS_AGENT_ROLE'] ?? 'orchestrator';
  const args: string[] = [];

  // Role-specific tools (currently same for all, but easily customizable)
  const tools = ROLE_ALLOWED_TOOLS[role] ?? CLI_BUILTIN_TOOLS;
  args.push('--tools', tools);

  // MCP servers per role
  const mcpConfig = ROLE_MCP_CONFIGS[role];
  if (mcpConfig && Object.keys(mcpConfig).length > 0) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: mcpConfig }));
    log.info(`MCP servers for role ${role}: ${Object.keys(mcpConfig).join(', ')}`);
  }

  // Budget cap
  if (MAX_BUDGET_USD > 0) {
    args.push('--max-budget-usd', String(MAX_BUDGET_USD));
  }

  return args;
}

export class ClaudeCliProvider implements LLMProvider {
  readonly id = 'claude-cli';
  readonly name = 'Claude CLI (Max)';
  private available: boolean;

  constructor() {
    this.available = isClaudeAvailable();
    if (this.available) {
      log.info('Claude CLI provider initialized (Max subscription)');
    } else {
      log.warn('Claude CLI not found — provider unavailable');
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  listModels(): ModelInfo[] {
    return this.available ? MODELS : [];
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.available) throw new Error('Claude CLI not available');

    const systemPrompt = buildSystemPrompt(request);
    const conversationPrompt = buildConversationPrompt(request);
    const model = request.model || 'claude-opus-4-6';

    // Validate model name to prevent argument injection
    if (!ALLOWED_MODELS.has(model)) {
      throw new Error(`Model '${model}' is not in the allowed list for Claude CLI`);
    }

    log.info(`Calling claude -p (model: ${model}, system: ${systemPrompt.length} chars, conversation: ${conversationPrompt.length} chars)`);

    try {
      // Use spawn to pass conversation via stdin, system prompt via --system-prompt flag
      const response = await new Promise<string>((resolve, reject) => {
        const safeEnv: Record<string, string> = {
          PATH: process.env['PATH'] ?? '',
          HOME: process.env['HOME'] ?? '',
          USER: process.env['USER'] ?? '',
          SHELL: process.env['SHELL'] ?? '/bin/bash',
          TERM: process.env['TERM'] ?? 'xterm-256color',
          LANG: process.env['LANG'] ?? 'en_US.UTF-8',
          TMPDIR: process.env['TMPDIR'] ?? '/tmp',
        };
        // Propagate NVM/Node paths if present
        if (process.env['NVM_DIR']) safeEnv['NVM_DIR'] = process.env['NVM_DIR'];
        if (process.env['NVM_BIN']) safeEnv['NVM_BIN'] = process.env['NVM_BIN'];

        const roleArgs = buildRoleArgs();
        const child = spawn(CLAUDE_BIN, [
          '-p',
          '--output-format', 'json',
          '--model', model,
          '--no-session-persistence',
          '--dangerously-skip-permissions',
          '--effort', 'high',
          ...roleArgs,
          '--system-prompt', systemPrompt,
        ], {
          env: safeEnv,
          timeout: SPAWN_TIMEOUT_MS,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        child.on('close', (code: number) => {
          if (code === 0 || stdout.trim()) {
            resolve(stdout);
          } else {
            reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
          }
        });

        child.on('error', (err: Error) => reject(err));

        // Handle stdin errors (EPIPE when claude process dies before write completes)
        child.stdin.on('error', (err: Error) => {
          reject(new Error(`Claude CLI stdin error (EPIPE): ${err.message}. Is 'claude' CLI installed?`));
        });

        // Write ONLY conversation to stdin (system prompt is in --system-prompt flag)
        child.stdin.write(conversationPrompt);
        child.stdin.end();
      });

      const stdout = response;

      const result = JSON.parse(stdout) as {
        result?: string;
        is_error?: boolean;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        modelUsage?: Record<string, {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
        }>;
        total_cost_usd?: number;
        stop_reason?: string;
      };

      if (result.is_error) {
        throw new Error(`Claude CLI error: ${result.result || 'unknown error'}`);
      }

      const responseText = result.result || '';

      // Parse tool calls from response
      const { textContent, toolCalls } = parseToolCalls(responseText);
      const hasToolCalls = toolCalls.length > 0;

      // Build content blocks
      const content: ContentBlock[] = [];

      if (textContent) {
        content.push({ type: 'text', text: textContent });
      }

      for (const tc of toolCalls) {
        content.push({
          type: 'tool_use',
          id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: tc.name,
          input: tc.input,
        });
      }

      if (content.length === 0) {
        content.push({ type: 'text', text: '(empty response)' });
      }

      // Extract usage from modelUsage (more detailed) or top-level usage
      const modelKey = Object.keys(result.modelUsage || {})[0];
      const mu = modelKey ? result.modelUsage![modelKey] : undefined;

      const usage = {
        inputTokens: mu?.inputTokens ?? result.usage?.input_tokens ?? 0,
        outputTokens: mu?.outputTokens ?? result.usage?.output_tokens ?? 0,
        cacheReadTokens: mu?.cacheReadInputTokens ?? result.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: mu?.cacheCreationInputTokens ?? result.usage?.cache_creation_input_tokens ?? 0,
        totalTokens: (mu?.inputTokens ?? 0) + (mu?.outputTokens ?? 0),
      };

      log.info(`Claude CLI response: ${responseText.length} chars, ${toolCalls.length} tool calls, ${usage.totalTokens} tokens, cost: $${result.total_cost_usd?.toFixed(4) ?? '?'}`);

      return {
        content,
        stopReason: hasToolCalls ? 'tool_use' : 'end_turn',
        usage,
        model,
      };
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('TIMEOUT') || errMsg.includes('timed out')) {
        throw new Error(`Claude CLI timed out (${SPAWN_TIMEOUT_MS / 1000}s)`);
      }
      throw new Error(`Claude CLI failed: ${errMsg}`);
    }
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatChunk> {
    if (!this.available) {
      yield { type: 'error', error: 'Claude CLI not available' };
      return;
    }

    const systemPrompt = buildSystemPrompt(request);
    const conversationPrompt = buildConversationPrompt(request);
    const model = request.model || 'claude-opus-4-6';

    log.info(`Streaming claude -p (model: ${model}, system: ${systemPrompt.length} chars, conversation: ${conversationPrompt.length} chars)`);

    // Validate model name
    if (!ALLOWED_MODELS.has(model)) {
      yield { type: 'error', error: `Model '${model}' is not in the allowed list for Claude CLI` };
      return;
    }

    // Spawn claude with stream-json + partial messages for token-by-token output
    const safeEnv: Record<string, string> = {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      USER: process.env['USER'] ?? '',
      SHELL: process.env['SHELL'] ?? '/bin/bash',
      TERM: process.env['TERM'] ?? 'xterm-256color',
      LANG: process.env['LANG'] ?? 'en_US.UTF-8',
      TMPDIR: process.env['TMPDIR'] ?? '/tmp',
    };
    if (process.env['NVM_DIR']) safeEnv['NVM_DIR'] = process.env['NVM_DIR'];
    if (process.env['NVM_BIN']) safeEnv['NVM_BIN'] = process.env['NVM_BIN'];

    const roleArgs = buildRoleArgs();
    const child = spawn(CLAUDE_BIN, [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', model,
      '--no-session-persistence',
      '--dangerously-skip-permissions',
      '--effort', 'high',
      ...roleArgs,
      '--system-prompt', systemPrompt,
    ], {
      env: safeEnv,
      timeout: SPAWN_TIMEOUT_MS,
    });

    // Track block types by index for content_block_stop
    const blockTypes = new Map<number, string>();
    let accumulatedText = '';
    let stopReason: ChatChunk['stopReason'] = 'end_turn';
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let hadError = false;

    // Create a promise that resolves when the child exits
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('close', resolve);
      child.on('error', (err) => {
        log.error(`Claude CLI spawn error: ${err.message}`);
        resolve(1);
      });
    });

    // Buffer for yielding chunks from the async generator
    const chunks: ChatChunk[] = [];
    let lineResolve: (() => void) | null = null;
    let streamDone = false;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on('line', (line: string) => {
      if (!line.trim()) return;

      try {
        const event = JSON.parse(line) as Record<string, unknown>;

        if (event.type === 'stream_event') {
          const se = event.event as Record<string, unknown>;
          const seType = se.type as string;

          if (seType === 'content_block_start') {
            const idx = se.index as number;
            const block = se.content_block as { type: string };
            blockTypes.set(idx, block.type);

            if (block.type === 'thinking') {
              chunks.push({ type: 'thinking_start' });
            }
          } else if (seType === 'content_block_delta') {
            const delta = se.delta as { type: string; text?: string; thinking?: string };

            if (delta.type === 'text_delta' && delta.text) {
              accumulatedText += delta.text;
              chunks.push({ type: 'text_delta', text: delta.text });
            } else if (delta.type === 'thinking_delta' && delta.thinking) {
              chunks.push({ type: 'thinking_delta', thinking: delta.thinking });
            }
          } else if (seType === 'content_block_stop') {
            const idx = se.index as number;
            const blockType = blockTypes.get(idx);
            if (blockType === 'thinking') {
              chunks.push({ type: 'thinking_end' });
            }
          } else if (seType === 'message_delta') {
            const delta = se.delta as { stop_reason?: string };
            const seUsage = se.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;

            if (delta.stop_reason) {
              stopReason = delta.stop_reason as ChatChunk['stopReason'];
            }
            if (seUsage) {
              usage.outputTokens = seUsage.output_tokens ?? usage.outputTokens;
            }
          }
        } else if (event.type === 'result') {
          const result = event as { is_error?: boolean; result?: string; usage?: Record<string, number>; modelUsage?: Record<string, Record<string, number>>; total_cost_usd?: number };

          if (result.is_error) {
            chunks.push({ type: 'error', error: `Claude CLI error: ${result.result || 'unknown error'}` });
            hadError = true;
          } else {
            // Extract usage from result
            const mu = result.modelUsage ? Object.values(result.modelUsage)[0] : undefined;
            usage.inputTokens = mu?.inputTokens ?? result.usage?.input_tokens ?? 0;
            usage.outputTokens = mu?.outputTokens ?? result.usage?.output_tokens ?? 0;
            usage.cacheReadTokens = mu?.cacheReadInputTokens ?? result.usage?.cache_read_input_tokens ?? 0;
            usage.cacheWriteTokens = mu?.cacheCreationInputTokens ?? result.usage?.cache_creation_input_tokens ?? 0;
            usage.totalTokens = usage.inputTokens + usage.outputTokens;

            log.info(`Claude CLI stream done: ${accumulatedText.length} chars, ${usage.totalTokens} tokens, cost: $${result.total_cost_usd?.toFixed(4) ?? '?'}`);
          }
        }
        // Ignore: system, assistant (full message duplicate), rate_limit_event
      } catch (err) {
        log.warn(`Failed to parse stream-json line: ${(err as Error).message}`);
      }

      // Wake up the generator if it's waiting
      if (lineResolve) {
        const r = lineResolve;
        lineResolve = null;
        r();
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // Handle stdin errors (EPIPE when claude process dies before we finish writing)
    child.stdin.on('error', (err: Error) => {
      log.error(`stdin write error: ${err.message} (claude process may have crashed)`);
      if (!hadError) {
        hadError = true;
        chunks.push({ type: 'error', error: `Claude CLI stdin error: ${err.message}. Check that 'claude' CLI is installed and working.` });
      }
      streamDone = true;
      if (lineResolve) {
        const r = lineResolve;
        lineResolve = null;
        r();
      }
    });

    // Write ONLY conversation to stdin (system prompt is in --system-prompt flag)
    child.stdin.write(conversationPrompt);
    child.stdin.end();

    rl.on('close', () => {
      streamDone = true;
      if (lineResolve) {
        const r = lineResolve;
        lineResolve = null;
        r();
      }
    });

    // Yield chunks as they arrive
    while (true) {
      // Drain buffered chunks
      while (chunks.length > 0) {
        yield chunks.shift()!;
      }

      if (streamDone) break;

      // Wait for more data
      await new Promise<void>((resolve) => { lineResolve = resolve; });
    }

    // Drain any remaining chunks
    while (chunks.length > 0) {
      yield chunks.shift()!;
    }

    // Wait for child to exit
    await exitPromise;

    if (hadError) return;

    // Parse tool calls from accumulated text
    const { toolCalls } = parseToolCalls(accumulatedText);
    if (toolCalls.length > 0) {
      stopReason = 'tool_use';
      for (const tc of toolCalls) {
        const id = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        yield { type: 'tool_use_start', toolCall: { id, name: tc.name, input: '' } };
        yield { type: 'tool_use_delta', toolCall: { id, name: tc.name, input: JSON.stringify(tc.input) } };
        yield { type: 'tool_use_end', toolCall: { id, name: tc.name, input: JSON.stringify(tc.input) } };
      }
    }

    yield { type: 'message_end', stopReason, usage };
  }
}
