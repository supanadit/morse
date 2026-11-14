import { existsSync, readFileSync } from 'node:fs';

/**
 * One `opencode.json` document, read as plain JSON.
 *
 * OpenCode keeps everything — agents, providers, models *and* MCP servers — in
 * one file, so the writers that only own part of it hand a whole document
 * through this reader instead of reaching for `JSON.parse` each time. The
 * layout and the MCP store go through the engine instead; this is what is left
 * for the bot writers whose sections no store owns yet.
 */

/** A parsed document. Keys Morse does not know are carried through as read. */
export type OpenCodeFile = Record<string, unknown>;

/**
 * The parsed file, or an empty one when it does not exist yet. A malformed file,
 * a root that is not an object, or an `mcp` key that is not an object is an
 * error naming the path: a writer must never replace data it cannot represent.
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
