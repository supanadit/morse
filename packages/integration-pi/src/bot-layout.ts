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
import type {
  BotEngineConfig,
  BotEngineLayout,
  BotEngineState,
  BotMcpServer,
  BotProviderApi,
  BotProviderRecord,
} from '@morse/system';
import type { ModelInput } from '@morse/agent';
import { readMcpFile, definesMcpServer } from './internal/mcp-config.js';
import type { McpFileServer } from './internal/mcp-config.js';

/**
 * pi's configuration, as pi itself expects it.
 *
 * `PI_CODING_AGENT_DIR` points at `<botRoot>/config`, so that directory *is* the
 * bot's `~/.pi/agent` — the same files, the same shapes, nothing Morse-specific:
 *
 * - `auth.json` — provider keys, pi's own `{ "<provider>": { type, key } }`.
 * - `models.json` — custom providers and their models (`providers.<id>`).
 * - `settings.json` — `defaultProvider`, `defaultModel`, `defaultThinkingLevel`,
 *   which is how pi remembers the model a session starts on.
 * - `SYSTEM.md` — **replaces** pi's own system prompt: the bot's persona, in the
 *   one file pi reserves for it.
 * - `<botRoot>/workspace/AGENTS.md` — the workspace document, which pi reads as a
 *   context file from the directory it runs in.
 *
 * `mcp.json`, `keybindings.json`, `extensions/`, `skills/` and `prompts/` are
 * pi's too; Morse writes none of them yet, and a bot inherits no MCP servers.
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

/** Reads `mcp.json` and returns the bot's own MCP servers, or undefined on error. */
function readPiMcpServers(path: string): BotMcpServer[] | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  let file: ReturnType<typeof readMcpFile>;
  try {
    file = readMcpFile(path);
  } catch {
    return undefined;
  }
  return Object.entries(file.mcpServers).flatMap(([name, raw]) => {
    const entry = asRecord(raw);
    if (entry === undefined || !definesMcpServer(entry as McpFileServer)) {
      return [];
    }
    const type: BotMcpServer['type'] =
      entry.type === 'http' || (typeof entry.url === 'string' && entry.command === undefined)
        ? 'http'
        : 'stdio';
    if (type === 'stdio' && (typeof entry.command !== 'string' || entry.command.length === 0)) {
      return [];
    }
    if (type === 'http' && (typeof entry.url !== 'string' || entry.url.length === 0)) {
      return [];
    }
    const server: BotMcpServer = {
      name,
      type,
      enabled: entry.enabled !== false,
    };
    if (typeof entry.command === 'string' && entry.command.length > 0) {
      server.command = entry.command;
    }
    if (Array.isArray(entry.args) && entry.args.length > 0) {
      server.args = entry.args as string[];
    }
    if (typeof entry.cwd === 'string' && entry.cwd.length > 0) {
      server.cwd = entry.cwd;
    }
    if (isStringRecord(entry.env)) {
      server.env = entry.env;
    }
    if (typeof entry.url === 'string' && entry.url.length > 0) {
      server.url = entry.url;
    }
    if (isStringRecord(entry.headers)) {
      server.headers = entry.headers;
    }
    if (typeof entry.exposure === 'string') {
      server.exposure = entry.exposure as BotMcpServer['exposure'];
    }
    return [server];
  });
}

/** Replaces the managed MCP servers in `mcp.json`, keeping project overrides. */
function writePiMcpServers(path: string, servers: readonly BotMcpServer[]): void {
  const file = readMcpFile(path);
  const next: Record<string, unknown> = { ...file };
  const nextServers: Record<string, unknown> = { ...file.mcpServers };
  const serverNames = new Set(servers.map((server) => server.name));

  for (const [name, raw] of Object.entries(file.mcpServers)) {
    const entry = asRecord(raw);
    if (entry !== undefined && definesMcpServer(entry as McpFileServer) && !serverNames.has(name)) {
      delete nextServers[name];
    }
  }

  for (const server of servers) {
    nextServers[server.name] = piMcpEntry(server, file.mcpServers[server.name]);
  }

  if (Object.keys(nextServers).length === 0) {
    delete next.mcpServers;
  } else {
    next.mcpServers = nextServers;
  }

  writePrivateJson(path, next);
}

/** Turns one `BotMcpServer` into pi's `mcpServers` entry, preserving unknown keys. */
function piMcpEntry(server: BotMcpServer, kept: unknown): Record<string, unknown> {
  const existing = asRecord(kept) ?? {};
  for (const key of ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'enabled', 'exposure']) {
    delete existing[key];
  }
  if (server.type === 'stdio') {
    existing.type = 'stdio';
    existing.command = server.command;
    if (server.args !== undefined && server.args.length > 0) {
      existing.args = server.args;
    }
    if (server.env !== undefined && Object.keys(server.env).length > 0) {
      existing.env = server.env;
    }
    if (server.cwd !== undefined && server.cwd.length > 0) {
      existing.cwd = server.cwd;
    }
  } else {
    existing.type = 'http';
    existing.url = server.url;
    if (server.headers !== undefined && Object.keys(server.headers).length > 0) {
      existing.headers = server.headers;
    }
  }
  if (server.enabled === false) {
    existing.enabled = false;
  }
  if (server.exposure !== undefined) {
    existing.exposure = server.exposure;
  }
  return existing;
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

/** Writes a bot's whole pi configuration, in pi's own layout. */
export function writePiBotConfig(botRoot: string, config: BotEngineConfig): void {
  const agentDir = piAgentDir(botRoot);

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
  const next: Record<string, unknown> = { $schema: PI_SETTINGS_SCHEMA, ...settings };
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
    writePiMcpServers(piMcpPath(botRoot), config.mcpServers);
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
    const mcpServers = readPiMcpServers(piMcpPath(botRoot));
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
        writePrivateJson(settingsPath, { $schema: PI_SETTINGS_SCHEMA, ...settings });
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

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((one) => typeof one === 'string');
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
