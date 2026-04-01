/** Default ports */
export const DEFAULT_GATEWAY_PORT = 18900;
export const DEFAULT_NATS_PORT = 4222;
export const DEFAULT_REDIS_PORT = 6379;
export const DEFAULT_VNC_PORT = 5900;
export const DEFAULT_WEBSOCKIFY_PORT = 6080;

/** Heartbeat interval in ms */
export const HEARTBEAT_INTERVAL = 10_000;

/** Agent considered dead after this many missed heartbeats */
export const HEARTBEAT_TIMEOUT = 30_000;

/** Max tool result text length before truncation */
export const MAX_TOOL_RESULT_LENGTH = 8_000;

/** Max error text length */
export const MAX_ERROR_LENGTH = 400;

/** Session compaction threshold (tokens) */
export const CONTEXT_WINDOW_COMPACT_THRESHOLD = 100_000;

/** Default NAS mount path */
export const DEFAULT_NAS_MOUNT = '/Volumes/JarvisNAS/jarvis';

/** NAS subdirectories */
export const NAS_DIRS = {
  sessions: 'sessions',
  workspace: 'workspace',
  projects: 'workspace/projects',
  artifacts: 'workspace/artifacts',
  knowledge: 'knowledge',
  logs: 'logs',
  media: 'media',
  config: 'config',
  channels: 'channels',
  chat: 'chat',
  'whatsapp-auth': 'whatsapp-auth',
  'cron-jobs': 'cron-jobs',
  workflows: 'workflows',
  'workflow-runs': 'workflow-runs',
  timelines: 'timelines',
  plugins: 'plugins',
  skills: 'skills',
  metrics: 'metrics',
  plans: 'plans',
  summaries: 'knowledge/summaries',
  marketing: 'marketing',
} as const;

/** Thunderbolt 5 Bridge defaults (120 Gbps direct connect) */
export const DEFAULT_TB_NATS_PORT = 4223;
export const TB_IP_PREFIX = '10.0.1';
export const TB_MASTER_IP = `${TB_IP_PREFIX}.1`;
export const TB_SMITH_IP = `${TB_IP_PREFIX}.2`;
export const TB_JOHNY_IP = `${TB_IP_PREFIX}.3`;
export const TB_SUBNET_MASK = '255.255.255.0';

/** Default NATS connection URL */
export const DEFAULT_NATS_URL = `nats://localhost:${DEFAULT_NATS_PORT}`;

/** Default Redis connection URL */
export const DEFAULT_REDIS_URL = `redis://localhost:${DEFAULT_REDIS_PORT}`;

/** Default channel message fetch limit */
export const DEFAULT_MESSAGE_LIMIT = 200;

/** Max file size (bytes) for preview reads */
export const MAX_FILE_PREVIEW_BYTES = 1_048_576; // 1 MB

/** Project name */
export const PROJECT_NAME = 'Jarvis 2.0';
export const PROJECT_VERSION = '0.1.0';
