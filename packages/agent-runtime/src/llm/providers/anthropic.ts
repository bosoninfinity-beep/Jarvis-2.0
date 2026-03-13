import { createLogger } from '@jarvis/shared';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type {
  LLMProvider, ChatRequest, ChatResponse, ChatChunk,
  ModelInfo, ContentBlock, TokenUsage, Message,
} from '../types.js';

const log = createLogger('llm:anthropic');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
/** Timeout for non-streaming chat requests (5 minutes) */
const CHAT_TIMEOUT_MS = 300_000;
/** Timeout for streaming chat requests (10 minutes) */
const STREAM_TIMEOUT_MS = 600_000;
/** Default max tokens if not specified in request */
const DEFAULT_MAX_TOKENS = 8192;

const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 128000, supportsTools: true, supportsVision: true, costPerInputToken: 5 / 1e6, costPerOutputToken: 25 / 1e6 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, supportsTools: true, supportsVision: true, costPerInputToken: 3 / 1e6, costPerOutputToken: 15 / 1e6 },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, supportsTools: true, supportsVision: true, costPerInputToken: 1 / 1e6, costPerOutputToken: 5 / 1e6 },
];

export type AnthropicAuthMode = 'api-key' | 'claude-cli';

export interface AnthropicProviderConfig {
  apiKey?: string;
  authMode?: AnthropicAuthMode;
}

/** Read OAuth access token from Claude CLI's macOS Keychain credentials or env var fallback */
function parseOAuthCreds(raw: string): { accessToken: string; expiresAt: number; refreshToken: string } | null {
  try {
    const creds = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number; refreshToken?: string };
    };
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: oauth.expiresAt ?? 0,
      refreshToken: oauth.refreshToken ?? '',
    };
  } catch {
    return null;
  }
}

function readClaudeCliToken(): { accessToken: string; expiresAt: number; refreshToken: string } | null {
  // Source 1: CLAUDE_OAUTH_CREDENTIALS env var (injected by JarvisApp at startup)
  const envCreds = process.env['CLAUDE_OAUTH_CREDENTIALS'];
  if (envCreds) {
    const parsed = parseOAuthCreds(envCreds);
    if (parsed && parsed.expiresAt > Date.now()) {
      log.info('Using OAuth token from CLAUDE_OAUTH_CREDENTIALS env var');
      return parsed;
    }
  }

  // Source 2: NAS file (synced from Mac Studio Keychain, refreshes without agent restart)
  const nasMount = process.env['JARVIS_NAS_MOUNT'];
  if (nasMount) {
    try {
      const oauthPath = `${nasMount}/config/claude-oauth.json`;
      const raw = readFileSync(oauthPath, 'utf-8');
      const parsed = parseOAuthCreds(raw);
      if (parsed && parsed.expiresAt > Date.now()) {
        log.info('Using OAuth token from NAS (claude-oauth.json)');
        return parsed;
      }
    } catch { /* NAS file not available */ }
  }

  // Source 3: macOS Keychain (works on Mac Studio where claude login was done)
  if (process.platform === 'darwin') {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w 2>/dev/null',
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      const parsed = parseOAuthCreds(raw);
      if (parsed) {
        log.info('Using OAuth token from macOS Keychain');
        return parsed;
      }
    } catch (err) {
      log.warn(`Failed to read Claude CLI token from Keychain: ${(err as Error).message}`);
    }
  }

  log.warn('No OAuth token available (env var, NAS, Keychain all failed)');
  return null;
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';

  private apiKey?: string;
  private authMode: AnthropicAuthMode;
  private oauthToken: string | null = null;
  private oauthExpiresAt: number = 0;

  constructor(config: string | AnthropicProviderConfig) {
    if (typeof config === 'string') {
      // Legacy: plain API key string
      this.apiKey = config;
      this.authMode = 'api-key';
    } else {
      this.apiKey = config.apiKey;
      this.authMode = config.authMode ?? (config.apiKey ? 'api-key' : 'claude-cli');
    }

    if (this.authMode === 'claude-cli') {
      this.refreshOAuthToken();
    }

    log.info(`Anthropic provider initialized (auth: ${this.authMode}${this.authMode === 'claude-cli' ? ', token: ' + (this.oauthToken ? 'ok' : 'MISSING') : ''})`);
  }

  isAvailable(): boolean {
    if (this.authMode === 'claude-cli') {
      return !!this.getOAuthToken();
    }
    return !!this.apiKey;
  }

  /** Get current OAuth token, refreshing from Keychain if expired */
  private getOAuthToken(): string | null {
    if (this.oauthToken && Date.now() < this.oauthExpiresAt - 60_000) {
      return this.oauthToken; // Still valid (with 60s margin)
    }
    this.refreshOAuthToken();
    return this.oauthToken;
  }

  private refreshOAuthToken(): void {
    const creds = readClaudeCliToken();
    if (creds) {
      this.oauthToken = creds.accessToken;
      this.oauthExpiresAt = creds.expiresAt;
      log.info(`OAuth token refreshed (expires: ${new Date(creds.expiresAt).toISOString()})`);
    } else {
      this.oauthToken = null;
      this.oauthExpiresAt = 0;
    }
  }

  listModels(): ModelInfo[] {
    return MODELS;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildRequestBody(request, false);
    let response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

    // Auto-refresh OAuth token on 401 and retry once
    if (response.status === 401 && this.authMode === 'claude-cli') {
      log.info('OAuth token expired, refreshing from Keychain...');
      this.refreshOAuthToken();
      response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as AnthropicResponse;
    return this.parseResponse(data);
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const body = this.buildRequestBody(request, true);
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      yield { type: 'error', error: `Anthropic API error ${response.status}: ${errorText}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';
    let currentBlockType = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const event = JSON.parse(jsonStr) as AnthropicStreamEvent;

            switch (event.type) {
              case 'content_block_start':
                currentBlockType = event.content_block?.type ?? '';
                if (event.content_block?.type === 'tool_use') {
                  currentToolId = event.content_block.id ?? '';
                  currentToolName = event.content_block.name ?? '';
                  currentToolInput = '';
                  yield { type: 'tool_use_start', toolCall: { id: currentToolId, name: currentToolName, input: '' } };
                } else if (event.content_block?.type === 'thinking') {
                  yield { type: 'thinking_start', thinking: '' };
                }
                break;

              case 'content_block_delta':
                if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
                  yield { type: 'thinking_delta', thinking: event.delta.thinking };
                } else if (event.delta?.type === 'text_delta' && event.delta.text) {
                  yield { type: 'text_delta', text: event.delta.text };
                } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                  currentToolInput += event.delta.partial_json;
                  yield { type: 'tool_use_delta', toolCall: { id: currentToolId, name: currentToolName, input: currentToolInput } };
                }
                break;

              case 'content_block_stop':
                if (currentBlockType === 'thinking') {
                  yield { type: 'thinking_end' };
                } else if (currentToolId) {
                  yield { type: 'tool_use_end', toolCall: { id: currentToolId, name: currentToolName, input: currentToolInput } };
                  currentToolId = '';
                  currentToolName = '';
                  currentToolInput = '';
                }
                currentBlockType = '';
                break;

              case 'message_delta':
                yield {
                  type: 'message_end',
                  stopReason: mapStopReason(event.delta?.stop_reason),
                  usage: event.usage ? {
                    inputTokens: 0,
                    outputTokens: event.usage.output_tokens ?? 0,
                    totalTokens: 0,
                  } : undefined,
                };
                break;

              case 'message_start':
                // Initial usage info
                if (event.message?.usage) {
                  yield {
                    type: 'message_end',
                    usage: {
                      inputTokens: event.message.usage.input_tokens ?? 0,
                      outputTokens: 0,
                      cacheReadTokens: event.message.usage.cache_read_input_tokens,
                      cacheWriteTokens: event.message.usage.cache_creation_input_tokens,
                      totalTokens: 0,
                    },
                  };
                }
                break;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  getAuthMode(): AnthropicAuthMode {
    return this.authMode;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    };

    if (this.authMode === 'claude-cli') {
      const token = this.getOAuthToken();
      if (!token) throw new Error('Claude CLI OAuth token not available');
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      if (!this.apiKey) throw new Error('Anthropic API key not configured');
      headers['x-api-key'] = this.apiKey;
    }

    return headers;
  }

  private buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => this.convertMessage(m));

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens ?? DEFAULT_MAX_TOKENS,
      stream,
    };

    if (request.system) {
      body['system'] = request.system;
    }

    if (request.temperature !== undefined) {
      body['temperature'] = request.temperature;
    }

    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

    if (request.stop_sequences) {
      body['stop_sequences'] = request.stop_sequences;
    }

    return body;
  }

  private convertMessage(msg: Message): Record<string, unknown> {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }

    const blocks = msg.content.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'image':
          return {
            type: 'image',
            source: { type: 'base64', media_type: block.mediaType, data: block.data },
          };
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        case 'tool_result': {
          // Convert tool_result content: can be string or array of content blocks (e.g., images)
          let resultContent: unknown;
          if (typeof block.content === 'string') {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            // Convert nested content blocks to Anthropic format
            resultContent = block.content.map((inner) => {
              if (inner.type === 'image') {
                return {
                  type: 'image',
                  source: { type: 'base64', media_type: inner.mediaType, data: inner.data },
                };
              }
              if (inner.type === 'text') {
                return { type: 'text', text: inner.text };
              }
              return inner;
            });
          } else {
            resultContent = JSON.stringify(block.content);
          }
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: resultContent,
            is_error: block.is_error,
          };
        }
        default:
          return block;
      }
    });

    return { role: msg.role, content: blocks };
  }

  private parseResponse(data: AnthropicResponse): ChatResponse {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid Anthropic response: expected an object');
    }
    const content: ContentBlock[] = (Array.isArray(data.content) ? data.content : []).map((block) => {
      if (block.type === 'thinking') return { type: 'thinking' as const, thinking: block.thinking ?? '' };
      if (block.type === 'text') return { type: 'text', text: block.text ?? '' };
      if (block.type === 'tool_use') return {
        type: 'tool_use',
        id: block.id ?? '',
        name: block.name ?? '',
        input: (block.input ?? {}) as Record<string, unknown>,
      };
      return { type: 'text', text: '' };
    });

    return {
      content,
      stopReason: mapStopReason(data.stop_reason),
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        cacheReadTokens: data.usage?.cache_read_input_tokens,
        cacheWriteTokens: data.usage?.cache_creation_input_tokens,
        totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      model: data.model ?? '',
    };
  }
}

function mapStopReason(reason?: string): ChatResponse['stopReason'] {
  switch (reason) {
    case 'end_turn': return 'end_turn';
    case 'tool_use': return 'tool_use';
    case 'max_tokens': return 'max_tokens';
    case 'stop_sequence': return 'stop_sequence';
    default: return 'end_turn';
  }
}

// Anthropic API types (internal)
interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  model?: string;
}

interface AnthropicStreamEvent {
  type: string;
  content_block?: { type: string; id?: string; name?: string; text?: string; thinking?: string };
  delta?: { type: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
}
