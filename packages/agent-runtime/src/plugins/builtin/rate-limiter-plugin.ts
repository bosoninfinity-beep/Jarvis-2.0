/**
 * Rate Limiter Plugin — Prevents runaway tool/LLM calls.
 *
 * Guards against:
 * - Excessive tool calls (infinite loops, stuck retries)
 * - Token budget overruns
 * - Individual tool call frequency limits
 *
 * Tools:
 * - rate_limiter_status: Check current rate limits and usage
 * - rate_limiter_reset: Reset rate counters
 *
 * Hooks:
 * - before_tool_call: Enforce per-tool and global rate limits
 * - llm_output: Track token budget consumption
 * - session_start: Reset session-scoped counters
 */

import type { JarvisPluginDefinition } from '../types.js';

interface RateLimitConfig {
  maxToolCallsPerMinute: number;
  maxToolCallsPerSession: number;
  maxTokensPerSession: number;
  maxConsecutiveSameToolCalls: number;
  cooldownMs: number;
}

interface RateState {
  toolCallsThisMinute: number;
  toolCallsThisSession: number;
  tokensThisSession: number;
  minuteWindowStart: number;
  lastToolName: string;
  consecutiveSameToolCount: number;
  totalBlocked: number;
  perToolCounts: Record<string, number>;
}

/** Tools that are inherently dangerous — SSH, exec, inter-agent messaging */
const DANGEROUS_TOOLS = new Set(['ssh_exec', 'exec', 'message_agent', 'computer']);

/** Max calls to any single dangerous tool per session */
const MAX_DANGEROUS_TOOL_PER_SESSION = 25;

/** Max total dangerous tool calls (all combined) per session */
const MAX_DANGEROUS_TOTAL_PER_SESSION = 40;

const DEFAULT_CONFIG: RateLimitConfig = {
  maxToolCallsPerMinute: 30,
  maxToolCallsPerSession: 200,
  maxTokensPerSession: 500_000,
  maxConsecutiveSameToolCalls: 5,
  cooldownMs: 100,
};

export function createRateLimiterPlugin(): JarvisPluginDefinition {
  const config = { ...DEFAULT_CONFIG };

  // Keyed by sessionId so concurrent sessions don't corrupt each other's state
  const sessionStateMap = new Map<string, RateState & { lastCallTime: number }>();

  function createSessionState(): RateState & { lastCallTime: number } {
    return {
      toolCallsThisMinute: 0,
      toolCallsThisSession: 0,
      tokensThisSession: 0,
      minuteWindowStart: Date.now(),
      lastToolName: '',
      consecutiveSameToolCount: 0,
      totalBlocked: 0,
      perToolCounts: {},
      lastCallTime: 0,
    };
  }

  function getOrCreateState(sessionId: string): RateState & { lastCallTime: number } {
    if (!sessionStateMap.has(sessionId)) {
      sessionStateMap.set(sessionId, createSessionState());
    }
    return sessionStateMap.get(sessionId)!;
  }

  function resetMinuteWindow(state: RateState): void {
    const now = Date.now();
    if (now - state.minuteWindowStart > 60_000) {
      state.toolCallsThisMinute = 0;
      state.minuteWindowStart = now;
    }
  }

  return {
    id: 'rate-limiter',
    name: 'Rate Limiter',
    description: 'Prevents runaway tool calls and token budget overruns',
    version: '1.0.0',

    register(api) {
      const log = api.logger;

      // Merge plugin config if provided
      const pluginCfg = api.pluginConfig as Partial<RateLimitConfig>;
      if (pluginCfg.maxToolCallsPerMinute) config.maxToolCallsPerMinute = pluginCfg.maxToolCallsPerMinute;
      if (pluginCfg.maxToolCallsPerSession) config.maxToolCallsPerSession = pluginCfg.maxToolCallsPerSession;
      if (pluginCfg.maxTokensPerSession) config.maxTokensPerSession = pluginCfg.maxTokensPerSession;
      if (pluginCfg.maxConsecutiveSameToolCalls) config.maxConsecutiveSameToolCalls = pluginCfg.maxConsecutiveSameToolCalls;

      // --- Tools ---

      api.registerTool({
        name: 'rate_limiter_status',
        description: 'Check current rate limiter status, showing usage vs limits for tool calls and tokens.',
        inputSchema: { type: 'object' as const, properties: {} },
        execute: async (_params, ctx) => {
          const sessionId = (ctx as { sessionId?: string }).sessionId ?? '';
          const state = getOrCreateState(sessionId);
          resetMinuteWindow(state);
          const lines = [
            '=== Rate Limiter Status ===',
            '',
            `Tool calls this minute: ${state.toolCallsThisMinute}/${config.maxToolCallsPerMinute}`,
            `Tool calls this session: ${state.toolCallsThisSession}/${config.maxToolCallsPerSession}`,
            `Tokens this session: ${state.tokensThisSession.toLocaleString()}/${config.maxTokensPerSession.toLocaleString()}`,
            `Consecutive same-tool calls: ${state.consecutiveSameToolCount}/${config.maxConsecutiveSameToolCalls} (${state.lastToolName || 'none'})`,
            `Total blocked: ${state.totalBlocked}`,
            '',
            'Top tool calls:',
            ...Object.entries(state.perToolCounts)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 10)
              .map(([tool, count]) => `  ${tool}: ${count}`),
          ];
          return { type: 'text' as const, text: lines.join('\n') };
        },
      });

      // NOTE: rate_limiter_reset was intentionally REMOVED — agents must NOT
      // be able to reset their own rate limits. Only a session restart resets them.

      // --- Hooks ---

      api.on('before_tool_call', (event, ctx) => {
        const state = getOrCreateState(ctx.sessionId ?? '');
        resetMinuteWindow(state);
        const now = Date.now();
        const toolName = event.toolName;
        const isDangerous = DANGEROUS_TOOLS.has(toolName);

        // Track per-tool counts
        state.perToolCounts[toolName] = (state.perToolCounts[toolName] || 0) + 1;

        // Track consecutive same-tool calls
        if (toolName === state.lastToolName) {
          state.consecutiveSameToolCount++;
        } else {
          state.consecutiveSameToolCount = 1;
          state.lastToolName = toolName;
        }

        // Check: token budget exceeded
        if (state.tokensThisSession > config.maxTokensPerSession) {
          state.totalBlocked++;
          log.warn(`Rate limiter: session token budget exceeded (${state.tokensThisSession.toLocaleString()}/${config.maxTokensPerSession.toLocaleString()})`);
          return {
            block: true,
            blockReason: `Rate limit: token budget exceeded — ${state.tokensThisSession.toLocaleString()} tokens used (max: ${config.maxTokensPerSession.toLocaleString()}). This limit cannot be reset — finish the task or start a new session.`,
          };
        }

        // Check: dangerous tool per-tool session limit
        if (isDangerous && state.perToolCounts[toolName]! > MAX_DANGEROUS_TOOL_PER_SESSION) {
          state.totalBlocked++;
          log.warn(`Rate limiter: dangerous tool ${toolName} session limit hit (${state.perToolCounts[toolName]}/${MAX_DANGEROUS_TOOL_PER_SESSION})`);
          return {
            block: true,
            blockReason: `Rate limit: ${toolName} used ${state.perToolCounts[toolName]} times this session (max: ${MAX_DANGEROUS_TOOL_PER_SESSION} for dangerous tools). Start a new session if more calls are needed.`,
          };
        }

        // Check: total dangerous tool calls across all dangerous tools
        if (isDangerous) {
          const totalDangerous = [...DANGEROUS_TOOLS].reduce(
            (sum, t) => sum + (state.perToolCounts[t] || 0), 0,
          );
          if (totalDangerous > MAX_DANGEROUS_TOTAL_PER_SESSION) {
            state.totalBlocked++;
            log.warn(`Rate limiter: total dangerous tool calls exceeded (${totalDangerous}/${MAX_DANGEROUS_TOTAL_PER_SESSION})`);
            return {
              block: true,
              blockReason: `Rate limit: ${totalDangerous} total dangerous tool calls this session (max: ${MAX_DANGEROUS_TOTAL_PER_SESSION}). Start a new session.`,
            };
          }
        }

        // Check: consecutive same-tool limit
        if (state.consecutiveSameToolCount > config.maxConsecutiveSameToolCalls) {
          state.totalBlocked++;
          log.warn(`Rate limiter: blocked ${toolName} (${state.consecutiveSameToolCount} consecutive calls)`);
          return {
            block: true,
            blockReason: `Rate limit: ${toolName} called ${state.consecutiveSameToolCount} times consecutively (max: ${config.maxConsecutiveSameToolCalls}). You are likely in a loop — stop and report the issue.`,
          };
        }

        // Check: per-minute rate
        state.toolCallsThisMinute++;
        if (state.toolCallsThisMinute > config.maxToolCallsPerMinute) {
          state.totalBlocked++;
          log.warn(`Rate limiter: blocked (${state.toolCallsThisMinute}/min exceeds ${config.maxToolCallsPerMinute}/min)`);
          return {
            block: true,
            blockReason: `Rate limit: ${state.toolCallsThisMinute} tool calls this minute (max: ${config.maxToolCallsPerMinute}). You are calling tools too fast — slow down.`,
          };
        }

        // Check: per-session limit
        state.toolCallsThisSession++;
        if (state.toolCallsThisSession > config.maxToolCallsPerSession) {
          state.totalBlocked++;
          log.warn(`Rate limiter: session tool call limit reached (${state.toolCallsThisSession})`);
          return {
            block: true,
            blockReason: `Rate limit: ${state.toolCallsThisSession} tool calls this session (max: ${config.maxToolCallsPerSession}). Start a new session.`,
          };
        }

        // Enforce minimum cooldown between calls
        if (config.cooldownMs > 0 && (now - state.lastCallTime) < config.cooldownMs) {
          // Don't block, just note it — the cooldown is very short
        }
        state.lastCallTime = now;

        return undefined;
      }, { priority: 100 }); // High priority — runs before other hooks

      // Track token consumption
      api.on('llm_output', (event, ctx) => {
        const state = getOrCreateState(ctx.sessionId ?? '');
        state.tokensThisSession += event.usage.totalTokens;

        if (state.tokensThisSession > config.maxTokensPerSession * 0.9) {
          log.warn(`Token budget approaching limit: ${state.tokensThisSession.toLocaleString()}/${config.maxTokensPerSession.toLocaleString()}`);
        }
      });

      // Initialize session state on session_start; clean up on session_end
      api.on('session_start', (event) => {
        sessionStateMap.set(event.sessionId, createSessionState());
        log.debug('Rate limiter counters initialized for new session');
      });

      api.on('session_end', (event) => {
        sessionStateMap.delete(event.sessionId);
      });

      // Prompt section
      api.registerPromptSection({
        title: 'Rate Limits & Loop Prevention',
        content: [
          'CRITICAL: Rate limiting is active. These limits CANNOT be reset — they are hard enforced.',
          `Limits: ${config.maxToolCallsPerMinute}/min, ${config.maxToolCallsPerSession}/session, ${config.maxConsecutiveSameToolCalls} consecutive same-tool.`,
          `Dangerous tools (ssh_exec, exec, message_agent, computer): max ${MAX_DANGEROUS_TOOL_PER_SESSION} calls each, ${MAX_DANGEROUS_TOTAL_PER_SESSION} total.`,
          '',
          'ANTI-LOOP RULES:',
          '- If a tool call fails, do NOT retry the same call more than 2 times. After 2 failures, STOP and report the error.',
          '- If you are repeating similar tool calls, STOP and think whether you are in a loop.',
          '- NEVER call ssh_exec or exec repeatedly on the same machine without a clear, different purpose each time.',
          '- If blocked by rate limiter, STOP immediately. Do NOT try to work around it.',
          '- Use `rate_limiter_status` to check your current usage if unsure.',
        ].join('\n'),
        priority: -15,
      });

      log.info('Rate Limiter plugin registered', {
        maxPerMin: config.maxToolCallsPerMinute,
        maxPerSession: config.maxToolCallsPerSession,
        maxTokens: config.maxTokensPerSession,
      });
    },
  };
}
