import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModelInput } from '@morse/agent';
import type {
  BotEngineConfig,
  BotEngineLayout,
  BotEngineState,
  BotMcpServer,
  BotProviderModel,
  BotProviderRecord,
} from '@morse/system';
import {
  definesMcpServer,
  readOpenCodeFile,
  type OpenCodeMcpServer,
} from './internal/opencode-mcp-config.js';
import { writeOpenCodeCredentials } from './bot-engine.js';

/**
 * OpenCode's configuration, as OpenCode itself expects it.
 *
 * Everything Morse knows about a bot is written where a person configuring
 * OpenCode by hand would put it, because that is the only layout OpenCode reads:
 *
 * - `<botRoot>/config/opencode/opencode.json` — the file the bot's own server
 *   loads (its `XDG_CONFIG_HOME` is `<botRoot>/config`). It carries the schema
 *   reference, the display name, the default `model`, the `providers` block, and
 *   the bot itself as an agent: `agents.morse` with `mode: 'primary'` and the
 *   persona as its `system`, made the default through `default_agent`
 *   (opencode.ai/docs/agents — a non-empty `system` *replaces* the provider's
 *   base prompt for that agent, while project instructions are still added).
 * - `<botRoot>/workspace/AGENTS.md` — the workspace document, which OpenCode
 *   reads from the project root on its own; `instructions` names it explicitly.
 * - `<botRoot>/sessions/opencode/auth.json` — the keys, in OpenCode's own auth
 *   store inside the bot's data dir (its `XDG_DATA_HOME` is `<botRoot>/sessions`).
 *
 * There is no Morse-specific configuration in any of it, and no copy kept
 * elsewhere: `read` answers the wizard from these same files.
 */

/** The config file's own path, and OpenCode's own schema for it. */
const CONFIG_SCHEMA = 'https://opencode.ai/config.json';

/**
 * The agent OpenCode runs a bot as.
 *
 * Morse overrides one of OpenCode's own agents with the bot: `mode: 'primary'`
 * makes it the agent a new session starts in, `default_agent` points at it, and
 * its `system` is the bot's persona. Subagents the reader defined live beside it
 * as `mode: 'subagent'` entries.
 */
const MORSE_AGENT = 'morse';

/** OpenCode runtime package per Morse wire protocol (opencode.ai/docs/providers). */
const OPENCODE_PACKAGE: Record<string, string> = {
  'openai-completions': '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  'anthropic-messages': '@ai-sdk/anthropic',
  'google-generative-ai': '@ai-sdk/google',
};

/** The OpenCode file this bot's server reads. */
export function openCodeConfigPath(botRoot: string): string {
  return join(botRoot, 'config', 'opencode', 'opencode.json');
}

/**
 * Where the persona used to be written, before it became the agent's `system`.
 * Kept only so `repair` can fold it into the config and remove it.
 */
export function openCodeLegacyPersonaPath(botRoot: string): string {
  return join(botRoot, 'config', 'opencode', 'instructions', 'persona.md');
}

/** The agent id a bot runs as in OpenCode. */
export const OPENCODE_BOT_AGENT = MORSE_AGENT;

/** The workspace document OpenCode reads from the project root. */
export function openCodeWorkspacePath(botRoot: string): string {
  return join(botRoot, 'workspace', 'AGENTS.md');
}

/**
 * Writes a bot's whole OpenCode configuration.
 *
 * The file is merged, not replaced: MCP servers, plugins and any key the reader
 * hand-added survive (an edit through the wizard owns only what the wizard
 * shows). Everything Morse manages is written fresh, so removing a provider or
 * a subagent in the form removes it from the file.
 */
export function writeOpenCodeBotConfig(botRoot: string, config: BotEngineConfig): void {
  const path = openCodeConfigPath(botRoot);
  const file = readOpenCodeFile(path);

  // The workspace document is the project's instructions; the persona is the
  // agent's system prompt, below. OpenCode discovers AGENTS.md from the project
  // root on its own, and naming it here keeps its role explicit.
  const instructions: string[] = [];
  if ((config.agentsMd ?? '').trim().length > 0) {
    writePrivateText(openCodeWorkspacePath(botRoot), config.agentsMd as string);
    instructions.push(openCodeWorkspacePath(botRoot));
  }

  const next: Record<string, unknown> = {
    ...file,
    $schema: CONFIG_SCHEMA,
    // OpenCode's own display-name field: what a person sees in its UI.
    username: config.name,
    // The bot is an agent of its own, and the one a new session starts in.
    default_agent: MORSE_AGENT,
    // Only what Morse owns is replaced; `mcp`, `plugins` and friends survive.
    providers: providersBlock(config, asRecord(file['providers']) ?? {}),
    agents: agentsBlock(config),
    instructions,
  };
  // `null` is an explicit clear; `undefined` means the caller does not know the
  // choice (a repair, a reconcile) and must not reset a working bot.
  if (config.model === null) {
    delete next['model'];
  } else if (config.model !== undefined) {
    next['model'] = `${config.model.provider}/${config.model.id}`;
  }

  if (config.mcpServers !== undefined) {
    if (config.mcpServers.length === 0) {
      delete next['mcp'];
    } else {
      const existingMcp = asRecord(file['mcp']) ?? {};
      next['mcp'] = Object.fromEntries(
        config.mcpServers.map((server) => [
          server.name,
          openCodeMcpEntry(server, existingMcp[server.name]),
        ]),
      );
    }
  }

  writeJsonAtomic(path, next);
  // No key collected means "keep the ones the engine already holds": an edit that
  // does not touch the keys must not wipe them.
  if (config.credentials.length > 0) {
    writeOpenCodeCredentials(botRoot, config.credentials);
  }
}

/**
 * The `providers` block: OpenCode's own provider entries, with the package that
 * speaks the wire protocol, the endpoint, the key and the models.
 */
function providersBlock(
  config: BotEngineConfig,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const written: Record<string, unknown> = {};
  for (const provider of config.providers) {
    written[provider.id] = openCodeProviderEntry(provider, existing[provider.id]);
  }
  return written;
}

/**
 * The providers `opencode.json` declares, as the wizard's own shape. Read back so
 * Edit bot starts from what the engine really has: `limit.context`/`limit.output`
 * are its window and response cap, `capabilities.input` its modalities.
 */
function readProviders(value: unknown): BotProviderRecord[] {
  const entries = asRecord(value) ?? {};
  return Object.entries(entries).flatMap(([id, raw]) => {
    const provider = asRecord(raw);
    if (provider === undefined) {
      return [];
    }
    const settings = asRecord(provider['settings']) ?? {};
    const models = asRecord(provider['models']) ?? {};
    const api = Object.entries(OPENCODE_PACKAGE).find(
      ([, packageName]) => packageName === asString(provider['package']),
    );
    return [
      {
        id,
        label: asString(provider['name']) ?? id,
        ...(api === undefined ? {} : { api: api[0] as BotProviderRecord['api'] }),
        ...(asString(settings['baseURL']) === undefined
          ? {}
          : { baseUrl: asString(settings['baseURL']) }),
        models: Object.entries(models).flatMap(([modelId, rawModel]) => {
          const entry = asRecord(rawModel);
          if (entry === undefined) {
            return [];
          }
          const limit = asRecord(entry['limit']) ?? {};
          const capabilities = asRecord(entry['capabilities']) ?? {};
          const input = Array.isArray(capabilities['input'])
            ? capabilities['input'].filter((one): one is ModelInput => typeof one === 'string')
            : undefined;
          const context = numberField(limit['context']);
          const output = numberField(limit['output']);
          return [
            {
              id: modelId,
              ...(asString(entry['name']) === undefined ? {} : { name: asString(entry['name']) }),
              ...(context === undefined ? {} : { contextWindow: context }),
              ...(output === undefined ? {} : { maxTokens: output }),
              ...(input === undefined ? {} : { input }),
            },
          ];
        }),
      },
    ];
  });
}

/**
 * One `providers.<id>` entry. An edit that only corrected model fields arrives
 * without a credential (Morse never reads a key back) and possibly without an
 * `api`, so whatever the file already holds is kept and only the models are
 * rewritten — a corrected context window must not cost the reader their key.
 */
export function openCodeProviderEntry(
  provider: BotProviderRecord,
  kept: unknown,
  packages: Record<string, string> = OPENCODE_PACKAGE,
): unknown {
  const existing = asRecord(kept) ?? {};
  const existingSettings = asRecord(existing['settings']) ?? {};
  const baseUrl = provider.baseUrl ?? asString(existingSettings['baseURL']);
  const apiKey =
    provider.credential === undefined
      ? asString(existingSettings['apiKey'])
      : provider.credential.kind === 'stored'
        ? provider.credential.apiKey
        : undefined;
  const env =
    provider.credential?.kind === 'env'
      ? [provider.credential.name]
      : Array.isArray(existing['env'])
        ? existing['env']
        : undefined;
  const existingModels = asRecord(existing['models']) ?? {};
  return {
    ...existing,
    name: provider.label,
    package:
      provider.api === undefined
        ? (asString(existing['package']) ?? '@ai-sdk/openai-compatible')
        : (packages[provider.api] ?? '@ai-sdk/openai-compatible'),
    ...(env === undefined ? {} : { env }),
    settings: {
      ...existingSettings,
      ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
      ...(apiKey === undefined ? {} : { apiKey }),
    },
    models: Object.fromEntries(
      provider.models.map((model) => [
        model.id,
        openCodeModelEntry(model, existingModels[model.id]),
      ]),
    ),
  };
}

/**
 * One `models.<id>` entry: the reader's corrections on top of whatever OpenCode
 * already had. `limit.context`/`limit.output` are its context window and response
 * cap, and `capabilities.input` is what says a model takes images — without it a
 * vision model is used as a text-only one.
 */
function openCodeModelEntry(model: BotProviderModel, kept: unknown): unknown {
  const existing = asRecord(kept) ?? {};
  const existingLimit = asRecord(existing['limit']) ?? {};
  const existingCapabilities = asRecord(existing['capabilities']) ?? {};
  const context = model.contextWindow ?? numberField(existingLimit['context']);
  const output = model.maxTokens ?? numberField(existingLimit['output']);
  return {
    ...existing,
    name: model.name ?? asString(existing['name']) ?? model.id,
    ...(context === undefined && output === undefined
      ? {}
      : {
          limit: {
            ...existingLimit,
            ...(context === undefined ? {} : { context }),
            ...(output === undefined ? {} : { output }),
          },
        }),
    ...(model.input === undefined
      ? {}
      : { capabilities: { ...existingCapabilities, input: [...model.input] } }),
  };
}

/**
 * The agent's `permissions` ruleset for an allowed-tool list: a blanket deny,
 * then one allow per chosen tool (`read`, `edit`, `bash`, `webfetch`, …). OpenCode
 * evaluates the rules in order, so the deny has to come first.
 */
function permissionRules(tools: readonly string[]): Record<string, unknown>[] {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...tools.map((tool) => ({ action: tool, resource: '*', effect: 'allow' })),
  ];
}

/** The one-line label OpenCode shows for an agent, which is a single row. */
const AGENT_DESCRIPTION_MAX = 80;

/**
 * `agents`: the bot itself as OpenCode's default primary agent — its `system` is
 * the persona, which replaces the provider's base prompt — plus one entry per
 * subagent the reader defined.
 */
function agentsBlock(config: BotEngineConfig): Record<string, unknown> {
  const written: Record<string, unknown> = {
    [MORSE_AGENT]: {
      mode: 'primary',
      ...(config.description.trim().length > 0 ? { description: config.description } : {}),
      system: config.persona,
      // OpenCode expresses tool access as a `permissions` ruleset on the agent:
      // deny everything, then allow the tools the reader chose. An empty list
      // leaves just the deny, which is "no tools".
      ...(config.tools === undefined ? {} : { permissions: permissionRules(config.tools) }),
    },
  };
  for (const subagent of config.subagents ?? []) {
    const firstLine = subagent.prompt.split(/\r?\n/, 1)[0]?.trim() ?? '';
    written[subagent.name] = {
      mode: 'subagent',
      description: firstLine.slice(0, AGENT_DESCRIPTION_MAX) || subagent.name,
      system: subagent.prompt,
    };
  }
  return written;
}

/**
 * The `mcp` block: OpenCode stores servers under their name, each entry carrying
 * `type: 'local' | 'remote'` and transport fields. Morse reads them back into its
 * own `BotMcpServer` shape, skipping malformed entries rather than failing the
 * whole block.
 */
function readOpenCodeMcp(value: unknown): BotMcpServer[] {
  const entries = asRecord(value) ?? {};
  return Object.entries(entries).flatMap(([name, raw]): BotMcpServer[] => {
    const entry = asRecord(raw);
    if (entry === undefined || !definesMcpServer(entry as OpenCodeMcpServer)) {
      return [];
    }
    const enabled = entry['enabled'] !== false;
    if (entry['type'] === 'local') {
      const command = entry['command'];
      if (
        !Array.isArray(command) ||
        command.length === 0 ||
        !command.every((part) => typeof part === 'string' && part.length > 0)
      ) {
        return [];
      }
      const [first, ...rest] = command as string[];
      return [
        {
          name,
          type: 'stdio' as const,
          command: first,
          ...(rest.length === 0 ? {} : { args: rest }),
          ...(entry['environment'] === undefined
            ? {}
            : { env: asStringRecord(entry['environment']) }),
          ...(entry['cwd'] === undefined ? {} : { cwd: asString(entry['cwd']) as string }),
          enabled,
        },
      ];
    }
    const url = asString(entry['url']);
    if (url === undefined) {
      return [];
    }
    return [
      {
        name,
        type: 'http' as const,
        url,
        ...(entry['headers'] === undefined
          ? {}
          : { headers: asStringRecord(entry['headers']) }),
        enabled,
      },
    ];
  });
}

/**
 * One `mcp.<name>` entry, written in OpenCode's own shape. Unknown fields from a
 * hand-edited entry survive; Morse-owned fields are replaced so the form owns the
 * transport, cwd, env and enabled state.
 */
function openCodeMcpEntry(server: BotMcpServer, kept: unknown): OpenCodeMcpServer {
  const existing = { ...(asRecord(kept) ?? {}) };
  for (const key of ['type', 'command', 'environment', 'url', 'headers', 'cwd', 'enabled']) {
    delete existing[key];
  }
  if (server.type === 'stdio') {
    return {
      ...existing,
      type: 'local',
      command: [server.command ?? '', ...(server.args ?? [])],
      ...(server.env === undefined ? {} : { environment: server.env }),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      ...(server.enabled === false ? { enabled: false } : {}),
    } as OpenCodeMcpServer;
  }
  return {
    ...existing,
    type: 'remote',
    url: server.url ?? '',
    ...(server.headers === undefined ? {} : { headers: server.headers }),
    ...(server.enabled === false ? { enabled: false } : {}),
  } as OpenCodeMcpServer;
}

/**
 * Reads the bot's OpenCode configuration back into the wizard's own vocabulary,
 * so Edit bot shows what the engine actually holds rather than a copy.
 */
export const openCodeBotLayout: BotEngineLayout = {
  write: writeOpenCodeBotConfig,
  read(botRoot: string): BotEngineState {
    const file = readOpenCodeFile(openCodeConfigPath(botRoot));
    const model = readModel(file['model']);
    const agentsMd = readText(openCodeWorkspacePath(botRoot));
    const agents = asRecord(file['agents']) ?? asRecord(file['agent']) ?? {};
    // The persona is the system prompt of the agent a session starts in.
    const defaultAgent =
      typeof file['default_agent'] === 'string' ? file['default_agent'] : MORSE_AGENT;
    const own = asRecord(agents[defaultAgent]) ?? asRecord(agents[MORSE_AGENT]) ?? {};
    const persona = typeof own['system'] === 'string' ? own['system'] : undefined;
    // Read the allowlist back out of the ruleset: every explicit allow, in order.
    const rules = Array.isArray(own['permissions']) ? (own['permissions'] as unknown[]) : undefined;
    const tools = rules?.flatMap((rule) => {
      const record = asRecord(rule) ?? {};
      const action = record['action'];
      return record['effect'] === 'allow' && typeof action === 'string' ? [action] : [];
    });
    const subagents = Object.entries(agents)
      .filter(([name, entry]) => name !== defaultAgent && asRecord(entry)?.['mode'] === 'subagent')
      .map(([name, entry]) => {
        const record = asRecord(entry) ?? {};
        const prompt = typeof record['system'] === 'string' ? record['system'] : '';
        return { name, prompt };
      });
    const providers = readProviders(file['providers']);
    const mcpServers = readOpenCodeMcp(file['mcp']);
    return {
      ...(model === undefined ? {} : { model }),
      ...(providers.length === 0 ? {} : { providers }),
      ...(tools === undefined ? {} : { tools }),
      ...(persona === undefined ? {} : { persona }),
      ...(agentsMd === undefined ? {} : { agentsMd }),
      ...(subagents.length === 0 ? {} : { subagents }),
      mcpServers,
    };
  },
  /**
   * Moves the subagent block an earlier Morse wrote under OpenCode's deprecated
   * singular `agent` key — with `prompt` — to the current `agents` key with the
   * `system` field OpenCode reads today. Without this, a bot created by that
   * release looks like it has no subagents at all, because the config is valid
   * but the shape is obsolete.
   */
  repair(botRoot: string): void {
    const path = openCodeConfigPath(botRoot);
    const file = readOpenCodeFile(path);
    // 1. A persona an earlier Morse wrote to its own instruction file: fold it
    //    into the agent's `system`, which is the field that replaces OpenCode's
    //    base prompt, and drop the file so it is not also appended as context.
    const legacyPersonaPath = openCodeLegacyPersonaPath(botRoot);
    const legacyPersona = readText(legacyPersonaPath);
    if (legacyPersona !== undefined) {
      const agents = asRecord(file['agents']) ?? asRecord(file['agent']) ?? {};
      const own = asRecord(agents[MORSE_AGENT]) ?? {};
      const nextAgents: Record<string, unknown> = {
        ...agents,
        [MORSE_AGENT]: {
          mode: 'primary',
          ...(typeof own['description'] === 'string' ? { description: own['description'] } : {}),
          ...(typeof own['system'] === 'string' && own['system'].length > 0
            ? { system: own['system'] }
            : { system: legacyPersona }),
        },
      };
      const instructions = Array.isArray(file['instructions'])
        ? (file['instructions'] as unknown[]).filter(
            (entry) => typeof entry !== 'string' || entry !== legacyPersonaPath,
          )
        : [];
      file['agents'] = nextAgents;
      file['default_agent'] = MORSE_AGENT;
      file['instructions'] = instructions;
      delete file['agent'];
      writeJsonAtomic(path, file);
      rmSync(legacyPersonaPath, { force: true });
      rmSync(join(botRoot, 'config', 'opencode', 'instructions'), { recursive: true, force: true });
      return;
    }
    const legacy = asRecord(file['agent']);
    if (legacy === undefined) {
      return;
    }
    const current = asRecord(file['agents']) ?? {};
    const merged: Record<string, unknown> = { ...current };
    for (const [name, entry] of Object.entries(legacy)) {
      if (merged[name] !== undefined) {
        continue;
      }
      const record = asRecord(entry) ?? {};
      const prompt =
        typeof record['system'] === 'string'
          ? record['system']
          : typeof record['prompt'] === 'string'
            ? record['prompt']
            : '';
      merged[name] = {
        ...(record['mode'] === 'subagent' ||
        record['mode'] === 'primary' ||
        record['mode'] === 'all'
          ? { mode: record['mode'] }
          : { mode: 'subagent' }),
        ...(typeof record['description'] === 'string'
          ? { description: record['description'] }
          : {}),
        system: prompt,
      };
    }
    const next: Record<string, unknown> = { ...file, agents: merged };
    delete next['agent'];
    writeJsonAtomic(path, next);
  },
};

/** `provider/model`, the string form OpenCode's `model` key uses. */
function readModel(value: unknown): { provider: string; id: string; name: string } | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const [provider, id] = value.split('/');
  if (provider === undefined || id === undefined || id.length === 0) {
    return undefined;
  }
  return { provider, id, name: id };
}

/** A file's text, or undefined when it is absent: an absent file is "" not an error. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'string') {
      result[key] = val;
    }
  }
  return result;
}

function writePrivateText(path: string, text: string): void {
  writeJsonAtomicText(path, text.endsWith('\n') ? text : `${text}\n`);
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeJsonAtomicText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Temp file beside the target, then rename: never a half-written config. */
function writeJsonAtomicText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch {
    writeFileSync(path, text, { mode: 0o600 });
  }
}
