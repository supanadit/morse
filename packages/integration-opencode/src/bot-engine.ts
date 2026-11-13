import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentGatewayFactory } from '@morse/agent';
import { AgentUnavailableError, type BotEngineCapabilities, type MorseLogger } from '@morse/system';
import { OpenCodeEngine } from './opencode-engine.js';
import { OpenCodeMcp } from './opencode-mcp.js';
import { OpenCodePrompts } from './opencode-prompts.js';
import { connectOpenCode, type OpenCodeConnection } from './internal/connection.js';
import { readOpenCodeFile } from './internal/opencode-mcp-config.js';
import { OpenCodeApi } from './internal/client.js';
import { OpenCodeEventStream } from './internal/event-stream.js';

/**
 * OpenCode confined to one bot's directory.
 *
 * The isolation is environmental and covers three things:
 * - the spawned server's `XDG_CONFIG_HOME` (`<botRoot>/config`) and
 *   `XDG_DATA_HOME` (`<botRoot>/sessions`), which is where OpenCode reads and
 *   writes providers, agents, MCP servers, commands, sessions and auth;
 * - the MCP/command administration, pinned to the same config directory the
 *   server reads (`<botRoot>/config/opencode`), so an edit lands in the bot;
 * - credentials, written by Morse into the bot's data dir — never copied from
 *   the user's config.
 *
 * Unlike pi there is no process-per-session to point at a directory, so the
 * engine — one long-lived server — is created per bot and every session lives
 * inside it.
 *
 * The same config dir is handed to the engine's agents, so the composer's
 * command-template expansion reads the bot's own global commands instead of the
 * host's XDG ones: isolation holds on the read path too, not only for writes.
 */

/** A file holding API keys is readable by its owner only. */
const PRIVATE_FILE_MODE = 0o600;

/**
 * What the OpenCode engine offers a bot. Credentials are `'stored'`: the
 * wizard collects provider keys and Morse writes them into OpenCode's own
 * auth file inside the bot, so the user never has to export variables.
 */
export const OPENCODE_BOT_CAPABILITIES: BotEngineCapabilities = {
  supportsSubagents: true,
  supportsThinkingLevels: true,
  credentials: 'stored',
};

export interface BotOpenCodeEngineOptions {
  botRoot: string;
  /** The binary to spawn; defaults to `opencode` on `PATH`. */
  bin?: string;
  logger: MorseLogger;
}

/**
 * The environment a bot's OpenCode server gets.
 *
 * Both XDG roots are overridden, not appended to, on purpose: a host launched
 * from inside the user's own OpenCode session inherits that user's dirs, and a
 * bot inheriting them would read and write the user's providers, sessions and
 * auth. Everything else — `PATH` above all, which the spawn needs to find the
 * binary — is inherited unchanged. Because that inheritance is wholesale, an
 * `OPENCODE_*` config-path override already set by the host reaches the bot
 * too and would bypass the XDG redirects; that is an accepted MVP risk,
 * documented here rather than silently scrubbing the user's environment.
 */
export function botOpenCodeEnv(
  botRoot: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    XDG_CONFIG_HOME: join(botRoot, 'config'),
    XDG_DATA_HOME: join(botRoot, 'sessions'),
  };
}

/**
 * Creates the engine for a bot, spawning a private server under the bot's
 * environment.
 *
 * This deliberately does not go through `openOpenCodeEngine`: that helper
 * treats "not installed" as "this host has no OpenCode" and returns
 * `undefined`, which is right for host startup and wrong here — a bot asked
 * for an engine, so a failure must be reported, with the server's own stderr
 * (the connection layer captures it) and install remedy intact.
 */
export async function createBotOpenCodeEngine(
  options: BotOpenCodeEngineOptions,
): Promise<OpenCodeEngine> {
  const env = botOpenCodeEnv(options.botRoot);
  let connection: OpenCodeConnection;
  try {
    connection = await connectOpenCode({
      env,
      ...(options.bin === undefined ? {} : { bin: options.bin }),
    });
  } catch (error: unknown) {
    throw botUnavailable(options.bin, error);
  }
  const api = new OpenCodeApi(connection);
  const stream = new OpenCodeEventStream(connection, { logger: options.logger });
  // The same assembly as `createOpenCodeEngine`, with both administrations
  // pinned to the config directory the server itself reads: configDir is
  // OpenCode's own dir, i.e. the XDG *base* plus `opencode/` (the resolvers
  // join `opencode.json` and `commands/` off it). `botOpenCodeEnv` points
  // XDG_CONFIG_HOME at `<botRoot>/config`, so this is `<botRoot>/config/opencode`.
  const configDir = join(options.botRoot, 'config', 'opencode');
  return new OpenCodeEngine({
    connection,
    api,
    stream,
    logger: options.logger,
    mcp: new OpenCodeMcp({ configDir }),
    prompts: new OpenCodePrompts({ configDir }),
    configDir,
  });
}

/** Wraps a connect failure so a bot engine always fails as "agent unavailable". */
function botUnavailable(bin: string | undefined, error: unknown): AgentUnavailableError {
  // `connectOpenCode` already names the reason — and, for a server that died
  // or timed out, its captured stderr. Keep that text and the install remedy;
  // only add which engine failed to start.
  if (error instanceof AgentUnavailableError) {
    return new AgentUnavailableError(
      `Could not start this bot's OpenCode engine. ${error.message}`,
      {
        cause: error,
        ...(error.remedy === undefined ? {} : { remedy: error.remedy }),
      },
    );
  }
  return new AgentUnavailableError(
    `Could not start this bot's OpenCode engine${bin === undefined ? '' : ` (${bin})`}: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { cause: error },
  );
}

/**
 * Writes OpenCode's `auth.json` for a bot from the keys the wizard collected.
 *
 * OpenCode reads API keys from `$XDG_DATA_HOME/opencode/auth.json`, which for a
 * bot is `<botRoot>/sessions/opencode/auth.json` because `botOpenCodeEnv`
 * points `XDG_DATA_HOME` at `<botRoot>/sessions`. The file is rewritten whole
 * rather than merged: the wizard owns this bot's credentials, so a provider it
 * no longer lists must disappear instead of lingering with an old key. Mode
 * 0600 and the atomic write keep a secret from being world-readable or
 * half-written if the host dies mid-save. Nothing is read from the user's own
 * config — only what is passed in is written.
 */
export function writeOpenCodeCredentials(
  botRoot: string,
  entries: { provider: string; apiKey: string }[],
): void {
  const auth: Record<string, { type: 'api'; key: string }> = {};
  for (const entry of entries) {
    auth[entry.provider] = { type: 'api', key: entry.apiKey };
  }
  writePrivateJson(join(botRoot, 'sessions', 'opencode', 'auth.json'), auth);
}

/** Temp file beside the target, then rename: private from the moment it exists. */
function writePrivateJson(path: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temp, serialized, { mode: PRIVATE_FILE_MODE });
    // `mode` only applies when the temp file is created; a stale temp left by a
    // crashed run could be broader, so the mode is enforced explicitly.
    chmodSync(temp, PRIVATE_FILE_MODE);
    renameSync(temp, path);
  } catch (error) {
    // Some filesystems refuse a rename over an existing file (a Windows mount).
    // Mirroring the bot registry store, the fallback writes in place: not
    // atomic, but failing the wizard on such a host is worse.
    try {
      writeFileSync(path, serialized, { mode: PRIVATE_FILE_MODE });
      chmodSync(path, PRIVATE_FILE_MODE);
      rmSync(temp, { force: true });
    } catch {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

/** OpenCode renders an agent's description in one row, so it is written short. */
const SUBAGENT_DESCRIPTION_MAX = 80;

/**
 * The one-line label OpenCode shows for an agent.
 *
 * The first line of the prompt is the sentence the reader already wrote about
 * what this subagent does, and it is the only part capped: OpenCode renders it
 * in one row. A prompt that starts blank has no such sentence, so the name
 * stands in whole — it is a label the reader chose, not prose to truncate.
 */
function subagentDescription(name: string, prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return firstLine.slice(0, SUBAGENT_DESCRIPTION_MAX) || name;
}

/**
 * Writes a bot's named subagents into its own OpenCode config.
 *
 * OpenCode keeps agents, MCP servers, models and every other setting in one
 * file — the same `<botRoot>/config/opencode/opencode.json` the bot's server
 * reads (see `createBotOpenCodeEngine`) — so this merges into the `agent` key
 * and preserves everything around it. The entry is OpenCode's native custom
 * subagent: `mode: 'subagent'`, a description and the prompt. A second call for
 * the same name replaces that entry rather than adding a duplicate, which is
 * what an edited wizard row means.
 *
 * The write is atomic (temp file beside it, then rename), the same discipline
 * as `writeOpenCodeCredentials`: a host that dies mid-save leaves the previous
 * config intact instead of a truncated one that would lose the bot's MCP
 * servers.
 */
export function writeOpenCodeSubagents(
  botRoot: string,
  subagents: { name: string; prompt: string }[],
): void {
  const path = join(botRoot, 'config', 'opencode', 'opencode.json');
  const file = readOpenCodeFile(path);
  const existing = file.agent;
  if (
    existing !== undefined &&
    (typeof existing !== 'object' || existing === null || Array.isArray(existing))
  ) {
    throw new Error(`${path}: "agent" must be an object.`);
  }
  // Prototype-less on purpose: a subagent may legitimately be named `__proto__`,
  // and assigning that key on an ordinary object hits the prototype setter, so
  // the entry silently never reaches the file. Merging into a bare object keeps
  // every name — the file's existing entries included — as an own key.
  const agents: Record<string, unknown> = Object.assign(
    Object.create(null) as Record<string, unknown>,
    existing as Record<string, unknown> | undefined,
  );
  for (const subagent of subagents) {
    agents[subagent.name] = {
      mode: 'subagent',
      description: subagentDescription(subagent.name, subagent.prompt),
      prompt: subagent.prompt,
    };
  }
  file.agent = agents;
  writeConfigJson(path, file);
}

/**
 * Temp file beside the target, then rename: the config is either the previous
 * file or the new one, never half of each. The fallback mirrors the credential
 * writer, because a mount that refuses a rename over an existing file must not
 * fail the create.
 */
function writeConfigJson(path: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temp, serialized, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    try {
      writeFileSync(path, serialized, 'utf8');
      rmSync(temp, { force: true });
    } catch {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

/**
 * The bot's reattach factory: one engine per bot, started on first use.
 *
 * OpenCode has no process per session, so a bot's sessions cannot each own a
 * server the way pi's do. The engine (and therefore the server) is shared and
 * lazy: `create()` starts it once, and every later session — reattached by
 * `sessionId` or newly created — goes through the engine's own factory.
 * `dispose()` stops the server Morse started and is final: a later `create()`
 * reports the engine unavailable instead of silently spawning a second server,
 * because task 6's adapter builds a fresh factory rather than reviving a
 * disposed one.
 */
export function opencodeBotAdapterFactory(
  botRoot: string,
  logger: MorseLogger,
): AgentGatewayFactory & { dispose(): Promise<void> } {
  let pending: Promise<OpenCodeEngine> | undefined;
  let engine: OpenCodeEngine | undefined;
  let disposed = false;

  // The promise, not only the engine, is cached so two concurrent `create()`
  // calls start one server. A failed start clears it, so the next call retries
  // instead of replaying the error forever.
  const ensureEngine = (): Promise<OpenCodeEngine> => {
    if (engine !== undefined) {
      return Promise.resolve(engine);
    }
    pending ??= createBotOpenCodeEngine({ botRoot, logger }).then(
      (created) => {
        engine = created;
        return created;
      },
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };

  // The teardown is final, so a late create must be told, not given a new
  // engine: one bot, one server lifetime.
  const disposedError = (): AgentUnavailableError =>
    new AgentUnavailableError(
      "This bot's OpenCode engine was disposed. Build a new bot factory to start it again.",
    );

  return {
    async create(input) {
      if (disposed) {
        throw disposedError();
      }
      const target = await ensureEngine();
      // A dispose that raced the start above already tore the engine down.
      if (disposed) {
        throw disposedError();
      }
      // Bot sessions and engine sessions share ids, so reattachment is a
      // straight hand-off; no session means the engine creates one.
      return target.factory.create(input);
    },

    async dispose() {
      if (disposed) {
        return;
      }
      // Set before the awaits: a create() racing the teardown must see the
      // engine as gone, not restart it.
      disposed = true;
      const started = pending ?? (engine === undefined ? undefined : Promise.resolve(engine));
      pending = undefined;
      engine = undefined;
      const created = await started?.catch(() => undefined);
      await created?.dispose();
    },
  };
}
