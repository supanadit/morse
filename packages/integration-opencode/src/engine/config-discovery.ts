/**
 * Where OpenCode's one config file lives. OpenCode keeps everything — agents,
 * providers, models *and* MCP servers — in `opencode.json`, and it accepts a
 * comment-bearing `opencode.jsonc` too. A user tree reads the app-level file
 * OpenCode reads for every project; a project tree walks up from the workspace
 * so a repository-level file can decide every package under it.
 *
 * Reads are limited to the files that exist, in precedence order, so a listing
 * never consults a path that cannot have content; the write target is the
 * nearest existing file, and only a tree with no config at all gets a new
 * `opencode.json`.
 */
import { existsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

import type { ConfigPaths, EngineContext } from '@morse/engine-config';

/** The one config file id OpenCode has: everything lives in `opencode.json`. */
export const OPEN_CODE_CONFIG_FILE_ID = 'config';

/** A project's shared config directory, next to its `opencode.json`. */
const PROJECT_DIR = '.opencode';

/** One directory's config file names, highest precedence first. */
const FILE_NAMES = ['opencode.jsonc', 'opencode.json'] as const;

/** The plain-JSON name: what a tree with no config gets on its first write. */
const JSON_FILE = 'opencode.json';

/**
 * The app-level config directory: an isolated tree's own `<root>/opencode`, the
 * directory a caller injected, or the XDG-resolved `<config home>/opencode`.
 */
export function openCodeConfigDir(context: EngineContext, configDir?: string): string {
  if (context.ownership === 'isolated') {
    if (context.root === undefined) {
      throw new Error('An isolated OpenCode instance needs a root directory.');
    }
    return join(context.root, 'opencode');
  }
  return configDir ?? join(context.xdgConfigHome, 'opencode');
}

/**
 * Every project config path that decides `cwd`, nearest directory first, whether
 * or not it exists. A directory's own files come before its `.opencode` block,
 * and a `jsonc` before the `json` beside it.
 */
export function projectConfigCandidates(cwd: string): string[] {
  const candidates: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const name of FILE_NAMES) {
      candidates.push(join(dir, name));
    }
    for (const name of FILE_NAMES) {
      candidates.push(join(dir, PROJECT_DIR, name));
    }
    // The root is its own parent; nothing above it can hold a project file.
    if (parse(dir).root === dir) {
      break;
    }
  }
  return candidates;
}

/**
 * The user-level file alone (an isolated tree's only file): the `jsonc` first
 * when it exists, and the write target OpenCode already reads, else a new
 * `opencode.json`.
 */
export function discoverOpenCodeGlobalPaths(
  context: EngineContext,
  configDir?: string,
): ConfigPaths {
  const dir = openCodeConfigDir(context, configDir);
  const existing = FILE_NAMES.map((name) => join(dir, name)).filter((path) => existsSync(path));
  if (existing.length === 0) {
    const write = join(dir, JSON_FILE);
    return { read: [write], write };
  }
  return { read: existing, write: existing[0]! };
}

/**
 * The whole chain for file id `config`: the project files that exist, nearest
 * first, then the user file (or the isolated root's file) last. `write` is the
 * nearest existing project file — so an edit lands where OpenCode already reads
 * — else a new `<cwd>/opencode.json`.
 *
 * `cwd` overrides the context's own session directory, so a caller may resolve
 * another workspace's chain without rebuilding the instance.
 */
export function discoverOpenCodeConfigPaths(
  context: EngineContext,
  configDir?: string,
  cwd?: string,
): ConfigPaths {
  const global = discoverOpenCodeGlobalPaths(context, configDir);
  if (context.ownership === 'isolated') {
    return global;
  }
  const dir = cwd ?? context.cwd;
  if (dir === undefined || dir.trim().length === 0) {
    return global;
  }
  const existing = projectConfigCandidates(dir).filter((path) => existsSync(path));
  return {
    read: [...existing, ...global.read],
    write: existing[0] ?? join(dir, JSON_FILE),
  };
}
