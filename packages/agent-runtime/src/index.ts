/**
 * @jarvis/agent-runtime - Agent execution engine
 *
 * Runs on each Mac Mini worker. Connects to Gateway via NATS,
 * executes tasks using LLM + tools, reports results back.
 */

export { AgentRunner, type AgentRunnerConfig } from './engine/runner.js';
export { NatsHandler, type NatsHandlerConfig, type TaskAssignment } from './communication/nats-handler.js';
export { SessionManager, type SessionEntry, type SessionInfo } from './sessions/session-manager.js';
export { buildSystemPrompt, buildDevAgentPrompt, buildMarketingAgentPrompt, type AgentRole, type PromptContext } from './system-prompt/index.js';

// Plugin System
export {
  PluginRegistry, HookRunner,
  loadPlugins, loadSkills, buildSkillsPromptSection,
  createMemoryPlugin, createMetricsPlugin, createAutoSavePlugin, createTaskPlannerPlugin,
  type JarvisPluginDefinition, type JarvisPluginModule,
  type PluginApi, type PluginRuntimeConfig,
  type PluginHookName, type HookEvents, type HookResults,
  type SkillDefinition, type PromptSection,
  type LoadedPluginSystem,
} from './plugins/index.js';

// LLM
export {
  ProviderRegistry, type ProviderRegistryConfig,
  ClaudeCliProvider, OpenAIProvider, GoogleProvider, OllamaProvider, OpenRouterProvider,
  type LLMProvider, type ChatRequest, type ChatResponse, type ChatChunk,
  type Message, type ContentBlock, type ToolDefinition, type TokenUsage, type ModelInfo,
  createUsageAccumulator, mergeUsage,
} from './llm/index.js';
