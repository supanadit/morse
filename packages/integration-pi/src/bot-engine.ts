import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BotEngineCapabilities, BotProviderRecord, MorseLogger } from '@morse/system';
import { piProviderEntry } from './bot-layout.js';
import { PiRpcAgentFactory } from './pi-rpc-agent-factory.js';
import { PiRpcSessionCatalog } from './pi-rpc-session-catalog.js';
import { PI_INSTALL_COMMAND } from './internal/resolve-pi.js';

/** pi's auth file, inside the agent dir pi reads from `PI_CODING_AGENT_DIR`. */
const AUTH_FILE = 'auth.json';
/** pi's custom provider/model config, inside the same agent dir. */
const MODELS_FILE = 'models.json';
/** A file holding API keys is readable by its owner only. */
const PRIVATE_FILE_MODE = 0o600;

/**
 * What the pi engine offers a bot. Credentials are `'stored'`: pi reads API
 * keys from `auth.json` in its agent dir, which for a bot is
 * `<botRoot>/config/auth.json`, so the wizard collects keys instead of asking
 * for environment variables.
 */
export const PI_BOT_CAPABILITIES: BotEngineCapabilities = {
  supportsSubagents: false,
  supportsThinkingLevels: true,
  credentials: 'stored',
};

/** Where to get pi, for the bot wizard's "not installed" remedy. */
export const PI_INSTALL_HINT = PI_INSTALL_COMMAND;

export interface BotPiFactoryOptions {
  botRoot: string;
  /** Base environment to inherit; defaults to the host's. */
  env?: NodeJS.ProcessEnv;
  piPath?: string;
  logger: MorseLogger;
}

/**
 * The environment a bot's pi process gets.
 *
 * `PI_CODING_AGENT_DIR` is the only variable pointed at the bot; everything
 * else is inherited on purpose. `resolvePi` looks up `MORSE_PI_PATH` and walks
 * `PATH` in this same env, so handing pi a fragment (just the agent dir) would
 * make it unresolvable. Overriding instead of appending is deliberate too: a
 * host launched from inside pi would otherwise pass the user's real agent dir
 * down, and the bot would read and write the user's own sessions and auth.
 */
export function botPiEnv(botRoot: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, PI_CODING_AGENT_DIR: join(botRoot, 'config') };
}

/**
 * A pi factory whose spawned processes are confined to one bot's directory:
 * the agent dir (config, auth, model state) under `config/`, sessions and
 * speed stats under `sessions/`. Built per bot because that isolation is fixed
 * at construction, unlike code mode's shared factory.
 */
export function createBotPiFactory(
  options: BotPiFactoryOptions,
): PiRpcAgentFactory & { removeSession(sessionId: string): Promise<void> } {
  const sessionsDir = join(options.botRoot, 'sessions');
  const factory = new PiRpcAgentFactory(
    {
      piPath: options.piPath,
      sessionDir: sessionsDir,
      // Speed stats live inside the bot's tree, so deleting a bot deletes them
      // too and one bot's sessions never leak into another's data dir.
      dataDir: sessionsDir,
      env: botPiEnv(options.botRoot, options.env),
    },
    options.logger,
  );
  // Bound to the same directory the factory spawns into: the catalog's own
  // guard is what keeps a stored id from deleting a file outside this bot.
  const catalog = new PiRpcSessionCatalog({ sessionDir: sessionsDir });
  return Object.assign(factory, {
    removeSession: (sessionId: string) => catalog.remove(sessionId),
  });
}

/**
 * Writes pi's `auth.json` for a bot from the keys the wizard collected.
 *
 * The file is rewritten whole rather than merged: the wizard owns this bot's
 * credentials, so a provider it no longer lists must disappear instead of
 * lingering with an old key. Mode 0600 and the atomic write keep a secret from
 * being world-readable or half-written if the host dies mid-save. Nothing is
 * read from the user's own agent dir — only what is passed in is written.
 */
export function writePiCredentials(
  botRoot: string,
  entries: { provider: string; apiKey: string }[],
): void {
  const auth: Record<string, { type: 'api'; key: string }> = {};
  for (const entry of entries) {
    auth[entry.provider] = { type: 'api', key: entry.apiKey };
  }
  writePrivateJson(join(botRoot, 'config', AUTH_FILE), auth);
}

/**
 * Writes the wizard's provider records into the bot's `models.json` — the UI
 * equivalent of the reader hand-adding a `providers.<id>` block there.
 *
 * pi resolves this file under its agent dir, which for a bot is
 * `<botRoot>/config/`. A stored key lands as the literal `apiKey`; an env
 * reference as pi's `$NAME` convention. Each model carries the fields pi's
 * `models[]` schema names (`id`, `name`, `contextWindow`, `maxTokens`). The
 * write merges — other providers and unknown top-level keys survive — and is
 * private-from-creation, the same discipline as `writePiCredentials`.
 */
export function writePiProviders(
  botRoot: string,
  providers: readonly BotProviderRecord[],
): void {
  const path = join(botRoot, 'config', MODELS_FILE);
  const file = readJsonObject(path) ?? {};
  const existing = file['providers'];
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
    written[provider.id] = piProviderEntry(provider, written[provider.id]);
  }
  writePrivateJson(path, { ...file, providers: written });
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
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
