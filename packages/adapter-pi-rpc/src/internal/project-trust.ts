import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * pi's project trust store, read and written the way pi does.
 *
 * pi records a decision in `<agentDir>/trust.json` as `{ "<cwd>": true }` and
 * resolves it by walking up from the directory, so a decision on a parent
 * folder covers every child. pi gates project `.pi/` resources (mcp.json,
 * settings, skills, prompts) on it, and Morse needs to both respect and — when
 * the reader asks through the panel — set it, instead of telling them to go run
 * pi in the project first.
 */

/** pi's agent config directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). */
export function resolveAgentDir(env: NodeJS.ProcessEnv | undefined): string {
  const configured = env?.PI_CODING_AGENT_DIR?.trim();
  return configured && configured.length > 0
    ? expandHome(configured)
    : join(homedir(), '.pi', 'agent');
}

export function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** pi's `canonicalizePath`: realpath when it exists, else the resolved path. */
function canonicalize(path: string): string {
  const resolved = resolve(expandHome(path));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Whether pi would load the project's resources for `cwd`. */
export function readProjectTrust(cwd: string, agentDir: string): boolean {
  const decisions = readTrustFile(trustFilePath(agentDir));
  let current = canonicalize(cwd);
  for (;;) {
    const decision = decisions[current];
    if (decision === true) {
      return true;
    }
    if (decision === false) {
      return false;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

export interface TrustResult {
  ok: boolean;
  /** The `trust.json` that was written, for the panel to name. */
  path: string;
  message?: string;
}

/**
 * Marks `cwd` trusted (pi's plain "Trust", not a parent or session-only choice).
 * Other decisions are preserved, keys are sorted like pi writes them, and the
 * file is replaced by rename so a concurrent reader never sees it half-written.
 */
export function writeProjectTrust(cwd: string, agentDir: string): TrustResult {
  const path = trustFilePath(agentDir);
  try {
    const decisions = readTrustFile(path);
    decisions[canonicalize(cwd)] = true;
    const sorted: Record<string, boolean | null> = {};
    for (const key of Object.keys(decisions).sort()) {
      sorted[key] = decisions[key]!;
    }
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.morse.tmp`;
    writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
    return { ok: true, path };
  } catch (error: unknown) {
    return {
      ok: false,
      path,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function trustFilePath(agentDir: string): string {
  return join(agentDir, 'trust.json');
}

/** The valid entries of the trust file; anything else is dropped, never thrown. */
function readTrustFile(path: string): Record<string, boolean | null> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const decisions: Record<string, boolean | null> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === true || value === false || value === null) {
        decisions[key] = value;
      }
    }
    return decisions;
  } catch {
    return {};
  }
}
