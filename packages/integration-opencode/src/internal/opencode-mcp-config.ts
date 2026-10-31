import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Reading and writing the `mcp` key of `opencode.json`, OpenCode's MCP config.
 *
 * Like pi's `mcp-config.ts`, Morse edits the file directly: OpenCode keeps every
 * setting — agents, providers, models *and* MCP servers — in one JSON file, so a
 * mutation may only touch the `mcp` key and must preserve the rest byte-for-byte
 * in meaning. OpenCode picks config up when a session starts; there is no CLI to
 * shell out to and no live status to ask for.
 *
 * OpenCode has no pi-style partial overrides: an entry *is* the server, and the
 * project file's entry replaces a same-named global one outright.
 */

/** One `mcp` entry, as OpenCode stores it. Unknown fields are preserved. */
export interface OpenCodeMcpServer {
  type: 'local' | 'remote';
  /** `local`: argv, not a shell string — OpenCode runs it directly. */
  command?: string[];
  /** `local`: OpenCode spells env `environment`. */
  environment?: Record<string, string>;
  cwd?: string;
  /** `remote`: the server URL. */
  url?: string;
  headers?: Record<string, string>;
  /** Absent means enabled, so `true` is dropped rather than stored. */
  enabled?: boolean;
  [key: string]: unknown;
}

/** Where an edit lands: the user file (every project) or this project's file. */
export type McpConfigScope = 'global' | 'project';

interface OpenCodeFile {
  mcp?: Record<string, OpenCodeMcpServer>;
  [key: string]: unknown;
}

/** Server names Morse accepts for OpenCode too: letters, digits, `_` and `-`. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

/**
 * The parsed file, or an empty one when it does not exist yet. A malformed file
 * or a `mcp` key that is not an object is an error naming the path.
 */
export function readOpenCodeFile(path: string): OpenCodeFile {
  if (!existsSync(path)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object.`);
  }
  const mcp = (parsed as { mcp?: unknown }).mcp;
  if (mcp !== undefined && (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp))) {
    throw new Error(`${path}: "mcp" must be an object.`);
  }
  return parsed as OpenCodeFile;
}

export function writeOpenCodeFile(path: string, file: OpenCodeFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/**
 * Whether an entry defines a server. OpenCode entries always carry `type`; an
 * entry without it is a hand-edit this module refuses to guess about.
 */
export function definesMcpServer(entry: OpenCodeMcpServer | undefined): boolean {
  return entry !== undefined && (entry.type === 'local' || entry.type === 'remote');
}

/**
 * The entries of one file, validated per server. A malformed *entry* is an
 * error naming the file and server, so format drift shows up as an actionable
 * message rather than a server silently missing.
 */
export function readMcpServers(path: string): Record<string, OpenCodeMcpServer> {
  const { mcp } = readOpenCodeFile(path);
  const servers = mcp ?? {};
  for (const [name, entry] of Object.entries(servers)) {
    validateEntry(path, name, entry);
  }
  return servers;
}

function validateEntry(path: string, name: string, entry: OpenCodeMcpServer): void {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${path}: MCP server "${name}" is not an object.`);
  }
  if (entry.type === 'local') {
    if (
      !Array.isArray(entry.command) ||
      entry.command.length === 0 ||
      !entry.command.every((part) => typeof part === 'string' && part.length > 0)
    ) {
      throw new Error(`${path}: local MCP server "${name}" needs a non-empty "command" array.`);
    }
  } else if (entry.type === 'remote') {
    if (typeof entry.url !== 'string' || entry.url.trim().length === 0) {
      throw new Error(`${path}: remote MCP server "${name}" needs a "url".`);
    }
  } else {
    throw new Error(`${path}: MCP server "${name}" needs "type" of "local" or "remote".`);
  }
}

/**
 * The servers deciding this directory: the project file's entries over the
 * global file's, by name — matching OpenCode's own precedence. Each result
 * reports the file that defines it.
 */
export function effectiveServers(
  paths: string[],
): { name: string; server: OpenCodeMcpServer; source: string }[] {
  const byName = new Map<string, { server: OpenCodeMcpServer; source: string }>();
  // Paths are precedence-ordered: the first file defining a name wins.
  for (const path of paths) {
    for (const [name, server] of Object.entries(readMcpServers(path))) {
      if (!byName.has(name)) {
        byName.set(name, { server, source: path });
      }
    }
  }
  return [...byName].map(([name, { server, source }]) => ({ name, server, source }));
}

/** Add or replace one entry, keeping every other entry and top-level key. */
export function upsertMcpServer(
  path: string,
  name: string,
  config: OpenCodeMcpServer,
): void {
  if (!isValidMcpServerName(name)) {
    throw new Error(`"${name}" is not a valid MCP server name (letters, digits, "_" and "-").`);
  }
  validateEntry(path, name, config);
  const file = readOpenCodeFile(path);
  file.mcp = { ...(file.mcp ?? {}), [name]: config };
  writeOpenCodeFile(path, file);
}

/** Delete one entry. Returns false when the file did not define it. */
export function removeMcpServer(path: string, name: string): boolean {
  const file = readOpenCodeFile(path);
  if (file.mcp === undefined || !(name in file.mcp)) {
    return false;
  }
  const { [name]: _removed, ...rest } = file.mcp;
  if (Object.keys(rest).length === 0) {
    delete file.mcp;
  } else {
    file.mcp = rest;
  }
  writeOpenCodeFile(path, file);
  return true;
}

/** Set (or clear) one entry's `enabled`. Returns false when the file did not define it. */
export function setMcpServerEnabled(path: string, name: string, enabled: boolean): boolean {
  const file = readOpenCodeFile(path);
  const server = file.mcp?.[name];
  if (server === undefined) {
    return false;
  }
  // `enabled: true` is the default, so the key is dropped rather than stored.
  if (enabled) {
    delete server.enabled;
  } else {
    server.enabled = false;
  }
  writeOpenCodeFile(path, file);
  return true;
}

/**
 * A fingerprint of the config files that decide this directory's servers: the
 * project file when there is one, then the global one. Cheap enough to poll
 * (two `stat`s), and it moves whenever a server is added, removed, toggled or
 * hand-edited — which is what the host's watcher needs.
 */
export function configSignature(paths: string[]): string {
  return paths
    .map((path) => {
      try {
        const info = statSync(path);
        return `${info.size}:${info.mtimeMs}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

/** The paths that decide a directory's servers: project first, then global. */
export function openCodeConfigPaths(cwd: string | undefined, configDir?: string): string[] {
  const paths = [join(configDir ?? defaultConfigDir(), 'opencode.json')];
  if (cwd !== undefined && cwd.length > 0) {
    paths.unshift(join(cwd, 'opencode.json'));
  }
  return paths;
}

function defaultConfigDir(): string {
  // OpenCode is XDG-aware; Morse follows the same resolution.
  const xdg = process.env['XDG_CONFIG_HOME'];
  return xdg !== undefined && xdg.length > 0 ? join(xdg, 'opencode') : join(homedir(), '.config', 'opencode');
}
