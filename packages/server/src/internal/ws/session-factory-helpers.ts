/**
 * The WebSocket session factory's pure helpers: engine extras resolution, command
 * arguments and the loopback guard on host updates.
 */
import {
  UnsupportedByHostError,
  type AgentExtras,
  type AgentRouter,
} from '@morse/system';

/**
 * The MCP port of the engine a command names, or the default engine's when it
 * names none. A named engine without MCP administration is a refusal naming the
 * engine — the one rule that keeps pi's and OpenCode's servers from mixing.
 * Exported for tests; constructing the factory needs the whole host.
 */
export function resolveMcpExtras(
  router: Pick<AgentRouter, 'extrasFor' | 'defaultExtras'>,
  engine: unknown,
): NonNullable<AgentExtras['mcp']> {
  return resolveEngineExtras(router, engine, 'mcp', 'MCP administration');
}

/**
 * The prompt-template port of the engine a command names, resolved by the same
 * rule set as the MCP side.
 */
export function resolvePromptExtras(
  router: Pick<AgentRouter, 'extrasFor' | 'defaultExtras'>,
  engine: unknown,
): NonNullable<AgentExtras['prompts']> {
  return resolveEngineExtras(router, engine, 'prompts', 'prompt templates');
}

/**
 * The config-Fix port of the engine a command names, or the default engine's.
 * Same rule as the MCP and prompt ports: an engine that cannot fix its own
 * config is a refusal, never another engine's repair.
 */
export function resolveFixExtras(
  router: Pick<AgentRouter, 'extrasFor' | 'defaultExtras'>,
  engine: unknown,
): NonNullable<AgentExtras['fix']> {
  return resolveEngineExtras(router, engine, 'fix', 'config Fix action');
}

/**
 * The extras port named by `key`, of the engine the command names, or the
 * default engine's when it names none. A named engine without that port is a
 * refusal naming the engine — the one rule that keeps the engines from mixing.
 */
function resolveEngineExtras<K extends 'mcp' | 'prompts' | 'fix'>(
  router: Pick<AgentRouter, 'extrasFor' | 'defaultExtras'>,
  engine: unknown,
  key: K,
  label: string,
): NonNullable<AgentExtras[K]> {
  const kind = typeof engine === 'string' && engine.length > 0 ? engine : undefined;
  const extras = kind === undefined ? router.defaultExtras() : router.extrasFor(kind);
  const port = extras?.[key];
  if (port === undefined) {
    throw new UnsupportedByHostError(
      kind === undefined
        ? `The selected agent engine has no ${label}.`
        : `The ${kind} engine has no ${label}.`,
    );
  }
  return port;
}

/** The `paths` argument of a `gitStage`/`gitUnstage` command, with bad entries dropped. */
export function gitPaths(args: Record<string, unknown> | undefined): string[] {
  const paths = args?.paths;
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths.filter((path): path is string => typeof path === 'string' && path.length > 0);
}

/**
 * The `repo` argument of a git command: the session-relative path of the nested
 * repository it targets. Absent (or empty) is the session directory's own
 * repository, which is what every command meant before the panel listed more
 * than one. The host resolves it inside the session directory with the same
 * guard `readFile` uses, so a client cannot name a repository outside the project.
 */
export function repoArg(args: Record<string, unknown> | undefined): string | undefined {
  const repo = args?.['repo'];
  return typeof repo === 'string' && repo.length > 0 ? repo : undefined;
}


/**
 * Whether an address is on this machine. `updateHost` runs a global install, so
 * it must never answer anyone but the person sitting at the host: a `--lan`
 * server exposes the UI with no auth, and `::ffff:127.0.0.1` is how a
 * dual-stack socket spells IPv4 loopback. An address we cannot see is refused.
 *
 * Exported for its spec: it is the only thing between the browser UI and a
 * remote `npm install -g`, so it is tested on its own rather than through a host.
 */
export function isLoopback(address: string | undefined): boolean {
  if (address === undefined || address.length === 0) {
    return false;
  }
  // An IPv6-mapped IPv4 address (`::ffff:127.0.0.1`) or a bare IPv6 loopback.
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === 'localhost' ||
    normalized.startsWith('127.')
  );
}

/** The scope a mutation edits, when the panel named one. */

/** The scope a prompt-template mutation targets; only an explicit "project" moves off global. */
export function promptScope(args: Record<string, unknown> | undefined): 'global' | 'project' {
  return args?.scope === 'project' ? 'project' : 'global';
}
