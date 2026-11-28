import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentGatewayFactory } from '@morse/agent';
import {
  AgentUnavailableError,
  asRecord,
  writePrivateJson,
  type BotEngineCapabilities,
  type BotProviderRecord,
  type MorseLogger,
} from '@morse/system';
import { resolveEngineContext } from '@morse/engine-config';
import { openCodeConfigPath, openCodeProviderEntry } from './bot-layout.js';
import { importOpenCodeGoCredential } from './internal/go-auth.js';
import { awaitSettledCatalog, credentialedProviders } from './internal/catalog-poll.js';
import { botUserSpaceEnv } from './bot-user-space.js';
import { OpenCodeEngine } from './opencode-engine.js';
import { OpenCodeMcp } from './opencode-mcp.js';
import { OpenCodePrompts } from './opencode-prompts.js';
import { connectOpenCode, type OpenCodeConnection } from './internal/connection.js';
import { readOpenCodeFile } from './internal/opencode-json.js';
import { OpenCodeApi } from './internal/client.js';
import { OpenCodeEventStream } from './internal/event-stream.js';

/**
 * OpenCode confined to one bot's directory.
 *
 * The isolation is environmental and covers three things:
 * - the spawned server's `XDG_CONFIG_HOME` (`<botRoot>/config`) and
 *   `XDG_DATA_HOME` (`<botRoot>/sessions`), where OpenCode reads and writes
 *   providers, agents, MCP servers and commands (config root) and sessions,
 *   logs and auth (data root);
 * - the MCP/command administration, pinned to the same config directory the
 *   server reads (`<botRoot>/config/opencode`), so an edit lands in the bot;
 * - credentials, written by Morse into the bot's data dir — the wizard's own
 *   keys, or a snapshot of the user's global store taken on explicit request
 *   ("Use global configuration"), never a live reference to it.
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
  /**
   * The base environment: the host's, plus what `BotService` declared for this
   * bot — its own KEY=value pairs and the `MORSE_BUS_*` files its bus plugin
   * reads. Defaults to the host's own; the XDG redirects go on top either way.
   */
  env?: NodeJS.ProcessEnv;
  logger: MorseLogger;
}

/**
 * The environment a bot's OpenCode server gets.
 *
 * Same contract as `botUserSpaceEnv`, which does the work: both XDG roots are
 * redirected into the bot so its server reads and writes nothing of the
 * reader's, while the host's real roots travel as `MORSE_HOST_XDG_*` for the
 * shell plugin (`writeBotUserSpacePlugin`), which restores them for the commands
 * a bot runs. `PATH` above all, which the spawn needs to find the binary, is
 * inherited unchanged — see `botUserSpaceEnv` for why that matters and what it
 * costs.
 */
export function botOpenCodeEnv(
  botRoot: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return botUserSpaceEnv(botRoot, base);
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
  const env = botOpenCodeEnv(options.botRoot, options.env);
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
  // The server's catalog is still loading at this point: keyless models answer
  // at once, credentialed ones land once the server's background fetch
  // finishes. Waiting for the credentialed providers to materialize here
  // (bounded, best-effort) is what keeps a fresh bot or probe from reporting
  // a healthy provider as empty.
  try {
    const credentialProviders = credentialedProviders(
      options.botRoot,
      { url: connection.baseUrl, password: connection.password },
      options.logger,
    );
    await awaitSettledCatalog(api, options.botRoot, options.logger, {
      credentialProviders,
    });
  } catch (error: unknown) {
    options.logger.warn('The bot engine catalog could not settle before first use', error);
  }
  // The same assembly as `createOpenCodeEngine`, with both administrations
  // pinned to the config directory the server itself reads: configDir is
  // OpenCode's own dir, i.e. the XDG *base* plus `opencode/` (the resolvers
  // join `opencode.json` and `commands/` off it). `botOpenCodeEnv` points
  // XDG_CONFIG_HOME at `<botRoot>/config`, so this is `<botRoot>/config/opencode`.
  const configRoot = join(options.botRoot, 'config');
  const configDir = join(configRoot, 'opencode');
  return new OpenCodeEngine({
    connection,
    api,
    stream,
    logger: options.logger,
    // The bot's tree is Morse's own: `isolated` names the root the resolver
    // turns into `<root>/opencode` (the same `configDir`) and makes every file
    // these managers create private, instead of the 0644 a user file gets.
    mcp: new OpenCodeMcp({ ownership: 'isolated', root: configRoot }),
    prompts: new OpenCodePrompts({ ownership: 'isolated', root: configRoot }),
    configDir,
    // The guard fingerprints the config tree the bot's server reads, which is
    // the one this environment redirects into the bot.
    env,
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
 * Writes the wizard's provider records into the bot's `opencode.json` — the UI
 * equivalent of the reader hand-adding a `providers.<id>` block.
 *
 * The runtime `package` follows the wire protocol
 * (opencode.ai/docs/providers#packages); a stored key lands in
 * `settings.apiKey`, an env reference in the provider's `env` list. Models are
 * written as the map OpenCode expects, keyed by the OpenCode model ID. The
 * write merges (MCP servers, other providers and unknown keys survive) and is
 * atomic, the same discipline as `writeOpenCodeSubagents`.
 *
 * Catalog providers without a `baseUrl` are skipped: OpenCode discovers those
 * from its own models.dev catalog once the credential exists.
 */
export function writeOpenCodeProviders(
  botRoot: string,
  providers: readonly BotProviderRecord[],
): void {
  const path = join(botRoot, 'config', 'opencode', 'opencode.json');
  const file = readOpenCodeFile(path);
  const existing = file.providers;
  if (
    existing !== undefined &&
    (typeof existing !== 'object' || existing === null || Array.isArray(existing))
  ) {
    throw new Error(`${path}: "providers" must be an object.`);
  }
  const written: Record<string, unknown> = Object.assign(
    Object.create(null) as Record<string, unknown>,
    existing as Record<string, unknown> | undefined,
  );
  for (const provider of providers) {
    // A provider with no endpoint of its own is a catalog one the engine already
    // knows: its key belongs in the auth store, not in a `providers` block. The
    // exception is a correction of model fields for an entry the file already has,
    // which arrives without an endpoint and must land.
    if (provider.baseUrl === undefined && written[provider.id] === undefined) {
      continue;
    }
    written[provider.id] = openCodeProviderEntry(
      provider,
      written[provider.id],
      OPENCODE_PACKAGE,
    );
  }
  file.providers = written;
  writeConfigJson(path, file);
}

/** OpenCode runtime package per Morse wire protocol. */
export const OPENCODE_PACKAGE: Record<NonNullable<BotProviderRecord['api']>, string> = {
  'openai-completions': '@opencode/ai/providers/openai-compatible',
  'openai-responses': '@opencode/ai/providers/openai-compatible/responses',
  'anthropic-messages': '@opencode/ai/providers/anthropic-compatible',
  'google-generative-ai': '@opencode/ai/providers/google',
};

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * Snapshots the machine's global OpenCode configuration into one bot's
 * isolated store: every `auth.json` entry and every custom provider the bot
 * does not already declare, its `{env:NAME}` references resolved to this
 * machine's values so the copy stands on its own. The bot wins on conflict, so
 * a key the wizard pasted is never overwritten — except an empty key, which is
 * what a provider cloned from the catalog carries until this fills it. The copy
 * is whole records, because the frontend never sees a secret to send back.
 *
 * The Go login comes along best-effort through the same import a checked
 * "use my login" box would run; no login is nothing to copy, not a failure.
 * Missing global files are likewise success-with-nothing, while a malformed
 * one throws so a save says what it could not read.
 */
export async function importOpenCodeGlobalConfig(
  botRoot: string,
  logger: MorseLogger,
): Promise<boolean> {
  const context = resolveEngineContext({ env: process.env });
  const botAuthPath = join(botRoot, 'sessions', 'opencode', 'auth.json');
  const globalAuth = readJsonObject(join(context.xdgDataHome, 'opencode', 'auth.json')) ?? {};
  const botAuth = readJsonObject(botAuthPath) ?? {};
  writePrivateJson(botAuthPath, { ...globalAuth, ...botAuth });

  const globalConfig =
    readJsonObject(join(context.xdgConfigHome, 'opencode', 'opencode.json')) ?? {};
  const globalProviders: Record<string, unknown> = {
    ...(typeof globalConfig['provider'] === 'object' &&
    globalConfig['provider'] !== null &&
    !Array.isArray(globalConfig['provider'])
      ? (globalConfig['provider'] as Record<string, unknown>)
      : {}),
    ...(typeof globalConfig['providers'] === 'object' &&
    globalConfig['providers'] !== null &&
    !Array.isArray(globalConfig['providers'])
      ? (globalConfig['providers'] as Record<string, unknown>)
      : {}),
  };
  const botPath = openCodeConfigPath(botRoot);
  const botConfig = readJsonObject(botPath) ?? {};
  const botBlockKey =
    typeof botConfig['provider'] === 'object' &&
    botConfig['provider'] !== null &&
    !Array.isArray(botConfig['provider'])
      ? 'provider'
      : 'providers';
  const botProviders =
    typeof botConfig[botBlockKey] === 'object' &&
    botConfig[botBlockKey] !== null &&
    !Array.isArray(botConfig[botBlockKey])
      ? { ...(botConfig[botBlockKey] as Record<string, unknown>) }
      : {};
  for (const [id, entry] of Object.entries(globalProviders)) {
    const declared = botProviders[id];
    const kept = asRecord(declared) ?? {};
    const settings = asRecord(kept['settings']);
    if (declared !== undefined && settings?.['apiKey'] !== '') {
      continue;
    }
    const copy = resolveEnvReferences(entry, process.env);
    botProviders[id] =
      declared === undefined
        ? copy
        : { ...kept, settings: { ...settings, apiKey: providerKey(copy) } };
  }
  writeConfigJson(botPath, { ...botConfig, [botBlockKey]: botProviders });

  await importOpenCodeGoCredential(botRoot, logger);
  return true;
}

/** A provider entry's key: in `settings`, or the older `options` block. */
function providerKey(entry: unknown): unknown {
  const record = asRecord(entry) ?? {};
  return asRecord(record['settings'])?.['apiKey'] ?? asRecord(record['options'])?.['apiKey'];
}

/**
 * A copied entry with its `{env:NAME}` references replaced by this machine's
 * values. A name the machine does not hold stays a reference, for the bot's own
 * server to resolve.
 */
function resolveEnvReferences(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (whole, name: string) => env[name] ?? whole,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvReferences(item, env));
  }
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, resolveEnvReferences(item, env)]),
      )
    : value;
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
  env?: NodeJS.ProcessEnv,
): AgentGatewayFactory & {
  dispose(): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
} {
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
    pending ??= createBotOpenCodeEngine({ botRoot, logger, env }).then(
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

    async removeSession(sessionId: string): Promise<void> {
      if (disposed) {
        throw disposedError();
      }
      const target = await ensureEngine();
      if (disposed) {
        throw disposedError();
      }
      await target.catalog.remove(sessionId);
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
