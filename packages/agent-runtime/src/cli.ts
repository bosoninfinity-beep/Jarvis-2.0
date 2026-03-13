/**
 * CLI entry point for starting an agent on a Mac Mini worker.
 *
 * Usage:
 *   AGENT_ID=agent-smith AGENT_ROLE=dev tsx packages/agent-runtime/src/cli.ts
 *   AGENT_ID=agent-johny AGENT_ROLE=marketing tsx packages/agent-runtime/src/cli.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env from monorepo root (works whether started from root or packages/agent-runtime)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = process.env['DOTENV_CONFIG_PATH'] ?? resolve(__dirname, '..', '..', '..', '.env');

// Load .env but only fill in values that are MISSING or empty.
// This prevents .env from overriding per-agent CLI env vars like AGENT_ID/AGENT_ROLE
// while still picking up API keys that may not be set in the shell environment.
const parsed = dotenvConfig({ path: envPath }).parsed ?? {};
for (const [key, value] of Object.entries(parsed)) {
  if (!process.env[key] || process.env[key] === '') {
    process.env[key] = value;
  }
}

import { createLogger } from '@jarvis/shared';
import { ToolRegistry } from '@jarvis/tools';
import { AgentRunner } from './engine/runner.js';
import type { AgentRole } from './system-prompt/index.js';
import type { AgentId } from '@jarvis/shared';
import { hostname } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const log = createLogger('agent:cli');

const agentId = (process.env['JARVIS_AGENT_ID'] ?? process.env['AGENT_ID'] ?? 'agent-smith') as AgentId;
const role = (process.env['JARVIS_AGENT_ROLE'] ?? process.env['AGENT_ROLE'] ?? 'dev') as AgentRole;
const machineId = process.env['JARVIS_MACHINE_ID'] ?? process.env['MACHINE_ID'] ?? hostname();
const host = process.env['AGENT_HOSTNAME'] ?? hostname();
const natsUrl = process.env['NATS_URL'] ?? 'nats://localhost:4222';
const natsUrlThunderbolt = process.env['NATS_URL_THUNDERBOLT'] ?? undefined;
const thunderboltEnabled = process.env['THUNDERBOLT_ENABLED'] === 'true';
const nasMount = (() => {
  const envNas = process.env['JARVIS_NAS_MOUNT'];
  if (envNas && existsSync(envNas)) return envNas;
  // Primary: QNAP NAS mount
  const qnapPath = '/Volumes/Public/jarvis-nas';
  if (existsSync(qnapPath)) return qnapPath;
  // Fallback: local NAS cache
  const localNas = join(process.env['HOME'] ?? '/Users/jarvis', '.jarvis', 'nas');
  return localNas;
})();
const workspace = process.env['WORKSPACE_PATH'] ?? `${nasMount}/workspace/projects`;
const defaultModel = process.env['DEFAULT_MODEL'] ?? 'claude-opus-4-6';
// Claude CLI only — Max subscription, no API keys

// SSH host config for remote machine control
const sshAlphaHost = process.env['SSH_ALPHA_HOST'] ?? process.env['VNC_ALPHA_HOST'];
const sshAlphaUser = process.env['SSH_ALPHA_USER'] ?? process.env['VNC_ALPHA_USERNAME'];
const sshAlphaPass = process.env['SSH_ALPHA_PASSWORD'] ?? process.env['VNC_ALPHA_PASSWORD'];
const sshAlphaKey = process.env['SSH_ALPHA_KEY'];
const sshBetaHost = process.env['SSH_BETA_HOST'] ?? process.env['BETA_IP'];
const sshBetaUser = process.env['SSH_BETA_USER'] ?? process.env['VNC_BETA_USERNAME'] ?? process.env['BETA_USER'];
const sshBetaPass = process.env['SSH_BETA_PASSWORD'] ?? process.env['VNC_BETA_PASSWORD'];
const sshBetaKey = process.env['SSH_BETA_KEY'];

// Build SSH hosts map
const sshHosts: Record<string, { host: string; username: string; password?: string; privateKeyPath?: string }> = {};
if (sshAlphaHost && sshAlphaUser) {
  sshHosts['agent-smith'] = { host: sshAlphaHost, username: sshAlphaUser, password: sshAlphaPass, privateKeyPath: sshAlphaKey };
}
if (sshBetaHost && sshBetaUser) {
  sshHosts['agent-johny'] = { host: sshBetaHost, username: sshBetaUser, password: sshBetaPass, privateKeyPath: sshBetaKey };
}

// VNC host config for computer use (screenshots + mouse/keyboard via VNC protocol)
const vncAlphaHost = process.env['VNC_ALPHA_HOST'];
const vncAlphaPass = process.env['VNC_ALPHA_PASSWORD'];
const vncBetaHost = process.env['BETA_IP'] ?? process.env['VNC_BETA_HOST'];
const vncBetaPass = process.env['VNC_BETA_PASSWORD'];

const vncHosts: Record<string, { host: string; vncPort: number; vncPassword: string; ssh?: { host: string; username: string; password?: string } }> = {};
if (vncAlphaHost && vncAlphaPass) {
  vncHosts['agent-smith'] = {
    host: vncAlphaHost,
    vncPort: 5900,
    vncPassword: vncAlphaPass,
    ssh: sshHosts['agent-smith'],
  };
}
if (vncBetaHost && vncBetaPass) {
  vncHosts['agent-johny'] = {
    host: vncBetaHost,
    vncPort: 5900,
    vncPassword: vncBetaPass,
    ssh: sshHosts['agent-johny'],
  };
}

// Integration config from env
const hassUrl = process.env['HASS_URL'] || process.env['HOME_ASSISTANT_URL'];
const hassToken = process.env['HASS_TOKEN'] || process.env['HOME_ASSISTANT_TOKEN'];
const spotifyToken = process.env['SPOTIFY_ACCESS_TOKEN'];
const spotifyRefresh = process.env['SPOTIFY_REFRESH_TOKEN'];
const spotifyClientId = process.env['SPOTIFY_CLIENT_ID'];
const spotifyClientSecret = process.env['SPOTIFY_CLIENT_SECRET'];

// Social media API config from env
const twitterBearerToken = process.env['TWITTER_BEARER_TOKEN'];
const instagramAccessToken = process.env['INSTAGRAM_ACCESS_TOKEN'];
const facebookAccessToken = process.env['FACEBOOK_ACCESS_TOKEN'];
const linkedinAccessToken = process.env['LINKEDIN_ACCESS_TOKEN'];
const tiktokAccessToken = process.env['TIKTOK_ACCESS_TOKEN'];
const redditClientId = process.env['REDDIT_CLIENT_ID'];

// Media generation API keys from env
const fluxApiKey = process.env['FLUX_API_KEY'];
const klingAccessKey = process.env['KLING_ACCESS_KEY'];
const klingSecretKey = process.env['KLING_SECRET_KEY'];
const elevenLabsApiKey = process.env['ELEVENLABS_API_KEY'];
const heygenApiKey = process.env['HEYGEN_API_KEY'];
const runwayApiKey = process.env['RUNWAY_API_KEY'];

// Capability sets per role
const CAPABILITIES: Record<string, string[]> = {
  orchestrator: ['code', 'build', 'deploy', 'browser', 'exec', 'file', 'web', 'app-store', 'research', 'social-media', 'content', 'analytics', 'computer-use', 'ssh', 'imessage', 'spotify', 'home-assistant', 'cron'],
  dev: ['code', 'build', 'deploy', 'browser', 'exec', 'file', 'web', 'app-store', 'computer-use', 'ssh', 'imessage', 'spotify', 'home-assistant', 'cron'],
  marketing: ['research', 'social-media', 'content', 'analytics', 'browser', 'web', 'file', 'computer-use', 'ssh', 'imessage', 'spotify', 'home-assistant', 'cron'],
};

async function main(): Promise<void> {
  if (!natsUrl || natsUrl === 'nats://localhost:4222') {
    log.warn('NATS_URL not explicitly set — using default localhost. Agent may not reach the gateway.');
  }

  log.info(`=== Jarvis 2.0 Agent Runtime ===`);
  log.info(`Agent: ${agentId} (${role})`);
  log.info(`Machine: ${machineId} / ${host}`);
  log.info(`NATS: ${natsUrl}`);
  if (thunderboltEnabled && natsUrlThunderbolt) {
    log.info(`NATS Thunderbolt: ${natsUrlThunderbolt} (10 Gbps priority)`);
  }
  log.info(`NAS: ${nasMount}`);
  log.info(`Model: ${defaultModel}`);
  log.info(`Auth mode: Claude Max subscription (Claude CLI only)`);

  // Initialize tools
  const hasSshHosts = Object.keys(sshHosts).length > 0;
  const hasVncHosts = Object.keys(vncHosts).length > 0;
  log.info(`SSH hosts: ${hasSshHosts ? Object.entries(sshHosts).map(([k, v]) => `${k}→${v.host}`).join(', ') : 'none'}`);
  log.info(`VNC hosts: ${hasVncHosts ? Object.entries(vncHosts).map(([k, v]) => `${k}→${v.host}:${v.vncPort}`).join(', ') : 'none'}`);

  // Integrations enabled
  const enableIMessage = process.platform === 'darwin';
  const enableSpotify = process.platform === 'darwin' || !!spotifyToken;
  const enableHomeAssistant = !!(hassUrl && hassToken);
  const enableCron = true; // Always available
  const enableCalendar = process.platform === 'darwin';

  // Social media config — only enable platforms that have credentials
  const socialConfig = (twitterBearerToken || instagramAccessToken || facebookAccessToken || linkedinAccessToken || tiktokAccessToken || redditClientId) ? {
    twitter: twitterBearerToken ? {
      apiKey: process.env['TWITTER_API_KEY'] ?? '',
      apiSecret: process.env['TWITTER_API_SECRET'] ?? '',
      accessToken: process.env['TWITTER_ACCESS_TOKEN'] ?? '',
      accessTokenSecret: process.env['TWITTER_ACCESS_TOKEN_SECRET'] ?? '',
      bearerToken: twitterBearerToken,
    } : undefined,
    instagram: instagramAccessToken ? {
      accessToken: instagramAccessToken,
      businessAccountId: process.env['INSTAGRAM_BUSINESS_ACCOUNT_ID'] ?? '',
    } : undefined,
    facebook: facebookAccessToken ? {
      accessToken: facebookAccessToken,
      pageId: process.env['FACEBOOK_PAGE_ID'] ?? '',
    } : undefined,
    linkedin: linkedinAccessToken ? {
      accessToken: linkedinAccessToken,
      organizationId: process.env['LINKEDIN_ORGANIZATION_ID'],
      personUrn: process.env['LINKEDIN_PERSON_URN'],
    } : undefined,
    tiktok: tiktokAccessToken ? {
      accessToken: tiktokAccessToken,
      openId: process.env['TIKTOK_OPEN_ID'],
    } : undefined,
    reddit: redditClientId ? {
      clientId: redditClientId,
      clientSecret: process.env['REDDIT_CLIENT_SECRET'] ?? '',
      username: process.env['REDDIT_USERNAME'] ?? '',
      password: process.env['REDDIT_PASSWORD'] ?? '',
    } : undefined,
  } : undefined;
  const enableSocial = !!socialConfig;

  const integrations: string[] = [];
  if (enableIMessage) integrations.push('iMessage');
  if (enableSpotify) integrations.push('Spotify' + (spotifyToken ? '(API)' : '(local)'));
  if (enableHomeAssistant) integrations.push('HomeAssistant');
  if (enableCron) integrations.push('Cron');
  if (enableCalendar) integrations.push('Calendar');
  if (enableSocial) {
    const platforms: string[] = [];
    if (socialConfig?.twitter) platforms.push('Twitter');
    if (socialConfig?.instagram) platforms.push('Instagram');
    if (socialConfig?.facebook) platforms.push('Facebook');
    if (socialConfig?.linkedin) platforms.push('LinkedIn');
    if (socialConfig?.tiktok) platforms.push('TikTok');
    if (socialConfig?.reddit) platforms.push('Reddit');
    integrations.push(`Social(${platforms.join(',')})`);
  }
  log.info(`Integrations: ${integrations.length > 0 ? integrations.join(', ') : 'none'}`);

  const tools = new ToolRegistry({
    enableBrowser: true,
    enableExec: true,
    execSecurity: { mode: 'full' },
    enableFileOps: true,
    enableWebFetch: true,
    enableWebSearch: true,
    enableMessageAgent: false, // Registered dynamically by runner after NATS connects
    enableSsh: hasSshHosts,
    enableComputerUse: hasVncHosts,
    enableIMessage,
    enableSpotify,
    enableHomeAssistant,
    enableCron,
    enableCalendar,
    braveApiKey: process.env['BRAVE_API_KEY'],
    perplexityApiKey: process.env['PERPLEXITY_API_KEY'],
    sshHosts: hasSshHosts ? sshHosts : undefined,
    vncHosts: hasVncHosts ? vncHosts : undefined,
    spotifyConfig: spotifyToken ? {
      accessToken: spotifyToken,
      refreshToken: spotifyRefresh,
      clientId: spotifyClientId,
      clientSecret: spotifyClientSecret,
    } : undefined,
    homeAssistantConfig: enableHomeAssistant ? {
      url: hassUrl,
      token: hassToken,
    } : undefined,
    cronConfig: {
      jobsDir: `${nasMount}/cron-jobs`,
    },
    enableSocial,
    socialConfig,
    enableImageGen: true,
    openaiApiKey: process.env['OPENAI_API_KEY'],
    enableMediaGen: !!(fluxApiKey || klingAccessKey || elevenLabsApiKey || heygenApiKey),
    mediaGenConfig: (fluxApiKey || klingAccessKey || elevenLabsApiKey || heygenApiKey) ? {
      fluxApiKey,
      klingAccessKey,
      klingSecretKey,
      elevenLabsApiKey,
      heygenApiKey,
      runwayApiKey,
      nasPath: nasMount,
    } : undefined,
  });

  // Load model override from NAS config (saved via dashboard)
  let activeModel = defaultModel;
  try {
    const configPath = join(nasMount, 'config', `agent-${agentId}.json`);
    if (existsSync(configPath)) {
      const savedConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as { config?: { model?: string; authMode?: string } };
      if (savedConfig.config?.model) {
        activeModel = savedConfig.config.model;
        log.info(`Model override from NAS config: ${activeModel}`);
      }
      // Auth mode is always claude-cli (Max subscription) — no override needed
    }
  } catch { /* ignore, use default */ }

  // Create runner
  const runner = new AgentRunner({
    agentId,
    role,
    machineId,
    hostname: host,
    natsUrl,
    natsUrlThunderbolt: thunderboltEnabled ? natsUrlThunderbolt : undefined,
    nasMountPath: nasMount,
    workspacePath: workspace,
    capabilities: CAPABILITIES[role] ?? [],
    defaultModel: activeModel,
    tools,
    socialConfig: socialConfig as Record<string, unknown> | undefined,
    llm: {
      openaiApiKey: process.env['OPENAI_API_KEY'],
      googleApiKey: process.env['GOOGLE_AI_API_KEY'],
      ollamaBaseUrl: process.env['OLLAMA_BASE_URL'],
      openrouterApiKey: process.env['OPENROUTER_API_KEY'],
    },
  });

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    await runner.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start
  await runner.start();
}

main().catch((err) => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
