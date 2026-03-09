/**
 * @jarvis/tools - Agent tool definitions and implementations
 */

// Base types
export type { ToolDefinition, ToolResult, AgentTool, ToolContext } from './base.js';
export { createToolResult, createErrorResult } from './base.js';

// Shared utilities
export { isPrivateUrl } from './ssrf.js';

// Core tools
export { ExecTool } from './exec.js';
export type { ExecSecurityConfig, SecurityMode } from './exec.js';
export { ReadTool, WriteTool, EditTool, ListTool, SearchTool } from './file-ops.js';
export { BrowserTool } from './browser.js';
export { WebFetchTool } from './web-fetch.js';
export { WebSearchTool } from './web-search.js';
export { MessageAgentTool } from './message-agent.js';
export { SshTool, sshExecSimple, sshExecBinary } from './ssh.js';
export type { SshHostConfig, SshToolConfig } from './ssh.js';
export { ComputerUseTool } from './computer-use.js';
export type { ComputerUseConfig, VncHostConfig } from './computer-use.js';
export { ToolRegistry } from './registry.js';
export { ImageGenTool } from './image-gen.js';

// Social media
export { SocialTool, SocialAnalyticsTool, type SocialToolConfig } from './social/social-tool.js';
export { SocialSchedulerTool, ScheduledPostExecutor, type ScheduledPost } from './social/scheduler.js';
// SocialContentGeneratorTool removed — agent writes content directly (it IS Claude with full context)
export { TwitterClient, type TwitterConfig } from './social/platforms/twitter.js';
export { InstagramClient, type InstagramConfig } from './social/platforms/instagram.js';
export { FacebookClient, type FacebookConfig } from './social/platforms/meta.js';
export { LinkedInClient, type LinkedInConfig } from './social/platforms/linkedin.js';
export { TikTokClient, type TikTokConfig } from './social/platforms/tiktok.js';
export { RedditClient, type RedditConfig } from './social/platforms/reddit.js';

// Media generation
export { MediaGenTool, type MediaGenConfig } from './media-gen.js';

// Research
export { ResearchPipelineTool } from './research/pipeline.js';

// Mobile build
export { MobileBuildTool, MobileSubmitTool } from './mobile/build.js';

// Web maintenance
export { DeployTool, MonitoringTool, SeoTool } from './web-maintenance/maintenance.js';

// Integrations
export { IMessageTool, type IMessageConfig } from './integrations/imessage.js';
export { SpotifyTool, type SpotifyConfig } from './integrations/spotify.js';
export { HomeAssistantTool, type HomeAssistantConfig } from './integrations/homeassistant.js';
export { CronSchedulerTool, CronScheduler, type CronSchedulerConfig, type ScheduledJob } from './integrations/cron-scheduler.js';
export { AppleCalendarTool, type AppleCalendarConfig } from './integrations/apple-calendar.js';
