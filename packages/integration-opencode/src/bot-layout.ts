import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ModelInput, ThinkingLevel } from '@morse/agent';
import type { ConfigDocument, EngineInstance } from '@morse/engine-config';
import type {
  BotEngineConfig,
  BotEngineLayout,
  BotEngineState,
  BotProviderModel,
  BotProviderRecord,
} from '@morse/system';
import { BOT_BUS_INSTRUCTION, BOT_BUS_INSTRUCTION_FILE, readText } from '@morse/system';
import { asNonEmptyString, asNumber, asRecord } from './internal/guards.js';
import { OpenCodeEngineDefinition } from './engine/open-code-engine.js';
import { writeOpenCodeCredentials } from './bot-engine.js';
import {
  isOpenCodeBusPlugin,
  openCodeBusPluginPath,
  writeOpenCodeBusPlugin,
} from './bot-bus-plugin.js';
import { writeBotUserSpacePlugin } from './bot-user-space.js';

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
 * - `<botRoot>/config/opencode/instructions/morse-bot-bus.md` — Morse's own
 *   instruction about working with other bots, named by the bot agent's
 *   `instructions[]`. It is not the persona and not the reader's text, so a
 *   persona edit cannot erase it.
 * - `<botRoot>/sessions/opencode/auth.json` — the keys, in OpenCode's own auth
 *   store inside the bot's data dir (its `XDG_DATA_HOME` is `<botRoot>/sessions`).
 * - `<botRoot>/config/opencode/plugins/morse-user-space.ts` — the plugin that
 *   hands the host's real XDG roots back to the shell commands a bot runs, and
 *   to nothing else (see `bot-user-space.ts`).
 * - `<botRoot>/config/opencode/plugins/morse-bot-bus.ts` — the plugin that gives
 *   a bot `bot_list` and `bot_send`, the tools Morse's bot-bus instruction names
 *   (see `bot-bus-plugin.ts`). Both plugins live in that directory because
 *   OpenCode discovers direct files there; neither is named in `opencode.json`,
 *   where a bare file path would be skipped.
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

/**
 * The plain-JSON file Morse gives a bot's OpenCode server. The isolated engine
 * reads an `opencode.jsonc` beside it — and writes that file — when one exists,
 * so a tree with no `jsonc` uses exactly this path.
 */
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
 * Morse's own instruction about the bot bus, as a file the bot agent names in
 * `instructions[]`. Absolute by construction: OpenCode reads it from the bot's
 * config tree, and a relative name would depend on the directory its server runs
 * in.
 */
export function openCodeInstructionPath(botRoot: string): string {
  return join(botRoot, 'config', 'opencode', 'instructions', BOT_BUS_INSTRUCTION_FILE);
}

/**
 * An agent's `instructions` list with Morse's file in it.
 *
 * Entries already on the agent are kept — a reader may name their own notes — and
 * Morse's is matched by basename, so a rewrite cannot leave two names for the
 * same instruction, and a tree that moved gets its new path rather than both.
 */
function instructionEntries(existing: unknown, path: string): string[] {
  const name = basename(path);
  const kept = (Array.isArray(existing) ? existing : []).filter(
    (entry): entry is string => typeof entry === 'string' && basename(entry) !== name,
  );
  return [...kept, path];
}

/**
 * Writes a bot's whole OpenCode configuration.
 *
 * The file is merged, not replaced: MCP servers, plugins and any key the reader
 * hand-added survive (an edit through the wizard owns only what the wizard
 * shows). Everything Morse manages is written fresh, so removing a provider or
 * a subagent in the form removes it from the file.
 *
 * The document is read once, with the bot's own tree opened as the isolated
 * engine Morse generated it as: the MCP block is applied to that document by the
 * shared store and everything else is composed onto it, so one save is one write
 * of one file. A config that cannot be read or parsed aborts before anything —
 * the workspace document included — is written, because a save must not replace
 * a file whose other keys it could not carry over.
 */
export function writeOpenCodeBotConfig(botRoot: string, config: BotEngineConfig): void {
  const engine = botInstance(botRoot);
  const document = engine.file('config', 'global').read();
  const file = configObject(document);

  // `mcpServers` is tri-state: absent leaves the block as the reader left it,
  // `[]` removes it, and a list replaces the managed set. The store applies it
  // to the document that was just read, so the write below is the only one.
  let base = file;
  if (config.mcpServers !== undefined) {
    const applied = engine.mcp!.apply(document, config.mcpServers);
    const issue = applied.issues[0];
    if (issue !== undefined) {
      throw new Error(issue.message);
    }
    base = asRecord(applied.value) ?? {};
  }

  // The bot's shell needs the reader's real XDG roots — Podman state, SSH keys,
  // a checkout — while the server above keeps reading its own. Installed before
  // the workspace document: a failed plugin write must not leave AGENTS.md changed.
  writeBotUserSpacePlugin(botRoot);

  // The bot-bus tools, beside the shell plugin in the directory OpenCode
  // discovers. No `plugins` entry is written: a bare file path there is skipped,
  // and a reader's own entries are theirs to keep.
  writeOpenCodeBusPlugin(botRoot);

  // The workspace document is the project's instructions; the persona is the
  // agent's system prompt, below. OpenCode discovers AGENTS.md from the project
  // root on its own, and naming it here keeps its role explicit. It is written
  // only once the config is known to be readable, so a save that aborts leaves
  // no half-applied bot behind.
  const instructions: string[] = [];
  if ((config.agentsMd ?? '').trim().length > 0) {
    writePrivateText(openCodeWorkspacePath(botRoot), config.agentsMd as string);
    instructions.push(openCodeWorkspacePath(botRoot));
  }

  // Morse's bot-bus instruction: a file of its own, named on the bot agent. It is
  // not named at the top level, where the workspace document lives, because it
  // belongs to the agent rather than to the project.
  const instructionPath = openCodeInstructionPath(botRoot);
  writePrivateText(instructionPath, BOT_BUS_INSTRUCTION);

  const next: Record<string, unknown> = {
    ...base,
    $schema: CONFIG_SCHEMA,
    // OpenCode's own display-name field: what a person sees in its UI.
    username: config.name,
    // The bot is an agent of its own, and the one a new session starts in.
    default_agent: MORSE_AGENT,
    // Only what Morse owns is replaced; `plugins` and friends survive.
    providers: providersBlock(config, asRecord(file['providers']) ?? {}),
    agents: agentsBlock(config, base['agents'], instructionPath),
    instructions,
  };
  // `null` is an explicit clear; `undefined` means the caller does not know the
  // choice (a repair, a reconcile) and must not reset a working bot.
  if (config.model === null) {
    delete next['model'];
  } else if (config.model !== undefined) {
    next['model'] = `${config.model.provider}/${config.model.id}`;
  }

  writeJsonAtomic(document.path, next);
  // No key collected means "keep the ones the engine already holds": an edit that
  // does not touch the keys must not wipe them.
  if (config.credentials.length > 0) {
    writeOpenCodeCredentials(botRoot, config.credentials);
  }
}

/**
 * The bot's OpenCode tree, opened as the isolated tree it is: the engine that
 * reads it is the one the bot's server reads, so a save lands where OpenCode
 * looks and a file Morse creates stays private (`0600`).
 */
function botInstance(botRoot: string): EngineInstance {
  return new OpenCodeEngineDefinition().isolated(join(botRoot, 'config'));
}

/**
 * The document's own object, or a throw when the file could not be read, parsed
 * or represented. Every caller of this module writes this file, so the guard is
 * kept here rather than repeated at each call site.
 */
function configObject(document: ConfigDocument): Record<string, unknown> {
  const blocking = document.issues.find((issue) => issue.code === 'parse' || issue.code === 'read');
  if (blocking !== undefined) {
    throw new Error(blocking.message);
  }
  const file = asRecord(document.value);
  if (file === undefined && document.value !== undefined) {
    throw new Error(`${document.path} is not a JSON object.`);
  }
  return file ?? {};
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
      ([, packageName]) => packageName === asNonEmptyString(provider['package']),
    );
    return [
      {
        id,
        label: asNonEmptyString(provider['name']) ?? id,
        ...(api === undefined ? {} : { api: api[0] as BotProviderRecord['api'] }),
        ...(asNonEmptyString(settings['baseURL']) === undefined
          ? {}
          : { baseUrl: asNonEmptyString(settings['baseURL']) }),
        models: Object.entries(models).flatMap(([modelId, rawModel]) => {
          const entry = asRecord(rawModel);
          if (entry === undefined) {
            return [];
          }
          const limit = asRecord(entry['limit']) ?? {};
          const capabilities = asRecord(entry['capabilities']) ?? {};
          const modalities = asRecord(entry['modalities']) ?? capabilities;
          const input = Array.isArray(modalities['input'])
            ? modalities['input'].filter((one): one is ModelInput => typeof one === 'string')
            : undefined;
          const context = asNumber(limit['context']);
          const output = asNumber(limit['output']);
          const variants = Array.isArray(entry['variants'])
            ? entry['variants'].flatMap((variant) => {
                const v = asRecord(variant) ?? {};
                const id = v['id'];
                return typeof id === 'string' ? [id as ThinkingLevel] : [];
              })
            : undefined;
          return [
            {
              id: modelId,
              ...(asNonEmptyString(entry['name']) === undefined
                ? {}
                : { name: asNonEmptyString(entry['name']) }),
              ...(context === undefined ? {} : { contextWindow: context }),
              ...(output === undefined ? {} : { maxTokens: output }),
              ...(input === undefined ? {} : { input }),
              ...(typeof entry['reasoning'] === 'boolean' ? { reasoning: entry['reasoning'] } : {}),
              ...(variants === undefined || variants.length === 0 ? {} : { thinkingLevels: variants }),
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
  const baseUrl = provider.baseUrl ?? asNonEmptyString(existingSettings['baseURL']);
  const apiKey =
    provider.credential === undefined
      ? asNonEmptyString(existingSettings['apiKey'])
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
        ? (asNonEmptyString(existing['package']) ?? '@ai-sdk/openai-compatible')
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
  const existingModalities = asRecord(existing['modalities']) ?? {};
  const context = model.contextWindow ?? asNumber(existingLimit['context']);
  const output = model.maxTokens ?? asNumber(existingLimit['output']);
  const variants = model.thinkingLevels ??
    (Array.isArray(existing['variants'])
      ? existing['variants'].flatMap((variant) => {
          const v = asRecord(variant) ?? {};
          return typeof v['id'] === 'string' ? [v['id']] : [];
        })
      : undefined);
  return {
    ...existing,
    name: model.name ?? asNonEmptyString(existing['name']) ?? model.id,
    ...(context === undefined && output === undefined
      ? {}
      : {
          limit: {
            ...existingLimit,
            ...(context === undefined ? {} : { context }),
            ...(output === undefined ? {} : { output }),
          },
        }),
    ...(model.input === undefined &&
    asRecord(existing['modalities']) === undefined &&
    asRecord(existing['capabilities']) === undefined
      ? {}
      : {
          // Native schema is `modalities`; keep a legacy `capabilities` read
          // working by writing both when the file already uses it.
          ...(asRecord(existing['modalities']) !== undefined ||
          asRecord(existing['capabilities']) === undefined
            ? {
                modalities: {
                  ...existingModalities,
                  ...(model.input === undefined ? {} : { input: [...model.input] }),
                },
              }
            : {}),
          ...(asRecord(existing['capabilities']) !== undefined
            ? {
                capabilities: {
                  ...existingCapabilities,
                  ...(model.input === undefined ? {} : { input: [...model.input] }),
                },
              }
            : {}),
        }),
    ...(model.reasoning === undefined && typeof existing['reasoning'] !== 'boolean'
      ? {}
      : {
          reasoning:
            model.reasoning ?? (existing['reasoning'] === true),
        }),
    ...(variants === undefined || variants.length === 0
      ? {}
      : { variants: variants.map((level) => ({ id: level })) }),
  };
}

/**
 * The wizard's tool ids, as OpenCode 2 names the permission actions it checks.
 *
 * The wizard keeps Morse's own vocabulary — the same ids pi's tool list uses —
 * while OpenCode gates a call by an action: a tool it renamed must be allowed
 * under the new name or the ruleset denies a tool the reader chose. `write` and
 * `patch` both edit files, so both land on `edit`.
 */
const TOOL_ACTION_RENAMES: Record<string, string> = {
  bash: 'shell',
  task: 'subagent',
  write: 'edit',
  patch: 'edit',
};

/** A wizard tool with no permission action of its own to allow. */
const DROPPED_TOOL_ACTIONS = new Set(['list']);

/**
 * Actions that reach beyond the bot's own tree. OpenCode checks
 * `external_directory` separately from the tool it is called by, so a bot whose
 * reader chose a file tool has to be allowed that action too — otherwise `read`
 * is allowed and every path outside the workspace still asks.
 */
const FILE_TOOL_ACTIONS = new Set(['read', 'edit', 'glob', 'grep']);

/** One wizard tool as the action OpenCode gates it by, or none. */
function actionFor(tool: string): string | undefined {
  if (tool === '*' || DROPPED_TOOL_ACTIONS.has(tool)) {
    return undefined;
  }
  return TOOL_ACTION_RENAMES[tool] ?? tool;
}

/**
 * The agent's `permissions` ruleset for an allowed-tool list: a blanket deny,
 * then one allow per chosen tool's action (`read`, `edit`, `shell`, …), and
 * `external_directory` when a file tool was chosen. OpenCode evaluates the rules
 * in order and the last match wins, so the deny comes first and every allow
 * after it; one allow per action keeps a renamed pair (`write`, `patch`) from
 * writing the same rule twice.
 */
function permissionRules(tools: readonly string[]): Record<string, unknown>[] {
  const actions = new Set(tools.flatMap((tool) => actionFor(tool) ?? []));
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...[...actions].map((action) => ({ action, resource: '*', effect: 'allow' })),
    ...([...actions].some((action) => FILE_TOOL_ACTIONS.has(action))
      ? [{ action: 'external_directory', resource: '*', effect: 'allow' }]
      : []),
  ];
}

/** The first rule of every ruleset Morse generates: a blanket deny. */
const GENERATED_FIRST_RULE: Record<string, unknown> = {
  action: '*',
  resource: '*',
  effect: 'deny',
};

/**
 * Whether a ruleset is one Morse generated, rather than one a reader wrote: its
 * first rule is the blanket deny, with exactly the keys Morse writes. An extra
 * key on that rule is a reader's own field, and a repair must leave alone what
 * it did not write.
 */
function isGeneratedRuleset(rules: readonly unknown[]): boolean {
  const first = asRecord(rules[0]);
  if (first === undefined) {
    return false;
  }
  const keys = Object.keys(first);
  return (
    keys.length === Object.keys(GENERATED_FIRST_RULE).length &&
    keys.every((key) => first[key] === GENERATED_FIRST_RULE[key])
  );
}

/**
 * The ruleset of a config an earlier Morse wrote, in today's actions.
 *
 * The wizard's tool vocabulary was written straight through as permission
 * actions before OpenCode 2 renamed them, so a bot from that release allows
 * `bash` while its engine checks `shell` — every shell call is denied. The
 * translation is the same map the writer uses, plus `external_directory` for a
 * file tool, which that release never emitted. Nothing else is touched, and a
 * ruleset that already reads correctly comes back byte-identical.
 */
function migrateRules(rules: readonly unknown[]): unknown[] {
  const translated: unknown[] = [];
  const seen = new Set<string>();
  // A rename can make two rules identical (`write` and `patch` both edit), so
  // the ruleset is de-duplicated after translation rather than before.
  const add = (rule: unknown): void => {
    const key = JSON.stringify(rule);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    translated.push(rule);
  };
  for (const rule of rules) {
    const record = asRecord(rule);
    const action = record?.['action'];
    if (record === undefined || typeof action !== 'string') {
      // A rule that names no action is not one Morse wrote; it is kept as it is.
      add(rule);
      continue;
    }
    if (!DROPPED_TOOL_ACTIONS.has(action)) {
      add({ ...record, action: TOOL_ACTION_RENAMES[action] ?? action });
    }
  }
  const allowsFileTool = translated.some((rule) => {
    const record = asRecord(rule);
    const action = record?.['action'];
    return (
      record?.['effect'] === 'allow' && typeof action === 'string' && FILE_TOOL_ACTIONS.has(action)
    );
  });
  const allowsExternal = translated.some(
    (rule) => asRecord(rule)?.['action'] === 'external_directory',
  );
  if (allowsFileTool && !allowsExternal) {
    translated.push({ action: 'external_directory', resource: '*', effect: 'allow' });
  }
  return translated;
}

/**
 * Translates the default agent's ruleset in place, and says whether it changed
 * anything. Only a ruleset Morse generated (its first rule is the blanket deny)
 * is rewritten; one a reader wrote by hand is left exactly as it is.
 */
function migratePermissions(file: Record<string, unknown>): boolean {
  const agents = asRecord(file['agents']);
  const agent = typeof file['default_agent'] === 'string' ? file['default_agent'] : MORSE_AGENT;
  const own = asRecord(agents?.[agent]);
  if (own === undefined) {
    return false;
  }
  const rules = own['permissions'];
  if (!Array.isArray(rules) || !isGeneratedRuleset(rules)) {
    return false;
  }
  const next = migrateRules(rules);
  if (JSON.stringify(next) === JSON.stringify(rules)) {
    return false;
  }
  own['permissions'] = next;
  return true;
}

/** The one-line label OpenCode shows for an agent, which is a single row. */
const AGENT_DESCRIPTION_MAX = 80;

/**
 * `agents`: the bot itself as OpenCode's default primary agent — its `system` is
 * the persona, which replaces the provider's base prompt — plus one entry per
 * subagent the reader defined.
 *
 * The bot agent also carries Morse's bot-bus instruction in `instructions[]`.
 * That list is the agent's, not the file's: the workspace document stays at the
 * top level, and anything the reader already put on the agent is kept.
 */
function agentsBlock(
  config: BotEngineConfig,
  existing: unknown,
  instructionPath: string,
): Record<string, unknown> {
  const own = asRecord(asRecord(existing)?.[MORSE_AGENT]);
  const written: Record<string, unknown> = {
    [MORSE_AGENT]: {
      mode: 'primary',
      ...(config.description.trim().length > 0 ? { description: config.description } : {}),
      system: config.persona,
      instructions: instructionEntries(own?.['instructions'], instructionPath),
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
 * An agent entry from an earlier layout, without the deprecated `prompt`: it is
 * folded into `system` and must not linger beside it in the current shape.
 */
function withoutDeprecatedPrompt(entry: Record<string, unknown>): Record<string, unknown> {
  const carried = { ...entry };
  delete carried['prompt'];
  return carried;
}

/**
 * Reads the bot's OpenCode configuration back into the wizard's own vocabulary,
 * so Edit bot shows what the engine actually holds rather than a copy.
 */
export const openCodeBotLayout: BotEngineLayout = {
  write: writeOpenCodeBotConfig,
  read(botRoot: string): BotEngineState {
    const engine = botInstance(botRoot);
    const document = engine.file('config', 'global').read();
    const file = configObject(document);
    const model = readModel(file['model']);
    const agentsMd = readText(openCodeWorkspacePath(botRoot));
    const agents = asRecord(file['agents']) ?? asRecord(file['agent']) ?? {};
    // The persona is the system prompt of the agent a session starts in.
    const defaultAgent =
      typeof file['default_agent'] === 'string' ? file['default_agent'] : MORSE_AGENT;
    const own = asRecord(agents[defaultAgent]) ?? asRecord(agents[MORSE_AGENT]) ?? {};
    const persona = typeof own['system'] === 'string' ? own['system'] : undefined;
    // Read the allowlist back out of the ruleset, in the wizard's own vocabulary:
    // every allow, translated from the action it was written as. A config an
    // earlier Morse wrote still says `bash`, and `external_directory` is an
    // action rather than a tool, so it must never come back as one.
    const rules = Array.isArray(own['permissions']) ? (own['permissions'] as unknown[]) : undefined;
    const allowed = rules?.flatMap((rule) => {
      const record = asRecord(rule) ?? {};
      const action = record['action'];
      if (
        record['effect'] !== 'allow' ||
        typeof action !== 'string' ||
        action === 'external_directory'
      ) {
        return [];
      }
      const tool = actionFor(action);
      return tool === undefined ? [] : [tool];
    });
    const tools = allowed === undefined ? undefined : [...new Set(allowed)];
    const subagents = Object.entries(agents)
      .filter(([name, entry]) => name !== defaultAgent && asRecord(entry)?.['mode'] === 'subagent')
      .map(([name, entry]) => {
        const record = asRecord(entry) ?? {};
        const prompt = typeof record['system'] === 'string' ? record['system'] : '';
        return { name, prompt };
      });
    const providers = readProviders(file['providers']);
    // The shared store reads the block, so an entry is decoded exactly as the
    // engine decodes it; an absent block lists as the empty set the form shows.
    const mcpServers = engine.mcp!.list().items.map((entry) => entry.server);
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
   * Brings a bot an earlier Morse wrote up to today's layout, in one pass and
   * one write:
   *
   * - the persona an earlier release kept in an instruction file is folded into
   *   the agent's `system`, where it replaces OpenCode's base prompt instead of
   *   being appended as context, and the file is removed;
   * - the subagents that release put under OpenCode's deprecated singular
   *   `agent` key move to `agents` with the `system` field OpenCode reads today;
   * - a ruleset it generated with the wizard's tool names is translated to the
   *   permission actions OpenCode 2 checks, so `bash` becomes `shell` and a file
   *   tool also gets `external_directory`;
   * - the bot-bus instruction is written and named on the bot agent, so a bot
   *   from before the habit existed gets it without a trip through the wizard;
   * - the user-space shell plugin is installed, which is what lets a bot's
   *   commands reach the reader's real XDG roots.
   *
   * A config with nothing to migrate is not rewritten; the plugins are, because
   * rewriting the same source is harmless and their absence is exactly what a bot
   * from before they existed has.
   */
  repair(botRoot: string): void {
    const engine = botInstance(botRoot);
    const document = engine.file('config', 'global').read();
    const path = document.path;
    const file = configObject(document);
    // 1. A persona an earlier Morse wrote to its own instruction file: fold it
    //    into the agent's `system`, which is the field that replaces OpenCode's
    //    base prompt, and drop the file so it is not also appended as context.
    const legacyPersonaPath = openCodeLegacyPersonaPath(botRoot);
    const legacyPersona = readText(legacyPersonaPath);
    let changed = false;
    if (legacyPersona !== undefined) {
      const agents = asRecord(file['agents']) ?? asRecord(file['agent']) ?? {};
      const own = asRecord(agents[MORSE_AGENT]) ?? {};
      const nextAgents: Record<string, unknown> = {
        ...agents,
        // The whole entry is carried over, not rebuilt: `permissions` and any key
        // a reader added survive, and the step below can still translate the
        // ruleset. Rebuilding it here would silently drop the tool restrictions.
        [MORSE_AGENT]: {
          ...withoutDeprecatedPrompt(own),
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
      changed = true;
    } else {
      // 2. Otherwise the deprecated `agent` key: merge it into `agents`.
      const legacy = asRecord(file['agent']);
      if (legacy !== undefined) {
        const current = asRecord(file['agents']) ?? {};
        const merged: Record<string, unknown> = { ...current };
        for (const [name, entry] of Object.entries(legacy)) {
          if (merged[name] !== undefined) {
            continue;
          }
          const record = asRecord(entry) ?? {};
          // The entry is carried over whole — a `permissions` array, a `model`,
          // anything a reader added — so the ruleset can still be translated.
          const carried = withoutDeprecatedPrompt(record);
          const prompt =
            typeof record['system'] === 'string'
              ? record['system']
              : typeof record['prompt'] === 'string'
                ? record['prompt']
                : '';
          merged[name] = {
            ...carried,
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
        file['agents'] = merged;
        delete file['agent'];
        changed = true;
      }
    }
    // 3. The generated ruleset, in the actions OpenCode 2 checks. Read after the
    //    migrations above: folding the persona can have set `default_agent`.
    if (migratePermissions(file)) {
      changed = true;
    }
    // 4. Morse's bot-bus instruction: the file is Morse's, so a missing or edited
    //    copy is rewritten, and the bot agent names it. The agent entry is only
    //    touched when it already exists: a repair must not invent an agent with
    //    no persona, mode or ruleset.
    const instructionPath = openCodeInstructionPath(botRoot);
    if (readText(instructionPath) !== `${BOT_BUS_INSTRUCTION}\n`) {
      writePrivateText(instructionPath, BOT_BUS_INSTRUCTION);
    }
    const ownAgent = asRecord(asRecord(file['agents'])?.[MORSE_AGENT]);
    if (ownAgent !== undefined) {
      const current = ownAgent['instructions'];
      const next = instructionEntries(current, instructionPath);
      if (JSON.stringify(current) !== JSON.stringify(next)) {
        ownAgent['instructions'] = next;
        changed = true;
      }
    }
    // 5. The plugins, whether or not the config needed a migration. The shell
    //    plugin is rewritten unconditionally; the bus plugin only when the file is
    //    missing or is not this code's version, because that is the only case in
    //    which a rewrite would change anything.
    writeBotUserSpacePlugin(botRoot);
    if (!isOpenCodeBusPlugin(readText(openCodeBusPluginPath(botRoot)))) {
      writeOpenCodeBusPlugin(botRoot);
    }
    // 6. One write for everything above.
    if (changed) {
      writeJsonAtomic(path, file);
    }
    // 7. Only once the folded persona is in the config may its old file go. The
    //    directory stays: it also holds Morse's bot-bus instruction, which this
    //    pass may have just written.
    if (legacyPersona !== undefined) {
      rmSync(legacyPersonaPath, { force: true });
    }
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
