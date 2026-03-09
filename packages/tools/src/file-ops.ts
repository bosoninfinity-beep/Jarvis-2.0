import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { getAuditLogger } from '@jarvis/shared';
import type { AgentTool, ToolContext, ToolResult } from './base.js';
import { createToolResult, createErrorResult } from './base.js';

const MAX_FILE_SIZE = 1_000_000; // 1MB read limit
const MAX_LINES = 5000;

const ALLOWED_ROOTS = [
  process.env['HOME'] || '/Users/jarvis',
  '/tmp',
  '/var/tmp',
  process.env['NAS_MOUNT_PATH'] || '/Volumes/Public/jarvis-nas',
];

const BLOCKED_PATHS = [
  '/.ssh/',
  '/.gnupg/',
  '/.config/gh/',
  '/.aws/',
  '/.azure/',
  '/etc/shadow',
  '/etc/passwd',
  '/etc/sudoers',
  '/.env',
];

const BLOCKED_WRITE_PATHS = [
  '/node_modules/',
  '/.git/',
  '/package.json',
  '/package-lock.json',
  '/pnpm-lock.yaml',
];

// ------- READ TOOL -------
export class ReadTool implements AgentTool {
  definition = {
    name: 'read',
    description: 'Read the contents of a file. Returns the file content with line numbers. For large files, use offset and limit to read specific sections.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read (absolute or relative to workspace)' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['path'],
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const rawPath = params['path'] as string;
    if (!rawPath) return createErrorResult('Missing required parameter: path');

    const filePath = resolvePath(rawPath, context);
    const offset = (params['offset'] as number) ?? 1;
    const limit = (params['limit'] as number) ?? MAX_LINES;

    try {
      const stats = await stat(filePath);
      if (stats.isDirectory()) {
        return createErrorResult(`Path is a directory, not a file: ${rawPath}. Use ls command via exec tool.`);
      }
      if (stats.size > MAX_FILE_SIZE) {
        return createErrorResult(`File too large (${(stats.size / 1024).toFixed(0)}KB). Use offset/limit to read specific sections.`);
      }

      const content = await readFile(filePath, 'utf-8');
      const allLines = content.split('\n');
      const startIdx = Math.max(0, offset - 1);
      const endIdx = Math.min(allLines.length, startIdx + limit);
      const lines = allLines.slice(startIdx, endIdx);

      const numbered = lines.map((line, i) => `${String(startIdx + i + 1).padStart(6)} | ${line}`).join('\n');
      const header = `File: ${rawPath} (${allLines.length} lines total, showing ${startIdx + 1}-${endIdx})`;

      getAuditLogger().logEvent('file.read', 'file-ops', { path: rawPath, lines: allLines.length });
      return createToolResult(`${header}\n${numbered}`);
    } catch (err) {
      return createErrorResult(`Failed to read file: ${(err as Error).message}`);
    }
  }
}

// ------- WRITE TOOL -------
export class WriteTool implements AgentTool {
  definition = {
    name: 'write',
    description: 'Write content to a file, creating it if it does not exist. Creates parent directories automatically.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to write to (absolute or relative to workspace)' },
        content: { type: 'string', description: 'The full content to write to the file' },
      },
      required: ['path', 'content'],
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const rawPath = params['path'] as string;
    const content = params['content'] as string;
    if (!rawPath) return createErrorResult('Missing required parameter: path');
    if (content === undefined) return createErrorResult('Missing required parameter: content');

    const filePath = resolvePath(rawPath, context, 'write');

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf-8');
      const lines = content.split('\n').length;
      getAuditLogger().logEvent('file.write', 'file-ops', { path: rawPath, lines });
      return createToolResult(`Wrote ${lines} lines to ${rawPath}`);
    } catch (err) {
      return createErrorResult(`Failed to write file: ${(err as Error).message}`);
    }
  }
}

// ------- EDIT TOOL -------
export class EditTool implements AgentTool {
  definition = {
    name: 'edit',
    description: 'Edit a file by replacing a specific string with new content. The old_string must be unique within the file. For inserting at the start, use an empty old_string.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit' },
        old_string: { type: 'string', description: 'The exact string to find and replace (must be unique in file)' },
        new_string: { type: 'string', description: 'The replacement string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const rawPath = params['path'] as string;
    const oldString = params['old_string'] as string;
    const newString = params['new_string'] as string;
    if (!rawPath) return createErrorResult('Missing required parameter: path');

    const filePath = resolvePath(rawPath, context, 'write');

    try {
      const content = await readFile(filePath, 'utf-8');

      // Insert at beginning if old_string is empty
      if (!oldString) {
        await writeFile(filePath, newString + content, 'utf-8');
        return createToolResult(`Inserted content at the beginning of ${rawPath}`);
      }

      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        return createErrorResult(`String not found in file: ${oldString.slice(0, 80)}`);
      }
      if (occurrences > 1) {
        return createErrorResult(`String appears ${occurrences} times in file — provide more context to make it unique.`);
      }

      const newContent = content.replace(oldString, newString);
      await writeFile(filePath, newContent, 'utf-8');
      return createToolResult(`Edited ${rawPath}: replaced 1 occurrence`);
    } catch (err) {
      return createErrorResult(`Failed to edit file: ${(err as Error).message}`);
    }
  }
}

// ------- LIST TOOL -------
export class ListTool implements AgentTool {
  definition = {
    name: 'list',
    description: 'List directory contents. Returns file/directory names with type indicators and sizes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list (defaults to workspace root)' },
        recursive: { type: 'boolean', description: 'List recursively (max 3 levels, default false)' },
      },
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const rawPath = (params['path'] as string) || '.';
    const recursive = params['recursive'] as boolean ?? false;
    const dirPath = resolvePath(rawPath, context);

    try {
      const entries = await listDir(dirPath, recursive ? 3 : 1, '');
      if (entries.length === 0) return createToolResult(`Directory is empty: ${rawPath}`);
      return createToolResult(`Directory: ${rawPath}\n${entries.join('\n')}`);
    } catch (err) {
      return createErrorResult(`Failed to list directory: ${(err as Error).message}`);
    }
  }
}

async function listDir(dir: string, maxDepth: number, prefix: string): Promise<string[]> {
  if (maxDepth <= 0) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue; // Skip hidden
    if (entry.name === 'node_modules' || entry.name === '.git') continue;

    if (entry.isDirectory()) {
      results.push(`${prefix}${entry.name}/`);
      if (maxDepth > 1) {
        const sub = await listDir(join(dir, entry.name), maxDepth - 1, `${prefix}  `);
        results.push(...sub);
      }
    } else {
      const s = await stat(join(dir, entry.name));
      const size = formatSize(s.size);
      results.push(`${prefix}${entry.name}  (${size})`);
    }
  }

  return results;
}

// ------- SEARCH TOOL -------
export class SearchTool implements AgentTool {
  definition = {
    name: 'search',
    description: 'Search for a pattern in files. Returns matching lines with file paths and line numbers. Supports regex patterns.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search in (defaults to workspace)' },
        glob: { type: 'string', description: 'File glob pattern to filter (e.g. "*.ts", "*.py")' },
        max_results: { type: 'number', description: 'Maximum results to return (default: 50)' },
      },
      required: ['pattern'],
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = params['pattern'] as string;
    if (!pattern) return createErrorResult('Missing required parameter: pattern');

    const rawPath = (params['path'] as string) || '.';
    const glob = params['glob'] as string | undefined;
    const maxResults = (params['max_results'] as number) || 50;
    const searchPath = resolvePath(rawPath, context);

    try {
      const regex = new RegExp(pattern, 'gi');
      const results: string[] = [];
      await searchFiles(searchPath, regex, glob, results, maxResults, context.workspacePath);

      if (results.length === 0) return createToolResult(`No matches found for: ${pattern}`);
      return createToolResult(`Found ${results.length} matches for: ${pattern}\n\n${results.join('\n')}`);
    } catch (err) {
      return createErrorResult(`Search failed: ${(err as Error).message}`);
    }
  }
}

async function searchFiles(
  dir: string,
  pattern: RegExp,
  glob: string | undefined,
  results: string[],
  maxResults: number,
  rootDir: string,
): Promise<void> {
  if (results.length >= maxResults) return;

  const s = await stat(dir);
  if (s.isFile()) {
    await searchInFile(dir, pattern, results, maxResults, rootDir);
    return;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= maxResults) return;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await searchFiles(fullPath, pattern, glob, results, maxResults, rootDir);
    } else if (!glob || matchGlob(entry.name, glob)) {
      await searchInFile(fullPath, pattern, results, maxResults, rootDir);
    }
  }
}

async function searchInFile(
  filePath: string,
  pattern: RegExp,
  results: string[],
  maxResults: number,
  rootDir: string,
): Promise<void> {
  try {
    const s = await stat(filePath);
    if (s.size > MAX_FILE_SIZE) return;

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const relPath = relative(rootDir, filePath);

    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      if (pattern.test(lines[i]!)) {
        results.push(`${relPath}:${i + 1}: ${lines[i]!.trim()}`);
      }
    }
  } catch {
    // Skip unreadable files
  }
}

function matchGlob(filename: string, glob: string): boolean {
  const pattern = glob.replace(/\./g, '\\.').replace(/\*/g, '.*');
  return new RegExp(`^${pattern}$`).test(filename);
}

// ------- Helpers -------
function resolvePath(rawPath: string, context: ToolContext, operation: 'read' | 'write' = 'read'): string {
  const resolved = rawPath.startsWith('/')
    ? resolve(rawPath)
    : resolve(context.cwd || context.workspacePath, rawPath);

  // Resolve symlinks to prevent jail escape
  let realPath: string;
  let fileExists = false;
  try {
    realPath = realpathSync(resolved);
    fileExists = true;
  } catch {
    // File doesn't exist yet (write operation) - use resolved path
    realPath = resolved;
  }

  // Check against blocked paths
  for (const blocked of BLOCKED_PATHS) {
    if (realPath.includes(blocked)) {
      getAuditLogger().logEvent('security.blocked_path', 'file-ops', {
        path: rawPath,
        resolved: realPath,
        blocked,
        operation,
      });
      throw new Error(`Access denied: path contains blocked segment '${blocked}'`);
    }
  }

  // Check write-specific blocks
  if (operation === 'write') {
    for (const blocked of BLOCKED_WRITE_PATHS) {
      if (realPath.includes(blocked)) {
        throw new Error(`Write denied: path contains protected segment '${blocked}'`);
      }
    }
  }

  // Verify path is within allowed roots
  const isAllowed = ALLOWED_ROOTS.some(root => realPath.startsWith(resolve(root)));
  if (!isAllowed) {
    getAuditLogger().logEvent('security.blocked_path', 'file-ops', {
      path: rawPath,
      resolved: realPath,
      reason: 'outside allowed roots',
      operation,
    });
    throw new Error(`Access denied: path '${rawPath}' is outside allowed directories`);
  }

  // Return the fully resolved real path (post-symlink) when the file exists,
  // so subsequent file operations cannot follow a symlink to escape the jail.
  return fileExists ? realPath : resolved;
}

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes}B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)}KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)}MB`;
}
