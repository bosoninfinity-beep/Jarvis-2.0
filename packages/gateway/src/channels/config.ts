/**
 * Channel configuration & message storage — extracted from server.ts
 *
 * Stateless helpers that operate on NAS paths for channel config/messages.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@jarvis/shared';
import type { NasPaths } from '../nas/paths.js';

const log = createLogger('gateway:channels');

const VALID_CHANNEL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Default configs per channel */
const CHANNEL_DEFAULTS: Record<string, Record<string, unknown>> = {
  whatsapp: {
    autoReplyEnabled: false,
    autoReplyLanguage: 'pl',
    jarvisMode: true,
    notifyOnMessage: true,
    autoConnect: false,
    authorizedJids: [],
    notificationJid: '',
    defaultAgent: 'jarvis',
    enableCommands: true,
    maxMessageLength: 4000,
  },
  telegram: {
    botToken: process.env['TELEGRAM_BOT_TOKEN'] ?? '',
    chatId: process.env['TELEGRAM_CHAT_ID'] ?? '',
    webhookUrl: '',
    autoReplyEnabled: false,
    autoReplyLanguage: 'pl',
    jarvisMode: true,
    allowedUsers: [],
    notifyOnMessage: true,
  },
  discord: {
    botToken: process.env['DISCORD_BOT_TOKEN'] ?? '',
    applicationId: process.env['DISCORD_APP_ID'] ?? '',
    guildId: process.env['DISCORD_GUILD_ID'] ?? '',
    channelId: process.env['DISCORD_CHANNEL_ID'] ?? '',
    webhookUrl: process.env['DISCORD_WEBHOOK_URL'] ?? '',
    autoReplyEnabled: false,
    autoReplyLanguage: 'pl',
    jarvisMode: true,
    notifyOnMessage: true,
  },
  slack: {
    botToken: process.env['SLACK_BOT_TOKEN'] ?? '',
    appToken: process.env['SLACK_APP_TOKEN'] ?? '',
    signingSecret: process.env['SLACK_SIGNING_SECRET'] ?? '',
    defaultChannel: process.env['SLACK_DEFAULT_CHANNEL'] ?? '#general',
    mode: 'socket',
    autoReplyEnabled: false,
    autoReplyLanguage: 'pl',
    jarvisMode: true,
    notifyOnMessage: true,
  },
};

/** Load channel config from NAS, falling back to defaults */
export function getChannelConfig(nas: NasPaths, channel: string): Record<string, unknown> {
  if (!VALID_CHANNEL_NAME_RE.test(channel)) {
    throw new Error(`Invalid channel name: ${channel}`);
  }
  const configPath = nas.resolve('config', `${channel}.json`);
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch (err) {
    log.warn(`Corrupt config for channel ${channel}, using defaults`, { error: String(err) });
  }
  return CHANNEL_DEFAULTS[channel] ?? {};
}

/** Save channel config to NAS, merging with existing */
export function setChannelConfig(
  nas: NasPaths,
  channel: string,
  updates: Record<string, unknown>,
): { success: boolean; config: Record<string, unknown> } {
  if (!VALID_CHANNEL_NAME_RE.test(channel)) {
    throw new Error(`Invalid channel name: ${channel}`);
  }
  const configPath = nas.resolve('config', `${channel}.json`);
  let config = getChannelConfig(nas, channel);
  config = { ...config, ...updates, updatedAt: new Date().toISOString() };

  try {
    const configDir = nas.resolve('config');
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log.info(`${channel} config updated`);
    return { success: true, config };
  } catch (err) {
    log.error(`Failed to save ${channel} config`, { error: String(err) });
    return { success: false, config };
  }
}

/** Load recent messages from JSONL storage */
export function getChannelMessages(
  nas: NasPaths,
  channel: string,
  limit: number,
): { messages: Array<Record<string, unknown>> } {
  if (!VALID_CHANNEL_NAME_RE.test(channel)) {
    throw new Error(`Invalid channel name: ${channel}`);
  }
  const dir = nas.resolve('channels', channel);
  const jsonlPath = join(dir, 'messages.jsonl');
  const jsonPath = join(dir, 'messages.json');
  try {
    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const messages = lines
        .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
        .filter(Boolean) as Array<Record<string, unknown>>;
      return { messages: messages.slice(-limit) };
    }
    if (existsSync(jsonPath)) {
      const all = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Array<Record<string, unknown>>;
      return { messages: all.slice(-limit) };
    }
  } catch { /* ignore */ }
  return { messages: [] };
}

/** Append a message to the channel's JSONL log */
export function appendChannelMessage(
  nas: NasPaths,
  channel: string,
  message: Record<string, unknown>,
): void {
  if (!VALID_CHANNEL_NAME_RE.test(channel)) {
    throw new Error(`Invalid channel name: ${channel}`);
  }
  const dir = nas.resolve('channels', channel);
  const file = join(dir, 'messages.jsonl');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(message) + '\n', 'utf-8');
  } catch (err) {
    log.error(`Failed to save ${channel} message`, { error: String(err) });
  }
}
