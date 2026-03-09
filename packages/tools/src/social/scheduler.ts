import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLogger } from '@jarvis/shared';
import type { AgentTool, ToolContext, ToolResult } from '../base.js';
import { createToolResult, createErrorResult } from '../base.js';
import { SocialTool, type SocialToolConfig } from './social-tool.js';

const log = createLogger('tool:social:scheduler');

/** DB path relative to NAS root */
const DB_RELATIVE_PATH = 'marketing/marketing.db';

/** Schema for scheduled_posts table (created if not exists) */
const SCHEDULER_SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'post',
  text TEXT NOT NULL,
  media_url TEXT,
  media_urls TEXT,
  link TEXT,
  title TEXT,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status ON scheduled_posts(status, scheduled_at);
`;

export interface ScheduledPost {
  id: string;
  platform: string;
  action: string;
  text: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  link?: string;
  title?: string;
  scheduledAt: number; // Unix timestamp ms
  status: 'scheduled' | 'published' | 'failed' | 'cancelled';
  createdAt: number;
  publishedAt?: number;
  error?: string;
}

/** Run sqlite3 CLI and return stdout */
function runSql(dbPath: string, sql: string, json = false): string {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const args = json ? ['-json'] : [];
  try {
    return execSync(
      `sqlite3 ${args.join(' ')} "${dbPath}"`,
      { input: sql, encoding: 'utf-8', timeout: 10_000 },
    ).trim();
  } catch (err) {
    log.error(`SQLite error: ${(err as Error).message}`);
    throw err;
  }
}

/** Ensure scheduled_posts table exists */
function ensureTable(dbPath: string): void {
  runSql(dbPath, SCHEDULER_SCHEMA);
}

/** Parse JSON rows from sqlite3 -json output */
function parseRows<T>(output: string): T[] {
  if (!output) return [];
  try {
    return JSON.parse(output) as T[];
  } catch {
    return [];
  }
}

/**
 * Social media post scheduler — SQLite-backed (uses marketing.db).
 * Atomic reads/writes, crash-safe, no JSON file corruption risks.
 */
export class SocialSchedulerTool implements AgentTool {
  definition = {
    name: 'social_schedule',
    description: 'Schedule social media posts for future publishing. Manage a content calendar with scheduled posts across all platforms.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['schedule', 'list', 'cancel', 'reschedule'],
          description: 'Scheduler action',
        },
        platform: { type: 'string', description: 'Target platform' },
        post_type: { type: 'string', enum: ['post', 'photo', 'video', 'thread', 'carousel', 'reel'], description: 'Content type' },
        text: { type: 'string', description: 'Post content' },
        media_url: { type: 'string', description: 'Media URL' },
        scheduled_at: { type: 'string', description: 'ISO date string for when to publish (e.g. "2025-06-15T10:00:00Z")' },
        post_id: { type: 'string', description: 'Post ID (for cancel/reschedule)' },
      },
      required: ['action'],
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    const dbPath = join(context.nasPath, DB_RELATIVE_PATH);
    ensureTable(dbPath);

    switch (action) {
      case 'schedule': {
        const platform = params['platform'] as string;
        const text = params['text'] as string;
        const scheduledAt = params['scheduled_at'] as string;
        if (!platform || !text || !scheduledAt) {
          return createErrorResult('schedule requires: platform, text, scheduled_at');
        }

        const id = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const postType = (params['post_type'] as string) || 'post';
        const mediaUrl = (params['media_url'] as string) || null;
        const mediaUrls = params['media_urls'] ? JSON.stringify(params['media_urls']) : null;
        const link = (params['link'] as string) || null;
        const title = (params['title'] as string) || null;
        const scheduledAtMs = new Date(scheduledAt).getTime();
        const now = Date.now();

        const escapeSql = (s: string | null) => s ? `'${s.replace(/'/g, "''")}'` : 'NULL';

        runSql(dbPath, `INSERT INTO scheduled_posts (id, platform, action, text, media_url, media_urls, link, title, scheduled_at, status, created_at) VALUES (${escapeSql(id)}, ${escapeSql(platform)}, ${escapeSql(postType)}, ${escapeSql(text)}, ${escapeSql(mediaUrl)}, ${escapeSql(mediaUrls)}, ${escapeSql(link)}, ${escapeSql(title)}, ${scheduledAtMs}, 'scheduled', ${now});`);

        return createToolResult(
          `Post scheduled:\n  ID: ${id}\n  Platform: ${platform}\n  Scheduled: ${scheduledAt}\n  Text: ${text.slice(0, 80)}...`,
        );
      }

      case 'list': {
        const rows = parseRows<{ id: string; platform: string; scheduled_at: number; text: string; status: string }>(
          runSql(dbPath, `SELECT id, platform, scheduled_at, text, status FROM scheduled_posts WHERE status = 'scheduled' ORDER BY scheduled_at ASC;`, true),
        );

        if (rows.length === 0) return createToolResult('No scheduled posts.');

        const list = rows.map((p, i) => {
          const when = new Date(p.scheduled_at).toISOString();
          return `${i + 1}. [${p.id}] ${p.platform} @ ${when}\n   ${p.text.slice(0, 60)}...`;
        });

        return createToolResult(`Scheduled posts (${rows.length}):\n${list.join('\n')}`);
      }

      case 'cancel': {
        const postId = params['post_id'] as string;
        if (!postId) return createErrorResult('cancel requires: post_id');

        const escapeSql = (s: string) => `'${s.replace(/'/g, "''")}'`;
        runSql(dbPath, `UPDATE scheduled_posts SET status = 'cancelled' WHERE id = ${escapeSql(postId)} AND status = 'scheduled';`);
        const changes = runSql(dbPath, 'SELECT changes() as n;', true);
        const n = parseRows<{ n: number }>(changes)[0]?.n ?? 0;
        if (n === 0) return createErrorResult(`Post not found or already processed: ${postId}`);
        return createToolResult(`Post ${postId} cancelled.`);
      }

      case 'reschedule': {
        const postId = params['post_id'] as string;
        const newTime = params['scheduled_at'] as string;
        if (!postId || !newTime) return createErrorResult('reschedule requires: post_id, scheduled_at');

        const newMs = new Date(newTime).getTime();
        const escapeSql = (s: string) => `'${s.replace(/'/g, "''")}'`;
        runSql(dbPath, `UPDATE scheduled_posts SET scheduled_at = ${newMs} WHERE id = ${escapeSql(postId)} AND status = 'scheduled';`);
        const changes = runSql(dbPath, 'SELECT changes() as n;', true);
        const n = parseRows<{ n: number }>(changes)[0]?.n ?? 0;
        if (n === 0) return createErrorResult(`Post not found or already processed: ${postId}`);
        return createToolResult(`Post ${postId} rescheduled to ${newTime}`);
      }

      default:
        return createErrorResult(`Unknown action: ${action}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Scheduled Post Executor — the automation engine
// Runs on a timer, checks for due posts, publishes them (SQLite-backed)
// ═══════════════════════════════════════════════════════════════════

const MAX_PUBLISH_RETRIES = 2;

export class ScheduledPostExecutor {
  private socialTool: SocialTool;
  private dbPath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    socialConfig: SocialToolConfig,
    nasPath: string,
    private readonly checkIntervalMs = 60_000,
  ) {
    this.socialTool = new SocialTool(socialConfig);
    this.dbPath = join(nasPath, DB_RELATIVE_PATH);
    ensureTable(this.dbPath);
  }

  start(): void {
    if (this.timer) return;
    log.info(`Scheduled post executor started (checking every ${this.checkIntervalMs / 1000}s)`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('Scheduled post executor stopped');
    }
  }

  async tick(): Promise<{ published: number; failed: number }> {
    if (this.running) return { published: 0, failed: 0 };
    this.running = true;

    let published = 0;
    let failed = 0;

    try {
      const now = Date.now();
      const rows = parseRows<{
        id: string; platform: string; action: string; text: string;
        media_url: string | null; media_urls: string | null;
        link: string | null; title: string | null;
      }>(
        runSql(this.dbPath, `SELECT id, platform, action, text, media_url, media_urls, link, title FROM scheduled_posts WHERE status = 'scheduled' AND scheduled_at <= ${now};`, true),
      );

      if (rows.length === 0) return { published: 0, failed: 0 };

      log.info({ count: rows.length }, 'Publishing due scheduled posts');

      for (const row of rows) {
        const success = await this.publishPost(row);
        const escapeSql = (s: string) => `'${s.replace(/'/g, "''")}'`;

        if (success) {
          runSql(this.dbPath, `UPDATE scheduled_posts SET status = 'published', published_at = ${Date.now()} WHERE id = ${escapeSql(row.id)};`);
          published++;
          log.info({ postId: row.id, platform: row.platform }, 'Scheduled post published');
        } else {
          runSql(this.dbPath, `UPDATE scheduled_posts SET status = 'failed' WHERE id = ${escapeSql(row.id)};`);
          failed++;
          log.error({ postId: row.id, platform: row.platform }, 'Scheduled post failed');
        }
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Executor tick failed');
    } finally {
      this.running = false;
    }

    return { published, failed };
  }

  private async publishPost(row: {
    id: string; platform: string; action: string; text: string;
    media_url: string | null; media_urls: string | null;
    link: string | null; title: string | null;
  }): Promise<boolean> {
    const params: Record<string, unknown> = {
      platform: row.platform,
      action: row.action,
      text: row.text,
    };
    if (row.media_url) params['media_url'] = row.media_url;
    if (row.media_urls) {
      try { params['media_urls'] = JSON.parse(row.media_urls); } catch { /* ignore */ }
    }
    if (row.link) params['link'] = row.link;
    if (row.title) params['title'] = row.title;

    for (let attempt = 1; attempt <= MAX_PUBLISH_RETRIES; attempt++) {
      try {
        const context = { agentId: 'scheduler', workspacePath: '', nasPath: '', sessionId: 'auto-publish' };
        const result = await this.socialTool.execute(params, context);

        if (result.type === 'error') {
          if (attempt < MAX_PUBLISH_RETRIES) {
            log.warn({ postId: row.id, attempt }, `Publish attempt failed, retrying: ${result.content}`);
            await new Promise(r => setTimeout(r, 3000 * attempt));
            continue;
          }
          return false;
        }
        return true;
      } catch (err) {
        if (attempt < MAX_PUBLISH_RETRIES) {
          await new Promise(r => setTimeout(r, 3000 * attempt));
          continue;
        }
        return false;
      }
    }
    return false;
  }

  async getStats(): Promise<{ scheduled: number; published: number; failed: number; nextDue: string | null }> {
    const rows = parseRows<{ status: string; cnt: number }>(
      runSql(this.dbPath, `SELECT status, COUNT(*) as cnt FROM scheduled_posts GROUP BY status;`, true),
    );
    const byStatus = Object.fromEntries(rows.map(r => [r.status, r.cnt]));

    const nextRows = parseRows<{ scheduled_at: number }>(
      runSql(this.dbPath, `SELECT scheduled_at FROM scheduled_posts WHERE status = 'scheduled' ORDER BY scheduled_at ASC LIMIT 1;`, true),
    );
    const nextDue = nextRows[0] ? new Date(nextRows[0].scheduled_at).toISOString() : null;

    return {
      scheduled: byStatus['scheduled'] ?? 0,
      published: byStatus['published'] ?? 0,
      failed: byStatus['failed'] ?? 0,
      nextDue,
    };
  }
}
