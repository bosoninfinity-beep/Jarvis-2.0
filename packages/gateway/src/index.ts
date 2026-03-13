import { config } from 'dotenv';
import { createLogger, DEFAULT_GATEWAY_PORT, DEFAULT_NATS_URL, DEFAULT_REDIS_URL } from '@jarvis/shared';
import { GatewayServer } from './server.js';

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env from project root
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });
config(); // Also check local .env

const log = createLogger('gateway');

function validateEnv(): void {
  const required: Array<{ key: string; label: string; minLength?: number }> = [
    { key: 'JARVIS_AUTH_TOKEN', label: 'Auth token', minLength: 32 },
    { key: 'NATS_URL', label: 'NATS broker URL' },
    { key: 'REDIS_URL', label: 'Redis URL' },
  ];

  // LLM: Claude CLI (Max subscription) — no API keys needed for Claude
  const llmKeys = ['OPENAI_API_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY'];
  const hasLlm = llmKeys.some(k => process.env[k] && process.env[k]!.length > 0);

  const errors: string[] = [];

  for (const { key, label, minLength } of required) {
    const val = process.env[key];
    if (!val) {
      errors.push(`${key} is required (${label})`);
    } else if (minLength && val.length < minLength) {
      errors.push(`${key} is too short (min ${minLength} chars). Generate: openssl rand -hex 32`);
    }
  }

  // NATS auth is required
  if (!process.env['NATS_TOKEN'] && !(process.env['NATS_USER'] && process.env['NATS_PASS'])) {
    errors.push('NATS authentication required: set NATS_TOKEN or NATS_USER + NATS_PASS');
  }

  if (!hasLlm) {
    log.warn('No optional LLM API keys configured. Claude uses CLI (Max subscription). Optional: OPENAI_API_KEY, GOOGLE_AI_API_KEY, OPENROUTER_API_KEY');
  }

  if (errors.length > 0) {
    log.error('Environment validation failed:');
    for (const e of errors) log.error(`  - ${e}`);
    log.error('See .env.example for reference');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  validateEnv();

  const thunderboltEnabled = process.env['THUNDERBOLT_ENABLED'] === 'true';

  const port = Number(process.env['JARVIS_PORT'] ?? DEFAULT_GATEWAY_PORT);
  if (isNaN(port) || port < 1 || port > 65535) {
    log.error(`Invalid JARVIS_PORT: ${process.env['JARVIS_PORT']}. Must be 1-65535.`);
    process.exit(1);
  }

  const server = new GatewayServer({
    port,
    host: process.env['JARVIS_HOST'] ?? '0.0.0.0',
    authToken: process.env['JARVIS_AUTH_TOKEN']!,
    natsUrl: process.env['NATS_URL'] ?? DEFAULT_NATS_URL,
    natsUrlThunderbolt: thunderboltEnabled ? process.env['NATS_URL_THUNDERBOLT'] : undefined,
    redisUrl: process.env['REDIS_URL'] ?? DEFAULT_REDIS_URL,
    nasMountPath: process.env['JARVIS_NAS_MOUNT'],
  });

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Received shutdown signal');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  try {
    await server.start();
    log.info('Jarvis 2.0 Gateway is running');
  } catch (err) {
    log.error('Failed to start gateway', { error: String(err) });
    process.exit(1);
  }
}

void main();
