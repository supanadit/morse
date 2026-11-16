/**
 * Where OpenCode's one config file lives. OpenCode keeps everything — agents,
 * providers, models *and* MCP servers — in `opencode.json`, and it accepts a
 * comment-bearing `opencode.jsonc` too. A user tree reads the app-level file
 * OpenCode reads for every project; a project tree walks up from the workspace
 * so a repository-level file can decide every package under it.
 *
 * Reads are limited to the files that exist, in precedence order, so a listing
 * never consults a path that cannot have content; the write target is the first
 * existing file in that order (every `.opencode` config before every direct one,
 * a `jsonc` before the `json` beside it), and only a tree with no config at all
 * gets a new `opencode.json`.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

import type { ConfigPaths, EngineContext } from '@morse/engine-config';

/** The one config file id OpenCode has: everything lives in `opencode.json`. */
export const OPEN_CODE_CONFIG_FILE_ID = 'config';

/** A project's shared config directory, next to its `opencode.json`. */
const PROJECT_DIR = '.opencode';

/** One directory's config file names, highest precedence first. */
const FILE_NAMES = ['opencode.jsonc', 'opencode.json'] as const;

/** The plain-JSON name: what a tree with no config gets on its first write. */
export const OPEN_CODE_PROJECT_FILE = 'opencode.json';

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
 * Every project config path that decides `cwd`, nearest directory first,
 * whether or not it exists. Two passes: every `.opencode` config outranks every
 * direct one (OpenCode's own rule), and within one directory a `jsonc` before
 * the `json` beside it.
 */
export function projectConfigCandidates(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.push(dir);
    // The root is its own parent; nothing above it can hold a project file.
    if (parse(dir).root === dir) {
      break;
    }
  }
  const shared: string[] = [];
  for (const dir of dirs) {
    for (const name of FILE_NAMES) {
      shared.push(join(dir, PROJECT_DIR, name));
    }
  }
  const direct: string[] = [];
  for (const dir of dirs) {
    for (const name of FILE_NAMES) {
      direct.push(join(dir, name));
    }
  }
  return [...shared, ...direct];
}

/**
 * The app-level config candidates (both spellings), whether or not they exist.
 * The global scope is always derivable from the context alone; the project
 * scope is not, because it depends on a directory the context may not have.
 */
export function globalConfigCandidates(context: EngineContext, configDir?: string): string[] {
  const dir = openCodeConfigDir(context, configDir);
  return FILE_NAMES.map((name) => join(dir, name));
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
  const existing = globalConfigCandidates(context, configDir).filter((path) => existsSync(path));
  if (existing.length === 0) {
    const write = join(openCodeConfigDir(context, configDir), OPEN_CODE_PROJECT_FILE);
    return { read: [write], write };
  }
  return { read: existing, write: existing[0]! };
}

/**
 * Every config path that decides `cwd`, whether or not it exists: the project
 * candidates in precedence order, then the app-level candidates. An isolated
 * tree reads only its own app-level file, and a context with no directory has
 * no project scope at all — both cases stop at the global list.
 *
 * This is the list a fingerprint must walk: a file that does not exist yet is
 * still a candidate, so creating it has to change the fingerprint. `read` in
 * {@link discoverOpenCodeConfigPaths} filters this same list, so precedence is
 * defined once, here.
 */
export function openCodeConfigCandidates(
  context: EngineContext,
  configDir: string | undefined,
  cwd: string | undefined,
): string[] {
  const global = globalConfigCandidates(context, configDir);
  if (context.ownership === 'isolated') {
    return global;
  }
  const dir = cwd ?? context.cwd;
  if (dir === undefined || dir.trim().length === 0) {
    return global;
  }
  return [...projectConfigCandidates(dir), ...global];
}

/**
 * The whole chain for file id `config`: the project files that exist, in
 * OpenCode's own precedence (`cwd`-nearest first, every `.opencode` config
 * before every direct one), then the user file (or the isolated root's file)
 * last. `write` is the first existing project file in that order — so an edit
 * lands where OpenCode reads it from — else a new `<cwd>/opencode.json`.
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
  const dir = context.ownership === 'isolated' ? undefined : (cwd ?? context.cwd);
  if (dir === undefined || dir.trim().length === 0) {
    return global;
  }
  // Only the project half of the candidate list: this keeps `read` to files
  // that exist and `write` inside the project, exactly as before.
  const existing = projectConfigCandidates(dir).filter((path) => existsSync(path));
  return {
    read: [...existing, ...global.read],
    write: existing[0] ?? join(dir, OPEN_CODE_PROJECT_FILE),
  };
}

/**
 * A stable fingerprint of every config path `cwd` reads: one
 * `<path>:<mtimeMs>:<size>` line per candidate, in precedence order, and
 * `<path>:missing` for a candidate that is not there. Comparing two signatures
 * answers "did the config change?" without parsing or watching anything, so a
 * caller can reload the server only when it actually must.
 *
 * Missing candidates are part of the signature on purpose: creating the first
 * `opencode.json` in a workspace that had none is the change this guard exists
 * for, and its `missing` line becomes a real one.
 */
export function openCodeConfigSignature(
  context: EngineContext,
  configDir: string | undefined,
  cwd: string,
): string {
  const paths = openCodeConfigCandidates(context, configDir, cwd);
  return paths
    .map((path) => {
      try {
        const stats = statSync(path);
        return `${path}:${stats.mtimeMs}:${stats.size}`;
      } catch {
        return `${path}:missing`;
      }
    })
    .join('\n');
}
