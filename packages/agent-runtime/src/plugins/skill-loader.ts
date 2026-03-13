/**
 * Skill Loader — OpenClaw-inspired skill discovery, gating, and hot-reload.
 *
 * Skills are directories containing a SKILL.md file with YAML frontmatter.
 * They inject context into the agent's system prompt so it knows how to use
 * external tools, CLIs, and workflows.
 *
 * OpenClaw patterns implemented:
 * - Hierarchical loading with precedence (workspace > user > NAS > bundled)
 * - Metadata gating (OS, required binaries, env vars, always-on)
 * - Hot-reload via file watcher with debounce
 * - Per-run environment injection from skill config
 * - Token cost awareness for prompt budgeting
 * - {baseDir} token resolution
 * - Command dispatch (tool routing without LLM)
 *
 * Directory structure:
 *   jarvis-nas/skills/
 *     ├── github/SKILL.md
 *     ├── web-scraping/SKILL.md
 *     ├── react-native/SKILL.md
 *     └── ...
 */

import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { createLogger } from '@jarvis/shared';
import type { SkillDefinition } from './types.js';

const log = createLogger('plugins:skills');

// ─── Extended Skill Definition ────────────────────────────────────────

export interface SkillMetadata {
  /** Always load this skill regardless of gating */
  always?: boolean;
  /** OS restriction: 'darwin' | 'linux' | 'win32' */
  os?: string[];
  /** Required binaries on PATH */
  requiresBins?: string[];
  /** At least one of these binaries must exist */
  requiresAnyBins?: string[];
  /** Required environment variables */
  requiresEnv?: string[];
  /** User-invocable via slash command (default: true) */
  userInvocable?: boolean;
  /** Disable model auto-invocation */
  disableModelInvocation?: boolean;
  /** Command dispatch: tool name to route to directly */
  commandTool?: string;
  /** Environment overrides injected at runtime */
  env?: Record<string, string>;
  /** Priority for ordering (higher = more important) */
  priority?: number;
}

export interface EnhancedSkillDefinition extends SkillDefinition {
  /** Full content of the SKILL.md (loaded on demand) */
  content?: string;
  /** Parsed metadata from frontmatter */
  metadata?: SkillMetadata;
  /** Source directory of the skill */
  baseDir: string;
  /** Whether this skill passed gating checks */
  eligible: boolean;
  /** Token cost estimate for this skill in the prompt */
  tokenCost: number;
}

// ─── Skill Loader Configuration ───────────────────────────────────────

export interface SkillLoaderConfig {
  /** Skill search directories in precedence order (first = highest priority) */
  searchDirs: string[];
  /** Extra directories to search */
  extraDirs?: string[];
  /** Enable file watcher for hot-reload */
  watchEnabled?: boolean;
  /** Debounce time for watcher (ms) */
  watchDebounceMs?: number;
  /** Available tools (for requires.tools gating) */
  availableTools?: string[];
  /** Skill-specific configuration overrides */
  skillConfigs?: Record<string, { enabled?: boolean; env?: Record<string, string> }>;
}

// ─── Cache ────────────────────────────────────────────────────────────

let _cachedSkills: EnhancedSkillDefinition[] | null = null;
let _watchers: ReturnType<typeof watch>[] = [];

// ─── Core Functions ───────────────────────────────────────────────────

/**
 * Load skills from NAS path (simple API — backwards compatible).
 */
export function loadSkills(nasPath: string): SkillDefinition[] {
  const skillsDir = join(nasPath, 'skills');
  if (!existsSync(skillsDir)) {
    return [];
  }

  const enhanced = loadSkillsEnhanced({
    searchDirs: [skillsDir],
  });

  return enhanced.filter(s => s.eligible);
}

/**
 * Load skills with full OpenClaw-style features.
 */
export function loadSkillsEnhanced(config: SkillLoaderConfig): EnhancedSkillDefinition[] {
  const allDirs = [...config.searchDirs, ...(config.extraDirs ?? [])];
  const skillMap = new Map<string, EnhancedSkillDefinition>();

  // Load from each directory in order (later dirs have lower precedence)
  for (const dir of allDirs) {
    if (!existsSync(dir)) continue;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

        // Skip if already loaded from higher-precedence directory
        if (skillMap.has(entry.name)) continue;

        const skillDir = join(dir, entry.name);
        const skillMdPath = join(skillDir, 'SKILL.md');
        if (!existsSync(skillMdPath)) continue;

        try {
          const content = readFileSync(skillMdPath, 'utf-8');
          const skill = parseSkillMdEnhanced(entry.name, skillMdPath, skillDir, content);

          if (skill) {
            // Apply skill config overrides
            const skillConfig = config.skillConfigs?.[entry.name];
            if (skillConfig?.enabled === false) {
              skill.eligible = false;
            }
            if (skillConfig?.env) {
              skill.metadata = { ...skill.metadata, env: { ...skill.metadata?.env, ...skillConfig.env } };
            }

            // Run gating checks
            if (skill.eligible) {
              skill.eligible = checkGating(skill, config.availableTools);
            }

            skillMap.set(entry.name, skill);
          }
        } catch (err) {
          log.warn(`Failed to parse skill: ${entry.name} - ${(err as Error).message}`);
        }
      }
    } catch (err) {
      log.error(`Failed to scan skills directory ${dir}: ${(err as Error).message}`);
    }
  }

  const skills = Array.from(skillMap.values())
    .sort((a, b) => (b.metadata?.priority ?? 0) - (a.metadata?.priority ?? 0));

  const eligible = skills.filter(s => s.eligible);
  const totalTokenCost = eligible.reduce((sum, s) => sum + s.tokenCost, 0);

  log.info(
    `Loaded ${skills.length} skills (${eligible.length} eligible), ` +
    `~${totalTokenCost} tokens in prompt`
  );

  _cachedSkills = skills;

  // Setup watcher if enabled
  if (config.watchEnabled !== false) {
    setupWatcher(allDirs, config.watchDebounceMs ?? 250, config);
  }

  return skills;
}

/**
 * Get cached skills (for use between sessions).
 */
export function getCachedSkills(): EnhancedSkillDefinition[] {
  return _cachedSkills ?? [];
}

/**
 * Stop the file watcher.
 */
export function stopSkillWatcher(): void {
  for (const w of _watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  const count = _watchers.length;
  _watchers = [];
  if (count > 0) log.info(`Skill watcher stopped (${count} watchers closed)`);
}

// ─── Parsing ──────────────────────────────────────────────────────────

/**
 * Parse a SKILL.md file with full metadata extraction.
 */
function parseSkillMdEnhanced(
  id: string,
  path: string,
  baseDir: string,
  content: string,
): EnhancedSkillDefinition | null {
  let name = id;
  let description = '';
  let emoji: string | undefined;
  let requires: { bins?: string[]; tools?: string[] } | undefined;
  const metadata: SkillMetadata = {};

  // Parse YAML frontmatter (between --- delimiters)
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    const frontmatter = fmMatch[1] ?? '';

    // Simple YAML parsing (key: value)
    for (const line of frontmatter.split('\n')) {
      const kv = line.match(/^(\S+):\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1]?.trim();
      const value = kv[2]?.trim().replace(/^['"]|['"]$/g, '');

      switch (key) {
        case 'name': name = value ?? id; break;
        case 'description': description = value ?? ''; break;
        case 'emoji': emoji = value; break;
        case 'always': metadata.always = value === 'true'; break;
        case 'user-invocable': metadata.userInvocable = value !== 'false'; break;
        case 'disable-model-invocation': metadata.disableModelInvocation = value === 'true'; break;
        case 'command-tool': metadata.commandTool = value; break;
        case 'priority': metadata.priority = parseInt(value ?? '0', 10); break;
      }
    }

    // Parse os restriction
    const osMatch = frontmatter.match(/os:\s*\[([^\]]+)\]/);
    if (osMatch) {
      metadata.os = osMatch[1]?.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) ?? [];
    }

    // Parse requires block
    const reqMatch = frontmatter.match(/requires:\s*\n((?:\s+.+\n)*)/);
    if (reqMatch) {
      const reqBlock = reqMatch[1] ?? '';
      const binsMatch = reqBlock.match(/bins:\s*\[([^\]]+)\]/);
      const anyBinsMatch = reqBlock.match(/anyBins:\s*\[([^\]]+)\]/);
      const toolsMatch = reqBlock.match(/tools:\s*\[([^\]]+)\]/);
      const envMatch = reqBlock.match(/env:\s*\[([^\]]+)\]/);

      requires = {};
      if (binsMatch) {
        requires.bins = binsMatch[1]?.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) ?? [];
        metadata.requiresBins = requires.bins;
      }
      if (anyBinsMatch) {
        metadata.requiresAnyBins = anyBinsMatch[1]?.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) ?? [];
      }
      if (toolsMatch) {
        requires.tools = toolsMatch[1]?.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) ?? [];
      }
      if (envMatch) {
        metadata.requiresEnv = envMatch[1]?.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) ?? [];
      }
    }

    // Parse env block
    const envMatch = frontmatter.match(/env:\s*\n((?:\s+.+\n)*)/);
    if (envMatch) {
      const envBlock = envMatch[1] ?? '';
      const envVars: Record<string, string> = {};
      for (const envLine of envBlock.split('\n')) {
        const ekv = envLine.match(/^\s+(\w+):\s*(.+)$/);
        if (ekv && ekv[1] && ekv[2]) {
          envVars[ekv[1]] = ekv[2].trim().replace(/^['"]|['"]$/g, '');
        }
      }
      if (Object.keys(envVars).length > 0) {
        metadata.env = envVars;
      }
    }
  }

  // If no description from frontmatter, grab first paragraph
  if (!description) {
    const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();
    const afterHeading = body.replace(/^#[^\n]+\n+/, '');
    const firstParagraph = afterHeading.split('\n\n')[0]?.trim() ?? '';
    description = firstParagraph.slice(0, 200);
  }

  // Calculate token cost estimate (OpenClaw formula)
  // Base: 97 + len(name) + len(description) + len(path)
  const tokenCost = 97 + name.length + description.length + path.length;

  return {
    id,
    name,
    description,
    path,
    emoji,
    requires,
    baseDir,
    metadata,
    eligible: true, // Will be checked by gating
    tokenCost,
  };
}

// ─── Gating ───────────────────────────────────────────────────────────

/**
 * Check if a skill passes all gating requirements.
 * Based on OpenClaw's metadata.openclaw gating system.
 */
function checkGating(
  skill: EnhancedSkillDefinition,
  availableTools?: string[],
): boolean {
  const meta = skill.metadata;
  if (!meta) return true;

  // Always-on skills skip all gates
  if (meta.always) return true;

  // OS check
  if (meta.os && meta.os.length > 0) {
    const currentOs = platform();
    if (!meta.os.includes(currentOs)) {
      log.info(`Skill ${skill.id} skipped: OS ${currentOs} not in ${meta.os.join(',')}`);
      return false;
    }
  }

  // Required binaries (ALL must exist)
  if (meta.requiresBins && meta.requiresBins.length > 0) {
    for (const bin of meta.requiresBins) {
      if (!binaryExists(bin)) {
        log.info(`Skill ${skill.id} skipped: binary '${bin}' not found`);
        return false;
      }
    }
  }

  // Any-of binaries (at least ONE must exist)
  if (meta.requiresAnyBins && meta.requiresAnyBins.length > 0) {
    const anyFound = meta.requiresAnyBins.some(bin => binaryExists(bin));
    if (!anyFound) {
      log.info(`Skill ${skill.id} skipped: none of [${meta.requiresAnyBins.join(',')}] found`);
      return false;
    }
  }

  // Required environment variables
  if (meta.requiresEnv && meta.requiresEnv.length > 0) {
    for (const envVar of meta.requiresEnv) {
      if (!process.env[envVar]) {
        log.info(`Skill ${skill.id} skipped: env var '${envVar}' not set`);
        return false;
      }
    }
  }

  // Required tools
  if (skill.requires?.tools && skill.requires.tools.length > 0 && availableTools) {
    for (const tool of skill.requires.tools) {
      if (!availableTools.includes(tool)) {
        log.info(`Skill ${skill.id} skipped: tool '${tool}' not available`);
        return false;
      }
    }
  }

  return true;
}

/**
 * Check if a binary exists on PATH.
 * Caches results for performance.
 */
const MAX_BIN_CACHE_SIZE = 200;
const _binCache = new Map<string, boolean>();
/** Allowed chars for binary names to prevent command injection */
const SAFE_BIN_NAME = /^[a-zA-Z0-9._-]+$/;
function binaryExists(name: string): boolean {
  if (_binCache.has(name)) return _binCache.get(name)!;

  // Evict oldest entries if cache is too large
  if (_binCache.size >= MAX_BIN_CACHE_SIZE) {
    const firstKey = _binCache.keys().next().value;
    if (firstKey !== undefined) _binCache.delete(firstKey);
  }

  // Validate binary name to prevent command injection
  if (!SAFE_BIN_NAME.test(name)) {
    log.warn(`Rejected unsafe binary name: ${name}`);
    _binCache.set(name, false);
    return false;
  }

  try {
    const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(cmd, { stdio: 'pipe', timeout: 3000 });
    _binCache.set(name, true);
    return true;
  } catch {
    _binCache.set(name, false);
    return false;
  }
}

// ─── Environment Injection ────────────────────────────────────────────

/**
 * Inject skill environment variables for the duration of a function call.
 * Restores original values after execution (OpenClaw per-run env pattern).
 */
/** Env vars that skills are never allowed to override */
const BLOCKED_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM',
  'OPENAI_API_KEY', 'JARVIS_AUTH_TOKEN',
  'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
]);

export async function withSkillEnvironment<T>(
  skill: EnhancedSkillDefinition,
  fn: () => T | Promise<T>,
): Promise<T> {
  const envOverrides = skill.metadata?.env;
  if (!envOverrides || Object.keys(envOverrides).length === 0) {
    return fn();
  }

  // Filter out blocked env vars
  const safeOverrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    if (BLOCKED_ENV_KEYS.has(key)) {
      log.warn(`Skill ${skill.id} tried to override blocked env var: ${key}`);
      continue;
    }
    safeOverrides[key] = value;
  }

  if (Object.keys(safeOverrides).length === 0) {
    return fn();
  }

  // Save original values
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(safeOverrides)) {
    saved[key] = process.env[key];
  }

  // Inject overrides (with {baseDir} token resolution)
  for (const [key, value] of Object.entries(safeOverrides)) {
    process.env[key] = value.replace(/\{baseDir\}/g, skill.baseDir);
  }

  try {
    return await fn();
  } finally {
    // Restore originals
    for (const [key, original] of Object.entries(saved)) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

// ─── Hot-Reload Watcher ───────────────────────────────────────────────

function setupWatcher(
  dirs: string[],
  debounceMs: number,
  config: SkillLoaderConfig,
): void {
  // Clean up any existing watchers before creating new ones
  stopSkillWatcher();

  // Only watch existing directories
  const watchableDirs = dirs.filter(d => existsSync(d));
  if (watchableDirs.length === 0) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  for (const dir of watchableDirs) {
    try {
      const w = watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename?.endsWith('SKILL.md')) return;

        // Debounce reload
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          log.info(`Skill file changed: ${filename} — reloading skills...`);
          _binCache.clear(); // Clear binary cache on reload
          loadSkillsEnhanced(config);
        }, debounceMs);
      });

      _watchers.push(w);
    } catch (err) {
      log.warn(`Could not watch directory ${dir}: ${(err as Error).message}`);
    }
  }

  log.info(`Skill watcher active on ${watchableDirs.length} director${watchableDirs.length === 1 ? 'y' : 'ies'} (debounce: ${debounceMs}ms)`);
}

// ─── Prompt Building ──────────────────────────────────────────────────

/**
 * Build the skills section for the system prompt.
 * Lists available skills so the agent knows what SKILL.md files exist.
 */
export function buildSkillsPromptSection(skills: SkillDefinition[]): string {
  if (skills.length === 0) return '';

  // Base overhead: 195 chars for the header section
  const lines = [
    '## Available Skills',
    '',
    'Before replying, scan this list of available skills:',
    '- If exactly one skill clearly applies to the task: read its SKILL.md at the path shown',
    '- If multiple could apply: choose the most specific one',
    '- If none apply: do not read any SKILL.md, just proceed normally',
    '',
  ];

  for (const skill of skills) {
    const emoji = skill.emoji ? `${skill.emoji} ` : '';
    lines.push(`- **${emoji}${skill.name}** — ${skill.description}`);
    lines.push(`  Path: \`${skill.path}\``);
  }

  return lines.join('\n');
}
