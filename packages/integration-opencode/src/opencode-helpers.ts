/**
 * OpenCode's pure mappings: a session record into Morse's state, and the
 * command catalog read from the server plus the files Morse expands itself.
 */
import type {
  AgentCommand,
  AgentMode,
  AgentSessionState,
  ModelRef,
  WorkspaceRef,
} from '@morse/agent';
import type { MorseLogger } from '@morse/system';
import { baseName } from '@morse/system';
import type { OpenCodeApi } from './internal/client.js';
import { defaultModeId, readDefaultModel, type AgentCatalog } from './internal/catalog.js';
import { toTokenUsage } from './internal/event-mapping.js';
import {
  thinkingLevelOf,
  thinkingLevelsOf,
  toModelRef,
  toModelRefs,
  type ApiModel,
} from './internal/model-mapping.js';
import { listCommands, parseCommandFile } from './internal/opencode-prompts-config.js';

/** The `Session.Info` fields this adapter reads. */
export interface ApiSessionInfo {
  id: string;
  title?: string;
  /** The server's own version (`1.19.6`, `2.4.2`, …); only the list carries it. */
  version?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  cost?: number;
  tokens?: unknown;
  outcome?: string;
  time?: {
    created?: number;
    updated?: number;
    /** When the session last became busy; a session still running has this and no later `idle`. */
    busy?: number;
    idle?: number;
    viewed?: number;
    archived?: number;
  };
  location?: { directory?: string };
  /** Set when this session was forked from another, with the engine id it came from. */
  fork?: { sessionID?: string; boundary?: unknown };
  /**
   * Set when this session was spawned by a `task` tool call from another
   * session — a subagent child. Several children can share one parent (parallel
   * delegation), and each carries the same `parentID`. A fork does not set this:
   * `fork.sessionID` marks a branched conversation, which stays a normal session.
   */
  parentID?: string;
}

interface ApiCommand {
  name?: string;
  description?: string;
}

interface ApiSkill {
  id?: string;
  name?: string;
  description?: string;
}

/**
 * Which OpenCode wire the server speaks, from its version string. 1.x wraps a
 * prompt in `{prompt}`, lists forms as `questions`, and streams `message.*`
 * events; 2.x sends a bare `{text}`, `form.*`, and `session.execution.*`.
 * Unknown (or absent) versions stay on the 2.x wire: that is today's behavior,
 * so a server that hides its version changes nothing.
 */
export function engineMajorOf(version: unknown): 1 | 2 {
  if (typeof version === 'string') {
    const major = version.trim().replace(/^v/i, '').split('.')[0];
    if (major === '1') {
      return 1;
    }
  }
  return 2;
}

/**
 * Whether the server's record says the session is mid-run: a `time.busy` that
 * no later `time.idle` has cancelled. Undefined for a record without a busy
 * time (a server that does not write one), so nothing is assumed from it.
 */
export function sessionBusy(session: ApiSessionInfo | undefined): boolean | undefined {
  const busy = session?.time?.busy;
  if (busy === undefined) {
    return undefined;
  }
  const idle = session?.time?.idle;
  return idle === undefined || busy >= idle;
}

export function initialStateOf(
  session: ApiSessionInfo,
  workspace: WorkspaceRef,
  models: readonly ApiModel[],
  commands: readonly AgentCommand[],
  modes: readonly AgentMode[],
  fallbackModel?: ApiModel,
): AgentSessionState {
  const apiModel =
    session.model === undefined
      ? fallbackModel
      : models.find(
          (model) =>
            model.providerID === session.model?.providerID && model.id === session.model?.id,
        );
  const model =
    apiModel !== undefined
      ? toModelRef(apiModel)
      : session.model === undefined
        ? undefined
        : modelRefOf(session.model);
  const usage = toTokenUsage(session.tokens);
  const directory = session.location?.directory;
  // A session created without an agent has none on its record until the first
  // prompt; report the default the configuration resolves so the picker has a
  // current choice. A session that already names one keeps it even if the
  // configuration no longer lists it.
  const mode = session.agent ?? defaultModeId(modes);
  return {
    sessionId: session.id,
    ...(session.title === undefined ? {} : { sessionTitle: session.title }),
    workspace: {
      cwd: directory === undefined || directory.length === 0 ? workspace.cwd : directory,
      name:
        directory === undefined || directory.length === 0 ? workspace.name : baseName(directory),
    },
    ...(model === undefined ? {} : { model }),
    thinkingLevel: thinkingLevelOf(apiModel, session.model?.variant),
    availableModels: toModelRefs(models),
    availableThinkingLevels: thinkingLevelsOf(apiModel),
    availableCommands: [...commands],
    ...(mode === undefined ? {} : { mode }),
    ...(modes.length === 0 ? {} : { availableModes: [...modes] }),
    // OpenCode's subagents run in the background, so a child is often opened
    // while it is still working: its record says so, and the spinner follows.
    streaming: sessionBusy(session) === true,
    ...(usage === undefined ? {} : { usage }),
    ...(typeof session.cost === 'number' && Number.isFinite(session.cost)
      ? { costUsd: session.cost }
      : {}),
  };
}

/**
 * The model a session with no recorded one would use: the agent's configured
 * model when that model is in the catalog, else the server's own default.
 *
 * `/model/default` is read only when the agent's model cannot be resolved, and a
 * model no catalog knows stays undefined rather than naming one that will not
 * serve.
 */
export async function resolveFallbackModel(
  api: OpenCodeApi,
  directory: string,
  logger: MorseLogger,
  models: readonly ApiModel[],
  catalog: AgentCatalog,
  mode: string | undefined,
): Promise<ApiModel | undefined> {
  const agentModel = mode === undefined ? undefined : catalog.models.get(mode);
  const configured =
    agentModel === undefined
      ? undefined
      : models.find(
          (model) => model.providerID === agentModel.providerID && model.id === agentModel.id,
        );
  return configured ?? (await readDefaultModel(api, directory, logger));
}

function modelRefOf(model: ApiSessionInfo['model']): ModelRef | undefined {
  if (model?.id === undefined || model.providerID === undefined) {
    return undefined;
  }
  return { provider: model.providerID, id: model.id, name: model.id };
}

/** The composer's palette, and whether both source catalogs answered. */
export interface CommandCatalog {
  commands: AgentCommand[];
  /**
   * True when the command and skill reads both answered. A refresh uses it to
   * keep the last good palette instead of replacing it with a failed read's
   * half-answer.
   */
  complete: boolean;
}

/** The composer's palette: OpenCode commands (prompt templates) and skills. */
export async function readAvailableCommands(
  api: OpenCodeApi,
  directory: string,
  logger: MorseLogger,
  configDir?: string,
): Promise<AgentCommand[]> {
  const { commands } = await readCommandCatalog(api, directory, logger, configDir);
  return commands;
}

/**
 * The same palette, plus whether both catalogs answered: a refresh must be able
 * to tell "this configuration has no commands" from "the read failed".
 */
export async function readCommandCatalog(
  api: OpenCodeApi,
  directory: string,
  logger: MorseLogger,
  configDir?: string,
): Promise<CommandCatalog> {
  // The project travels as `location[directory]`, the same way the agent catalog
  // asks for it: a plain `directory` query param is ignored, and the server would
  // answer for its own working directory instead.
  let complete = true;
  const [commands, skills] = await Promise.all([
    api
      .get<ApiCommand[]>('/command', { 'location[directory]': directory })
      .catch((error: unknown): ApiCommand[] => {
        complete = false;
        logger.warn('Could not read the OpenCode command catalog', error);
        return [];
      }),
    api
      .get<ApiSkill[]>('/skill', { 'location[directory]': directory })
      .catch((error: unknown): ApiSkill[] => {
        complete = false;
        logger.warn('Could not read the OpenCode skill catalog', error);
        return [];
      }),
  ]);
  const entries: AgentCommand[] = [];
  const templates = localTemplates(directory, logger, configDir);
  for (const command of commands) {
    if (typeof command.name !== 'string' || command.name.length === 0) {
      continue;
    }
    const template = templates.get(command.name);
    entries.push({
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
      source: 'prompt',
      ...(template === undefined ? {} : { template }),
    });
  }
  for (const skill of skills) {
    const name = skill.name ?? skill.id;
    if (name === undefined || name.length === 0) {
      continue;
    }
    entries.push({
      name,
      ...(skill.description === undefined ? {} : { description: skill.description }),
      source: 'skill',
    });
  }
  return { commands: entries, complete };
}

/**
 * The prompt-template bodies the server's `/command` rows do not carry.
 *
 * OpenCode's command API answers with names and descriptions only — no template
 * body, no `argument-hint` — so a bare `/name` gives the composer nothing to
 * open its argument form with. Morse reads the same markdown files and
 * `opencode.json` entries the server loads (project shadowing global, exactly
 * as OpenCode resolves them) and returns the raw template per command name —
 * but only when the body declares pi-style argument placeholders (or the file
 * carries an `argument-hint`), because those are the shapes Morse expands.
 * Anything else — no arguments at all, or OpenCode-only features like `` !`sh` ``
 * injection — stays absent, so the bare `/name` keeps the server's own
 * expansion. Same for commands Morse cannot find a file for: nested `a/b`
 * names, plugin-provided ones. A bot's agent passes its own config dir, so the
 * global half resolves inside the bot instead of the host's XDG one.
 */
function localTemplates(
  directory: string,
  logger: MorseLogger,
  configDir?: string,
): Map<string, string> {
  try {
    const templates = new Map<string, string>();
    // Project files come first in `listCommands`, so first-write-wins keeps a
    // project definition over a same-named global one.
    for (const command of listCommands(directory, configDir).commands) {
      if (command.error !== undefined || templates.has(command.name)) {
        continue;
      }
      if (command.raw !== undefined) {
        const { frontmatter, body } = parseCommandFile(command.raw);
        if (frontmatter['argument-hint'] !== undefined || declaresArguments(body)) {
          templates.set(command.name, command.raw);
        }
        continue;
      }
      if (command.entry?.template !== undefined && declaresArguments(command.entry.template)) {
        templates.set(command.name, command.entry.template);
      }
    }
    return templates;
  } catch (error: unknown) {
    // A broken opencode.json must not take the command list down: the rows stay
    // name-only and OpenCode expands them server-side, as before.
    logger.warn('Could not read OpenCode command files for template expansion', error);
    return new Map();
  }
}

/** pi-style positional or catch-all placeholders — the shapes Morse expands. */
const DECLARED_ARGUMENTS = /\$(?:\{\d+:|ARGUMENTS|@|\d)/;

function declaresArguments(body: string): boolean {
  return DECLARED_ARGUMENTS.test(body);
}

/** The file extension an uploaded attachment gets, from its media type. */
export function extensionOf(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  switch (normalized) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'video/mp4':
      return '.mp4';
    case 'video/webm':
      return '.webm';
    case 'audio/mpeg':
    case 'audio/mp3':
      return '.mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case 'audio/ogg':
      return '.ogg';
    case 'application/pdf':
      return '.pdf';
    default:
      if (normalized.startsWith('video/')) {
        return '.vid';
      }
      if (normalized.startsWith('audio/')) {
        return '.aud';
      }
      return '.img';
  }
}
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
