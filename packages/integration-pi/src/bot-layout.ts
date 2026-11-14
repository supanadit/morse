import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConfigDocument } from '@morse/engine-config';
import type {
  BotEngineConfig,
  BotEngineLayout,
  BotEngineState,
  BotProviderApi,
  BotProviderRecord,
} from '@morse/system';
import type { ModelInput } from '@morse/agent';
import { PiEngineDefinition, type PiEngineInstance } from './engine/pi-engine.js';

/**
 * pi's configuration, as pi itself expects it.
 *
 * `PI_CODING_AGENT_DIR` points at `<botRoot>/config`, so that directory *is* the
 * bot's `~/.pi/agent` — the same files, the same shapes, nothing Morse-specific:
 *
 * - `auth.json` — provider keys, pi's own `{ "<provider>": { type, key } }`.
 * - `models.json` — custom providers and their models (`providers.<id>`).
 * - `settings.json` — `$schema` pointing at pi's published settings schema, plus
 *   `defaultProvider`, `defaultModel`, `defaultThinkingLevel` and `defaultTools`:
 *   how pi remembers the model, thinking level and tool allowlist a session
 *   starts with. Morse writes the schema reference but never validates the file
 *   against it; the schema is for the editor, which uses it to validate and
 *   complete the file.
 * - `mcp.json` — the bot's own MCP servers, under pi's `mcpServers.<name>` keys.
 *   Morse writes them from the wizard's list, so a bot carries the servers it was
 *   given and inherits none from the user's own configuration; entries that only
 *   override a user-level server are left in place, and a malformed entry is
 *   skipped on read. The file is pi's own, so it is written through the same
 *   store the MCP panel uses — there is no bot-only copy of that codec.
 * - `SYSTEM.md` — **replaces** pi's own system prompt: the bot's persona, in the
 *   one file pi reserves for it.
 * - `<botRoot>/workspace/AGENTS.md` — the workspace document, which pi reads as a
 *   context file from the directory it runs in.
 *
 * `keybindings.json`, `extensions/`, `skills/` and `prompts/` are pi's too; Morse
 * writes none of them yet, and a bot inherits no keybindings, extensions, skills
 * or prompts from the user's own configuration.
 *
 * The distinction matters (docs.pi.dev/latest/configuration): `AGENTS.md` in the
 * agent dir is *user instructions applied across working directories* — appended
 * context — while `SYSTEM.md` is the system prompt itself, and
 * `APPEND_SYSTEM.md` is what appends to it. A bot's character belongs in
 * `SYSTEM.md`; writing it to `AGENTS.md` made it a second set of instructions
 * rather than the character.
 *
 * `read` answers the wizard from these files, so Edit bot shows what pi holds.
 */

const AUTH_FILE = 'auth.json';
const MODELS_FILE = 'models.json';
const SETTINGS_FILE = 'settings.json';
const MCP_FILE = 'mcp.json';
/**
 * pi publishes a JSON Schema for `settings.json`; referencing it is what gives an
 * editor completion and validation inside a bot's agent dir, where nothing else
 * tells the reader which keys pi accepts.
 */
const PI_SETTINGS_SCHEMA = 'https://pi.dev/schemas/settings.schema.json';
/** pi's system-prompt file: it *replaces* the default prompt. */
const SYSTEM_FILE = 'SYSTEM.md';
/**
 * Where the persona was written before this layout: pi's agent-dir instructions,
 * which it treats as appended context rather than the system prompt. Kept only so
 * `repair` can move it.
 */
const LEGACY_PERSONA_FILE = 'AGENTS.md';

/** pi's agent dir for a bot: the directory `PI_CODING_AGENT_DIR` names. */
export function piAgentDir(botRoot: string): string {
  return join(botRoot, 'config');
}

/** pi's `mcp.json` path for a bot. */
export function piMcpPath(botRoot: string): string {
  return join(piAgentDir(botRoot), MCP_FILE);
}

/**
 * One `models.json` provider entry. An edit that only corrected model fields
 * arrives without a credential (Morse never reads a key back) and possibly without
 * an `api`, so whatever the file already holds is kept and only the models are
 * rewritten.
 */
export function piProviderEntry(provider: BotProviderRecord, kept: unknown): unknown {
  const existing = asRecord(kept) ?? {};
  const baseUrl = provider.baseUrl ?? existing['baseUrl'];
  const api = provider.api ?? existing['api'];
  const apiKey =
    provider.credential === undefined
      ? existing['apiKey']
      : provider.credential.kind === 'stored'
        ? provider.credential.apiKey
        : `$${provider.credential.name}`;
  return {
    ...existing,
    // pi's provider `name` is its display name; keeping it is what lets Edit bot
    // show the label the reader gave the provider.
    ...(provider.label.length > 0 ? { name: provider.label } : {}),
    ...(typeof baseUrl === 'string' && baseUrl.length > 0 ? { baseUrl } : {}),
    ...(api === undefined ? {} : { api }),
    ...(apiKey === undefined ? {} : { apiKey }),
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      // pi defaults a model's modalities to `["text"]`, so a vision model has to
      // say so here or pi (and a bot's paste gate) treats it as text-only.
      ...(model.input === undefined ? {} : { input: [...model.input] }),
    })),
  };
}

/**
 * The engine instance whose agent dir is this bot's `config/`: the same
 * isolated pi the MCP panel and the prompt store use, so a bot's `mcp.json` has
 * one codec rather than a bot-only copy of pi's.
 */
function botEngine(botRoot: string): PiEngineInstance {
  return new PiEngineDefinition().isolated(piAgentDir(botRoot), {
    env: process.env,
  }) as PiEngineInstance;
}

/**
 * Why pi could not read this `mcp.json`, or `undefined` when it can.
 *
 * The shared store reports a file it cannot parse as issues and carries on; a
 * bot's save and Edit-bot read both need to tell "no servers" from "a file I
 * cannot read", and the layout has always treated the second as unreadable. The
 * document's own issues only describe the bytes, so the two shapes pi requires —
 * an object at the root and an object under `mcpServers` — are checked here.
 */
function mcpFileProblem(document: ConfigDocument): string | undefined {
  const blocking = document.issues.find((issue) => issue.code === 'parse' || issue.code === 'read');
  if (blocking !== undefined) {
    return blocking.message;
  }
  if (document.value !== undefined && asRecord(document.value) === undefined) {
    return `${document.path} is not a JSON object.`;
  }
  const block = asRecord(document.value)?.['mcpServers'];
  if (block !== undefined && block !== null && asRecord(block) === undefined) {
    return `${document.path}: "mcpServers" must be an object.`;
  }
  return undefined;
}

/**
 * The providers `models.json` declares, as the wizard's own shape. Read back so
 * Edit bot starts from what pi really has: the file is where a context window or a
 * modality lives, and a wrong automatic value is fixed here, by hand.
 */
function readProviders(path: string): BotProviderRecord[] {
  const file = readJsonObject(path) ?? {};
  const entries = asRecord(file['providers']) ?? {};
  const providers = Object.entries(entries).flatMap(([id, value]) => {
    const provider = asRecord(value);
    if (provider === undefined) {
      return [];
    }
    const models = Array.isArray(provider['models']) ? provider['models'] : [];
    return [
      {
        id,
        label: typeof provider['name'] === 'string' ? provider['name'] : id,
        ...(typeof provider['api'] === 'string' ? { api: provider['api'] as BotProviderApi } : {}),
        ...(typeof provider['baseUrl'] === 'string' ? { baseUrl: provider['baseUrl'] } : {}),
        models: models.flatMap((model) => {
          const entry = asRecord(model);
          const modelId = entry === undefined ? undefined : entry['id'];
          if (entry === undefined || typeof modelId !== 'string' || modelId.length === 0) {
            return [];
          }
          const input = Array.isArray(entry['input'])
            ? entry['input'].filter((one): one is ModelInput => typeof one === 'string')
            : undefined;
          return [
            {
              id: modelId,
              ...(typeof entry['name'] === 'string' ? { name: entry['name'] } : {}),
              ...(typeof entry['contextWindow'] === 'number'
                ? { contextWindow: entry['contextWindow'] }
                : {}),
              ...(typeof entry['maxTokens'] === 'number' ? { maxTokens: entry['maxTokens'] } : {}),
              ...(input === undefined ? {} : { input }),
            },
          ];
        }),
      },
    ];
  });
  return providers as BotProviderRecord[];
}

/** The workspace document pi reads from the directory it runs in. */
export function piWorkspacePath(botRoot: string): string {
  return join(botRoot, 'workspace', 'AGENTS.md');
}

/** The bot's system prompt, where pi replaces its own. */
export function piSystemPromptPath(botRoot: string): string {
  return join(piAgentDir(botRoot), SYSTEM_FILE);
}

/**
 * A `settings.json` object whose `$schema` is pi's, keeping every other key.
 *
 * The literal comes first so the key is written first; the spread would then win
 * the *value*, so it is forced back — a file pointed at another schema is
 * corrected instead of rewritten with the same wrong URL on every pass.
 */
function withPiSettingsSchema(settings: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { $schema: PI_SETTINGS_SCHEMA, ...settings };
  next['$schema'] = PI_SETTINGS_SCHEMA;
  return next;
}

/** Writes a bot's whole pi configuration, in pi's own layout. */
export function writePiBotConfig(botRoot: string, config: BotEngineConfig): void {
  const agentDir = piAgentDir(botRoot);
  const mcpStore = botEngine(botRoot).mcp;
  // Read `mcp.json` before the first write. The file is the reader's, and a
  // malformed one is an error: discovering it after auth, models, settings and
  // the persona were rewritten would leave the bot half-updated, with no clear
  // way to tell which half the form managed to apply. The store reports such a
  // file as issues and would only refuse later, so the refusal is raised here —
  // before anything else is touched.
  if (config.mcpServers !== undefined) {
    const problem = mcpFileProblem(mcpStore.file('global').read());
    if (problem !== undefined) {
      throw new Error(problem);
    }
  }

  // auth.json — pi's own credential store, rewritten whole when the form
  // collected keys: the wizard owns this bot's keys then, so a provider it no
  // longer lists disappears. No key collected means "keep what is there".
  if (config.credentials.length > 0) {
    const auth: Record<string, { type: 'api_key'; key: string }> = {};
    for (const entry of config.credentials) {
      auth[entry.provider] = { type: 'api_key', key: entry.apiKey };
    }
    writePrivateJson(join(agentDir, AUTH_FILE), auth);
  }

  // models.json — custom providers, in pi's `providers.<id>` shape. Merged so a
  // hand-added provider survives an edit that does not mention it.
  const modelsPath = join(agentDir, MODELS_FILE);
  const models = readJsonObject(modelsPath) ?? {};
  const existing = asRecord(models['providers']) ?? {};
  const providers: Record<string, unknown> = { ...existing };
  for (const provider of config.providers) {
    providers[provider.id] = piProviderEntry(provider, existing[provider.id]);
  }
  writePrivateJson(modelsPath, { ...models, providers });

  // settings.json — the defaults pi starts a session with. Only the keys Morse
  // owns are touched: theme, packages and the reader's own preferences stay.
  // `$schema` goes first so the file opens with the pointer to pi's schema.
  const settingsPath = join(agentDir, SETTINGS_FILE);
  const settings = readJsonObject(settingsPath) ?? {};
  const next = withPiSettingsSchema(settings);
  if (config.model === null) {
    // An explicit clear: back to the engine's own default.
    delete next['defaultProvider'];
    delete next['defaultModel'];
  } else if (config.model !== undefined) {
    next['defaultProvider'] = config.model.provider;
    next['defaultModel'] = config.model.id;
  }
  // pi's own built-in tool names, written verbatim: `defaultTools` is an allowlist,
  // so `['read','bash','edit','write']` is the default set and `[]` is "none".
  // Undefined leaves whatever the bot already had.
  if (config.tools !== undefined) {
    next['defaultTools'] = [...config.tools];
  }
  if (config.thinkingLevel === undefined) {
    delete next['defaultThinkingLevel'];
  } else {
    next['defaultThinkingLevel'] = config.thinkingLevel;
  }
  writePrivateJson(settingsPath, next);

  // SYSTEM.md — the bot's character, replacing pi's own system prompt. The
  // workspace document goes to the workspace, where pi picks it up as a context
  // file from the directory it runs in.
  writePrivateText(join(agentDir, SYSTEM_FILE), config.persona);
  if ((config.agentsMd ?? '').trim().length > 0) {
    writePrivateText(piWorkspacePath(botRoot), config.agentsMd as string);
  }

  if (config.mcpServers !== undefined) {
    // The one writer of `mcp.json`: the shared store replaces the managed set,
    // keeps an entry that only overrides a user-level server, and preserves the
    // unknown fields of the entries it rewrites.
    const written = mcpStore.replaceManaged(config.mcpServers, 'global');
    if (!written.ok) {
      throw new Error(
        written.issues?.[0]?.message ??
          written.message ??
          `${piMcpPath(botRoot)}: the MCP servers were not written.`,
      );
    }
  }
}

/**
 * Reads the bot's pi configuration back into the wizard's vocabulary: the model
 * and thinking level from `settings.json`, the persona from the agent dir's
 * `AGENTS.md`, the workspace document from the workspace one.
 */
export const piBotLayout: BotEngineLayout = {
  write: writePiBotConfig,
  read(botRoot: string): BotEngineState {
    const agentDir = piAgentDir(botRoot);
    const settings = readJsonObject(join(agentDir, SETTINGS_FILE)) ?? {};
    const provider = settings['defaultProvider'];
    const model = settings['defaultModel'];
    const thinking = settings['defaultThinkingLevel'];
    const defaults = settings['defaultTools'];
    const tools = Array.isArray(defaults)
      ? defaults.filter((one): one is string => typeof one === 'string')
      : undefined;
    const persona = readText(join(agentDir, SYSTEM_FILE));
    const agentsMd = readText(piWorkspacePath(botRoot));
    const providers = readProviders(join(agentDir, MODELS_FILE));
    // A bot with no `mcp.json` has no servers to show, and one whose file pi
    // could not read is skipped rather than shown as "none configured": Edit bot
    // must not offer to overwrite a list it never saw. A file that is there and
    // readable always answers with a list, even an empty one: a 0-byte file and
    // a `"mcpServers": null` block both read as "no servers yet", the shared
    // decoder's rule that an empty or null block is simply absent, and the next
    // save writes the managed set over the key.
    const mcp = botEngine(botRoot).mcp;
    const mcpDocument = mcp.file('global').read();
    const mcpServers =
      !mcpDocument.exists || mcpFileProblem(mcpDocument) !== undefined
        ? undefined
        : mcp.list().items.map((entry) => entry.server);
    return {
      ...(providers.length === 0 ? {} : { providers }),
      ...(typeof provider === 'string' && typeof model === 'string'
        ? { model: { provider, id: model, name: model } }
        : {}),
      ...(typeof thinking === 'string'
        ? { thinkingLevel: thinking as BotEngineState['thinkingLevel'] }
        : {}),
      ...(tools === undefined ? {} : { tools }),
      ...(persona === undefined ? {} : { persona }),
      ...(agentsMd === undefined ? {} : { agentsMd }),
      ...(mcpServers === undefined ? {} : { mcpServers }),
    };
  },
  /**
   * Moves a persona an earlier Morse wrote to `AGENTS.md` into `SYSTEM.md`.
   *
   * `SYSTEM.md` is missing on every bot created before this layout, and leaving
   * the persona in `AGENTS.md` would keep applying it as appended instructions
   * instead of as the system prompt. The file is removed rather than copied: two
   * copies of the same character would say it twice.
   */
  repair(botRoot: string): void {
    const agentDir = piAgentDir(botRoot);
    // settings.json existed before pi published a schema, so an older bot's file
    // has no `$schema`. Seeded rather than written: the file is only touched when
    // it is already there, and every other key is kept.
    const settingsPath = join(agentDir, SETTINGS_FILE);
    if (existsSync(settingsPath)) {
      const settings = readJsonObject(settingsPath) ?? {};
      if (settings['$schema'] !== PI_SETTINGS_SCHEMA) {
        writePrivateJson(settingsPath, withPiSettingsSchema(settings));
      }
    }
    const legacy = join(agentDir, LEGACY_PERSONA_FILE);
    const target = join(agentDir, SYSTEM_FILE);
    // An empty SYSTEM.md is treated as absent: an earlier repair (or a form saved
    // with a blank persona) may have created one, and the real text is still in
    // AGENTS.md.
    const targetEmpty = !existsSync(target) || (readText(target) ?? '').trim().length === 0;
    if (!targetEmpty || !existsSync(legacy)) {
      return;
    }
    writePrivateText(target, readFileSync(legacy, 'utf8'));
    rmSync(legacy, { force: true });
  },
};

/** Reads a JSON object, treating a missing file as `{}` and refusing anything else. */
function readJsonObject(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function writePrivateText(path: string, text: string): void {
  writePrivate(path, text.endsWith('\n') ? text : `${text}\n`);
}

function writePrivateJson(path: string, value: unknown): void {
  writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Temp file beside the target, then rename: private from the moment it exists. */
function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  try {
    renameSync(temp, path);
  } catch {
    writeFileSync(path, text, { mode: 0o600 });
  }
}
