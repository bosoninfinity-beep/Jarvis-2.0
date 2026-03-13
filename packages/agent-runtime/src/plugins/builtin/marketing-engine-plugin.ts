/**
 * Marketing Engine Plugin v4 — Full Marketing Machine Brain.
 *
 * Provides:
 * - `marketing_db` tool: SQLite wrapper (init / query / execute / insert / export)
 * - System prompt loaded from NAS: config/marketing-hub-prompt.md
 *
 * The heavy lifting (12 agents, media pipeline, social automation, viral engine,
 * email automation, lead generation, self-learning) lives in the prompt.
 * This plugin provides the database tool (12 tables) and prompt injection.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { AgentTool, ToolResult, ToolContext } from '@jarvis/tools';
import type { JarvisPluginDefinition } from '../types.js';

// ─── Constants ───────────────────────────────────────────────────────

const PLUGIN_ID = 'marketing-engine';
const PLUGIN_NAME = 'Marketing Engine';
const DB_RELATIVE_PATH = 'marketing/marketing.db';
const PROMPT_RELATIVE_PATH = 'config/marketing-hub-prompt.md';
const SQLITE_TIMEOUT_MS = 10_000;

// ─── SQL Schema (matches prompt) ─────────────────────────────────────

const SCHEMA_SQL = `
-- 1. TRENDS: Market trends and opportunities
CREATE TABLE IF NOT EXISTS trends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_discovered TEXT NOT NULL DEFAULT (date('now')),
  product TEXT NOT NULL,
  category TEXT NOT NULL,
  platform TEXT,
  title TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  relevance_score INTEGER DEFAULT 5 CHECK(relevance_score BETWEEN 1 AND 10),
  actionability TEXT DEFAULT 'monitor' CHECK(actionability IN ('immediate','short_term','long_term','monitor')),
  action_taken TEXT,
  status TEXT DEFAULT 'new' CHECK(status IN ('new','in_progress','actioned','archived')),
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 2. VIRAL TRACKER: Viral content intelligence
CREATE TABLE IF NOT EXISTS viral_tracker (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_found TEXT NOT NULL DEFAULT (date('now')),
  platform TEXT NOT NULL,
  creator TEXT,
  content_url TEXT,
  description TEXT NOT NULL,
  format TEXT CHECK(format IN ('video','image','carousel','thread','story','reel','short','pin','article','other')),
  estimated_views TEXT,
  estimated_engagement TEXT,
  engagement_rate REAL,
  why_viral TEXT,
  hook_used TEXT,
  emotion_trigger TEXT,
  sound_used TEXT,
  applicable_to TEXT,
  adaptation_idea TEXT,
  adapted_content_id INTEGER,
  status TEXT DEFAULT 'found' CHECK(status IN ('found','analyzed','adapting','adapted','archived')),
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 3. COMPETITORS: Competitive intelligence
CREATE TABLE IF NOT EXISTS competitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  name TEXT NOT NULL,
  website TEXT,
  description TEXT,
  pricing TEXT,
  strengths TEXT,
  weaknesses TEXT,
  social_presence TEXT,
  recent_moves TEXT,
  user_sentiment TEXT,
  market_share TEXT,
  funding TEXT,
  tech_stack TEXT,
  threat_level TEXT DEFAULT 'medium' CHECK(threat_level IN ('low','medium','high','critical')),
  last_updated TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 4. AUDIENCE INSIGHTS: Customer intelligence
CREATE TABLE IF NOT EXISTS audience_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  segment TEXT NOT NULL,
  insight_type TEXT NOT NULL CHECK(insight_type IN ('demographic','psychographic','behavioral','pain_point','desire','trend','quote')),
  insight TEXT NOT NULL,
  source TEXT,
  source_url TEXT,
  confidence TEXT DEFAULT 'medium' CHECK(confidence IN ('low','medium','high','verified')),
  date_discovered TEXT,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 5. CONTENT LIBRARY: All marketing content
CREATE TABLE IF NOT EXISTS content_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  platform TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK(content_type IN ('reel','tiktok','short','carousel','post','thread','story','pin','article','blog','ad','email','video','image','podcast','other')),
  status TEXT DEFAULT 'idea' CHECK(status IN ('idea','draft','ready','scheduled','published','performing','underperforming','killed')),
  title TEXT NOT NULL,
  hook TEXT,
  body TEXT,
  cta TEXT,
  visual_description TEXT,
  media_asset_id INTEGER,
  hashtags TEXT,
  target_audience TEXT,
  goal TEXT CHECK(goal IN ('awareness','engagement','conversion','retention','authority')),
  inspired_by INTEGER,
  campaign_id INTEGER,
  engagement_rate REAL,
  views INTEGER,
  likes INTEGER,
  shares INTEGER,
  comments INTEGER,
  saves INTEGER,
  clicks INTEGER,
  conversions INTEGER,
  scheduled_date TEXT,
  published_date TEXT,
  performance_notes TEXT,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 6. LEADS: B2B and influencer leads
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  company_name TEXT NOT NULL,
  contact_name TEXT,
  title TEXT,
  email TEXT,
  linkedin TEXT,
  phone TEXT,
  website TEXT,
  company_size TEXT,
  revenue_estimate TEXT,
  location TEXT,
  industry TEXT,
  current_solution TEXT,
  pain_signals TEXT,
  growth_signals TEXT,
  lead_score INTEGER DEFAULT 0 CHECK(lead_score BETWEEN 0 AND 100),
  source TEXT,
  status TEXT DEFAULT 'new' CHECK(status IN ('new','researching','enriched','outreach','nurture','qualified','demo_booked','negotiating','won','lost','archived')),
  outreach_history TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 7. CAMPAIGNS: Marketing campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('social','email','ad','content','launch','viral_challenge','partnership','event','pr','seo','other')),
  status TEXT DEFAULT 'planning' CHECK(status IN ('planning','active','paused','completed','killed')),
  objective TEXT,
  target_audience TEXT,
  channels TEXT,
  budget REAL,
  spent REAL DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  kpi_targets TEXT,
  kpi_results TEXT,
  roas REAL,
  content_ids TEXT,
  learnings TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 8. MARKET DATA: Industry benchmarks and stats
CREATE TABLE IF NOT EXISTS market_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT,
  category TEXT NOT NULL,
  data_point TEXT NOT NULL,
  value TEXT,
  source TEXT NOT NULL,
  source_url TEXT,
  date_of_data TEXT,
  date_collected TEXT DEFAULT (date('now')),
  reliability TEXT DEFAULT 'medium' CHECK(reliability IN ('low','medium','high','verified')),
  notes TEXT,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 9. CHATBOT KB: Knowledge base for chatbots
CREATE TABLE IF NOT EXISTS chatbot_kb (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords TEXT,
  priority INTEGER DEFAULT 5 CHECK(priority BETWEEN 1 AND 10),
  last_updated TEXT,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 10. PERFORMANCE LOG: Action tracking
CREATE TABLE IF NOT EXISTS performance_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (date('now')),
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  product TEXT,
  result TEXT CHECK(result IN ('success','partial','failure','pending')),
  metrics TEXT,
  revenue_impact TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 11. MEDIA ASSETS: Generated images, videos, audio
CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK(asset_type IN ('image','video','audio','avatar','template','animation')),
  generation_tool TEXT NOT NULL,
  prompt_used TEXT,
  style TEXT,
  aspect_ratio TEXT,
  duration_sec REAL,
  file_size_kb INTEGER,
  output_path TEXT NOT NULL,
  thumbnail_path TEXT,
  quality_score INTEGER CHECK(quality_score BETWEEN 1 AND 10),
  status TEXT DEFAULT 'generated' CHECK(status IN ('generating','generated','approved','published','rejected','archived')),
  used_in_content_id INTEGER,
  platform TEXT,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 12. EMAIL CAMPAIGNS: Email sequences and performance
CREATE TABLE IF NOT EXISTS email_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  sequence_type TEXT NOT NULL CHECK(sequence_type IN ('welcome','trial','re_engagement','b2b_nurture','post_purchase','referral','cart_abandon','event_triggered','blast','newsletter')),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft','active','paused','completed','killed')),
  trigger_event TEXT,
  audience_segment TEXT,
  total_emails INTEGER DEFAULT 0,
  emails_sent INTEGER DEFAULT 0,
  open_rate REAL,
  click_rate REAL,
  reply_rate REAL,
  unsubscribe_rate REAL,
  conversion_rate REAL,
  revenue_generated REAL DEFAULT 0,
  subject_lines TEXT,
  email_bodies TEXT,
  ab_test_results TEXT,
  send_schedule TEXT,
  provider TEXT CHECK(provider IN ('brevo','resend','manual')),
  learnings TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- INDEXES for performance
CREATE INDEX IF NOT EXISTS idx_trends_product ON trends(product);
CREATE INDEX IF NOT EXISTS idx_trends_status ON trends(status);
CREATE INDEX IF NOT EXISTS idx_viral_platform ON viral_tracker(platform);
CREATE INDEX IF NOT EXISTS idx_content_product_platform ON content_library(product, platform);
CREATE INDEX IF NOT EXISTS idx_content_status ON content_library(status);
CREATE INDEX IF NOT EXISTS idx_leads_product_score ON leads(product, lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_product ON campaigns(product);
CREATE INDEX IF NOT EXISTS idx_media_product ON media_assets(product);
CREATE INDEX IF NOT EXISTS idx_email_product ON email_campaigns(product);
CREATE INDEX IF NOT EXISTS idx_perf_date ON performance_log(date);
`.trim();

/** Schema version — bump when schema changes require migration */
const SCHEMA_VERSION = 4;

/** Migration: drop and recreate all tables for clean Hub v4 schema */
const MIGRATION_SQL = `
DROP TABLE IF EXISTS trends;
DROP TABLE IF EXISTS viral_tracker;
DROP TABLE IF EXISTS competitors;
DROP TABLE IF EXISTS audience_insights;
DROP TABLE IF EXISTS content_library;
DROP TABLE IF EXISTS leads;
DROP TABLE IF EXISTS campaigns;
DROP TABLE IF EXISTS market_data;
DROP TABLE IF EXISTS chatbot_kb;
DROP TABLE IF EXISTS performance_log;
DROP TABLE IF EXISTS media_assets;
DROP TABLE IF EXISTS email_campaigns;
DROP TABLE IF EXISTS _schema_version;
CREATE TABLE _schema_version (version INTEGER PRIMARY KEY);
INSERT INTO _schema_version VALUES (${SCHEMA_VERSION});
`.trim();

// ─── Helpers ─────────────────────────────────────────────────────────

function getDbPath(nasPath: string): string {
  return join(nasPath, DB_RELATIVE_PATH);
}

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Escape a value for safe SQLite string literal insertion.
 * Doubles single quotes (SQL standard) and wraps in single quotes.
 * NULL values return the SQL keyword NULL (unquoted).
 */
function sqlEscape(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  const str = String(value);
  return `'${str.replace(/'/g, "''")}'`;
}

/**
 * Run a sqlite3 command and return stdout.
 * SQL is piped via stdin (not shell args) to prevent shell injection.
 * Uses -json for SELECT queries, -bail for DDL/DML.
 */
function runSqlite3(dbPath: string, sql: string, jsonMode: boolean): string {
  ensureDir(join(dbPath, '..'));
  const args = jsonMode ? ['-json'] : ['-bail'];
  const result = execSync(
    `sqlite3 ${args.join(' ')} "${dbPath}"`,
    {
      input: sql,
      encoding: 'utf-8',
      timeout: SQLITE_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
    },
  );
  return result.trim();
}

// ─── Tool: marketing_db ──────────────────────────────────────────────

function createMarketingDbTool(nasPath: string): AgentTool {
  const dbPath = getDbPath(nasPath);

  return {
    definition: {
      name: 'marketing_db',
      description:
        'SQLite database for the Marketing Hub v4 brain. 12 tables: trends, viral_tracker, competitors, audience_insights, content_library, leads, campaigns, market_data, chatbot_kb, performance_log, media_assets, email_campaigns. Actions: init (create all 12 tables), query (SELECT → JSON), execute (INSERT/UPDATE/DELETE), insert (safe parameterized INSERT), export (table → markdown).',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['init', 'query', 'execute', 'insert', 'export'],
            description:
              'init = create tables | query = SELECT → JSON | execute = raw INSERT/UPDATE/DELETE | insert = safe parameterized INSERT (auto-escapes values) | export = table → markdown',
          },
          sql: {
            type: 'string',
            description: 'SQL statement (for query/execute). Use doubled single quotes (\'\') for apostrophes in strings.',
          },
          table: {
            type: 'string',
            description: 'Table name (for insert/export)',
          },
          data: {
            type: 'object',
            description: 'Key-value pairs to INSERT (for insert action). Values are auto-escaped — safe for any string content including quotes, URLs, HTML.',
          },
          where: {
            type: 'string',
            description: 'Optional WHERE clause for export (without the WHERE keyword)',
          },
        },
        required: ['action'],
      },
    },

    async execute(
      params: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolResult> {
      const action = params.action as string;

      try {
        switch (action) {
          // ── Init: create all 12 tables + learning files ──
          case 'init': {
            // Check schema version — migrate if outdated
            let needsMigration = false;
            try {
              const versionResult = runSqlite3(dbPath, "SELECT version FROM _schema_version LIMIT 1;", true);
              const parsed = JSON.parse(versionResult);
              if (!parsed[0] || parsed[0].version < SCHEMA_VERSION) needsMigration = true;
            } catch {
              needsMigration = true; // table doesn't exist = old schema
            }

            if (needsMigration) {
              runSqlite3(dbPath, MIGRATION_SQL, false);
            }

            runSqlite3(dbPath, SCHEMA_SQL, false);

            // Ensure schema version is recorded
            try {
              runSqlite3(dbPath, `INSERT OR REPLACE INTO _schema_version (version) VALUES (${SCHEMA_VERSION});`, false);
            } catch { /* ignore if already set by migration */ }

            // Create persistent learning files on NAS
            const marketingDir = join(dbPath, '..'); // marketing/ dir
            const learningFiles = [
              { name: 'STRATEGY_LOG.md', header: '# Strategy Log\n\nRunning strategic decisions with reasoning. Updated every session.\n\n---\n' },
              { name: 'LEARNINGS.md', header: '# Learnings\n\nWhat worked, what failed, and why. Updated after every review.\n\n---\n' },
              { name: 'BRAND_VOICE.md', header: '# Brand Voice Guide\n\nEvolving brand voice per product (OKIDOOKI, NowTrust, MakeItFun).\n\n---\n' },
              { name: 'KILL_LIST.md', header: '# Kill List\n\nKilled initiatives with reasons and full analysis.\n\n---\n' },
            ];
            const filesCreated: string[] = [];
            for (const file of learningFiles) {
              const filePath = join(marketingDir, file.name);
              if (!existsSync(filePath)) {
                writeFileSync(filePath, file.header, 'utf-8');
                filesCreated.push(file.name);
              }
            }

            // Verify tables were created
            const tables = runSqlite3(dbPath, ".tables", false);
            const fileStatus = filesCreated.length > 0
              ? `\nLearning files created: ${filesCreated.join(', ')}`
              : '\nLearning files: all exist';
            return {
              type: 'text',
              content: `Database initialized at ${dbPath} (schema v${SCHEMA_VERSION}${needsMigration ? ' — migrated' : ''})\n\nTables:\n${tables}${fileStatus}`,
              metadata: { dbPath, tables: tables.split(/\s+/).filter(Boolean), schemaVersion: SCHEMA_VERSION },
            };
          }

          // ── Query: SELECT → JSON ──
          case 'query': {
            const sql = params.sql as string;
            if (!sql) {
              return { type: 'error', content: 'Missing required parameter: sql' };
            }
            if (!sql.trim().toUpperCase().startsWith('SELECT')) {
              return {
                type: 'error',
                content: 'Query action only supports SELECT statements. Use "execute" for INSERT/UPDATE/DELETE.',
              };
            }
            const result = runSqlite3(dbPath, sql, true);
            if (!result) {
              return { type: 'text', content: '[]', metadata: { rowCount: 0 } };
            }
            let rows: unknown[];
            try {
              rows = JSON.parse(result);
            } catch {
              return { type: 'text', content: result };
            }
            return {
              type: 'text',
              content: JSON.stringify(rows, null, 2),
              metadata: { rowCount: Array.isArray(rows) ? rows.length : 0 },
            };
          }

          // ── Execute: raw INSERT/UPDATE/DELETE (caller must escape) ──
          case 'execute': {
            const sql = params.sql as string;
            if (!sql) {
              return { type: 'error', content: 'Missing required parameter: sql' };
            }
            const upper = sql.trim().toUpperCase();
            if (upper.startsWith('SELECT')) {
              return {
                type: 'error',
                content: 'Execute action does not support SELECT. Use "query" instead.',
              };
            }
            runSqlite3(dbPath, sql, false);
            // Get affected rows count
            const changes = runSqlite3(dbPath, 'SELECT changes() as affected_rows;', true);
            let affectedRows = 0;
            try {
              const parsed = JSON.parse(changes);
              affectedRows = parsed[0]?.affected_rows ?? 0;
            } catch { /* ignore */ }
            return {
              type: 'text',
              content: `Executed successfully. Rows affected: ${affectedRows}`,
              metadata: { affectedRows },
            };
          }

          // ── Insert: safe parameterized INSERT (auto-escapes all values) ──
          case 'insert': {
            const table = params.table as string;
            const data = params.data as Record<string, unknown> | undefined;
            if (!table) {
              return { type: 'error', content: 'Missing required parameter: table' };
            }
            if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
              return { type: 'error', content: 'Missing or empty required parameter: data (object with column: value pairs)' };
            }
            // Sanitize table name
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
              return { type: 'error', content: 'Invalid table name — only alphanumeric and underscores allowed' };
            }
            const columns = Object.keys(data);
            // Sanitize column names
            for (const col of columns) {
              if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
                return { type: 'error', content: `Invalid column name: ${col}` };
              }
            }
            const values = columns.map((col) => sqlEscape(data[col]));
            const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')});`;
            runSqlite3(dbPath, sql, false);
            // Get the last inserted row ID
            const lastId = runSqlite3(dbPath, 'SELECT last_insert_rowid() as id;', true);
            let insertedId = 0;
            try {
              const parsed = JSON.parse(lastId);
              insertedId = parsed[0]?.id ?? 0;
            } catch { /* ignore */ }
            return {
              type: 'text',
              content: `Inserted into "${table}" successfully. Row ID: ${insertedId}`,
              metadata: { table, insertedId },
            };
          }

          // ── Export: table → markdown ──
          case 'export': {
            const table = params.table as string;
            if (!table) {
              return { type: 'error', content: 'Missing required parameter: table' };
            }
            // Sanitize table name (only allow alphanumeric + underscore)
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
              return { type: 'error', content: 'Invalid table name' };
            }
            const where = params.where as string | undefined;
            const whereClause = where ? ` WHERE ${where}` : '';
            const sql = `SELECT * FROM ${table}${whereClause} ORDER BY id DESC LIMIT 100;`;
            const result = runSqlite3(dbPath, sql, true);
            if (!result) {
              return { type: 'text', content: `Table "${table}" is empty.` };
            }
            let rows: Record<string, unknown>[];
            try {
              rows = JSON.parse(result);
            } catch {
              return { type: 'text', content: result };
            }
            if (rows.length === 0) {
              return { type: 'text', content: `Table "${table}" is empty.` };
            }
            // Build markdown table
            const columns = Object.keys(rows[0]);
            const header = `| ${columns.join(' | ')} |`;
            const separator = `| ${columns.map(() => '---').join(' | ')} |`;
            const body = rows
              .map(
                (row) =>
                  `| ${columns.map((col) => {
                    const val = row[col];
                    if (val === null || val === undefined) return '';
                    const str = String(val);
                    // Truncate long values in table display
                    return str.length > 80 ? str.slice(0, 77) + '...' : str;
                  }).join(' | ')} |`,
              )
              .join('\n');
            const markdown = `## ${table} (${rows.length} rows)\n\n${header}\n${separator}\n${body}`;
            return {
              type: 'text',
              content: markdown,
              metadata: { table, rowCount: rows.length },
            };
          }

          default:
            return {
              type: 'error',
              content: `Unknown action: ${action}. Valid actions: init, query, execute, export`,
            };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { type: 'error', content: `marketing_db error: ${msg}` };
      }
    },
  };
}

// ─── Load prompt from NAS file ───────────────────────────────────────

function loadPromptContent(nasPath: string): string {
  const promptPath = join(nasPath, PROMPT_RELATIVE_PATH);
  try {
    if (existsSync(promptPath)) {
      return readFileSync(promptPath, 'utf-8');
    }
  } catch { /* fall through to fallback */ }

  // Fallback: minimal prompt if file missing
  return `# Marketing Hub v4

You are an autonomous marketing machine running a 12-agent marketing agency.
Your brain is a SQLite database — use the \`marketing_db\` tool to store and query all marketing intelligence.

## Core Principles
1. Research-first: Always \`web_search\` before creating content or strategy.
2. Revenue-obsessed: Every action must trace back to revenue.
3. Self-improving: Log performance, review learnings, adapt.
4. Data-driven: Store everything in SQLite. Query before creating.

## Quick Start
Run \`init database\` to set up the SQLite brain, then \`full sprint\` for a complete marketing cycle.

> Full prompt file missing at: ${promptPath}
> Place the complete marketing-hub-prompt.md there for full capabilities.`;
}

// ─── Plugin Definition ───────────────────────────────────────────────

export function createMarketingEnginePlugin(): JarvisPluginDefinition {
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'Full marketing machine: 12 agents, media pipeline, social automation, viral engine, email, leads, self-learning. SQLite brain with 12 tables.',
    version: '4.0.0',

    register(api) {
      const nasPath = api.config.nasPath;

      // ── Register marketing_db tool ──
      api.registerTool(createMarketingDbTool(nasPath));

      // ── Register system prompt from NAS file ──
      // Priority 95 = highest among all plugins (memory=90, obsidian=85, voice=50).
      // This is intentional: Marketing Hub IS agent-johny's core identity.
      // If this agent ever needs non-marketing tasks, lower to ~7 to sit below memory/obsidian.
      const promptContent = loadPromptContent(nasPath);
      api.registerPromptSection({
        title: 'Marketing Hub v4',
        content: promptContent,
        priority: 95,
      });

      // ── Content Autopilot Integration (maps Hub v4 commands to actual tools) ──
      api.registerPromptSection({
        title: 'Content Autopilot Integration',
        content: `## Content Autopilot — Tool Mapping

When running content autopilot or batch operations, map Hub v4 commands to these real tools:

### Posting Flow
1. Create content → \`marketing_db\` INSERT into content_library (status: 'ready')
2. Generate media → \`media_generate\` with S.S.C.M.L. prompt → save to NAS → \`marketing_db\` INSERT into media_assets
3. Schedule post → \`social_schedule\` with action 'batch_schedule' (auto-spaces by optimal times per product)
4. Background executor auto-publishes when scheduled_at arrives via \`social_post\`
5. Track metrics → \`social_analytics\` per platform → \`marketing_db\` UPDATE content_library with engagement data

### Engagement Flow
1. Monitor mentions → \`social_engage\` action 'monitor' per platform
2. Find viral content → \`social_engage\` action 'search_viral' with niche query
3. Reply to trending posts → \`social_engage\` action 'reply' (engagement farming)
4. Like relevant content → \`social_engage\` action 'like' (algorithm signal)

### Style Learning (XPatla-style)
Before creating new content, ALWAYS query your performance history:
\`\`\`
marketing_db query "SELECT product, platform, hook, content_type, engagement_rate, views FROM content_library WHERE status IN ('published','performing') AND engagement_rate IS NOT NULL ORDER BY engagement_rate DESC LIMIT 15"
\`\`\`
Clone the hook style, format, and tone of your top performers. Kill patterns from your bottom performers.

### Persistent Learning Files
Read and update these files in the marketing/ folder on NAS:
- \`STRATEGY_LOG.md\` — strategic decisions with reasoning (every session)
- \`LEARNINGS.md\` — what worked/failed and why (after every review)
- \`BRAND_VOICE.md\` — evolving brand voice per product (monthly)
- \`KILL_LIST.md\` — killed initiatives with reasons (when underperformers found)

### Skills Library
32 expert marketing skills available at \`${nasPath}/marketing/skills/\`. Read the SKILL.md file before executing any marketing task:
- Copywriting → \`skills/copywriting/SKILL.md\`
- Social content → \`skills/social-content/SKILL.md\`
- SEO audit → \`skills/seo-audit/SKILL.md\`
- Email sequences → \`skills/email-sequence/SKILL.md\`
- See marketing-agent prompt for full skill index.`,
        priority: 10,
      });

      api.logger.info('Marketing Engine v4 loaded', {
        dbPath: getDbPath(nasPath),
        promptSource: existsSync(join(nasPath, PROMPT_RELATIVE_PATH)) ? 'nas-file' : 'fallback',
      });
    },
  };
}
