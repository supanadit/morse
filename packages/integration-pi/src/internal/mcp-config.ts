import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Reading and writing `mcp.json`, the file pi and other MCP clients share.
 *
 * Morse edits the file directly instead of shelling out to `pi mcp add/remove`:
 * the CLI has no command for enabling or disabling a server, and the file format
 * is the contract every client already agrees on. `pi mcp list --json` is still
 * the source of truth for *connection state* (see `pi-mcp.ts`) — only the edits
 * happen here, and pi reports anything malformed on the next list.
 */

/** How a server's tools reach the model (pi's `McpExposure`). */
export type McpFileExposure = 'codemode' | 'deferred' | 'direct' | 'hidden';

/** Where an edit lands: the user file (every project) or this project's `.pi/mcp.json`. */
export type McpConfigScope = 'global' | 'project';

/** One `mcpServers` entry, as stored. All fields optional: some clients only pin `enabled`. */
export interface McpFileServer {
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  exposure?: McpFileExposure;
  description?: string;
  /** OAuth and per-tool exposure are preserved verbatim; Morse does not edit them. */
  [key: string]: unknown;
}

interface McpFile {
  mcpServers: Record<string, McpFileServer>;
  [key: string]: unknown;
}

/** Server names pi accepts: letters, digits, `_` and `-`. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

/** The parsed file, or an empty one when it does not exist yet. A malformed file is an error. */
export function readMcpFile(path: string): McpFile {
  if (!existsSync(path)) {
    return { mcpServers: {} };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object.`);
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
    throw new Error(`${path}: "mcpServers" must be an object.`);
  }
  return {
    ...(parsed as Record<string, unknown>),
    mcpServers: (servers as Record<string, McpFileServer> | undefined) ?? {},
  };
}

export function writeMcpFile(path: string, file: McpFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

export function findMcpServer(path: string, name: string): McpFileServer | undefined {
  return readMcpFile(path).mcpServers[name];
}

/**
 * Whether an entry defines a server, as opposed to a project *override* of a
 * user-level one. pi's rule: an entry without `command`, `url`, or `type` only
 * overrides `enabled`, `exposure` and `toolExposure`, and keeps the global
 * server's command, env, headers and auth.
 */
export function definesMcpServer(entry: McpFileServer | undefined): boolean {
  return (
    entry !== undefined &&
    (entry.command !== undefined || entry.url !== undefined || entry.type !== undefined)
  );
}

/**
 * Turn a user-level server on or off for one project only, by writing (or
 * clearing) a project override. Enabling removes the override's `enabled` — and
 * the entry itself when nothing else is overridden, since `enabled: true` is
 * the default pi restores.
 */
export function setMcpServerOverrideEnabled(
  path: string,
  name: string,
  enabled: boolean,
): void {
  const file = readMcpFile(path);
  const existing = file.mcpServers[name];
  if (enabled) {
    if (!existing) {
      return;
    }
    delete existing.enabled;
    if (Object.keys(existing).length === 0) {
      delete file.mcpServers[name];
    }
  } else {
    // Keep any other override keys (exposure, toolExposure) the user set.
    const entry = definesMcpServer(existing) ? {} : (existing ?? {});
    entry.enabled = false;
    file.mcpServers[name] = entry;
  }
  writeMcpFile(path, file);
}

/** Add or replace one entry, keeping every other entry and top-level key. */
export function upsertMcpServer(path: string, name: string, config: McpFileServer): void {
  if (!isValidMcpServerName(name)) {
    throw new Error(`"${name}" is not a valid MCP server name (letters, digits, "_" and "-").`);
  }
  const file = readMcpFile(path);
  file.mcpServers[name] = config;
  writeMcpFile(path, file);
}

/** Delete one entry. Returns false when the file did not define it. */
export function removeMcpServer(path: string, name: string): boolean {
  const file = readMcpFile(path);
  if (!(name in file.mcpServers)) {
    return false;
  }
  delete file.mcpServers[name];
  writeMcpFile(path, file);
  return true;
}

/** Set (or clear) one entry's `enabled`. Returns false when the file did not define it. */
export function setMcpServerEnabled(path: string, name: string, enabled: boolean): boolean {
  const file = readMcpFile(path);
  const server = file.mcpServers[name];
  if (!server) {
    return false;
  }
  // `enabled: true` is the default, so the key is dropped rather than stored.
  if (enabled) {
    delete server.enabled;
  } else {
    server.enabled = false;
  }
  writeMcpFile(path, file);
  return true;
}
