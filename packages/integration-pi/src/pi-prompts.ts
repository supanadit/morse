import { homedir } from 'node:os';
import { resolveEngineContext, type ConfigIssue } from '@morse/engine-config';
import { PiEngineDefinition, type PiEngineInstance } from './engine/pi-engine.js';
import type { PiPromptStore } from './engine/pi-prompt-store.js';
import { resolveAgentDir } from './internal/project-trust.js';

/** Where a template lives: the user's prompts, or this project's `.pi/prompts`. */
export type PromptScope = 'global' | 'project';

/** One template on disk, as the editor reads it. */
export interface PromptTemplateInfo {
  name: string;
  scope: PromptScope;
  source?: 'file' | 'config';
  path: string;
  description?: string;
  argumentHint?: string;
  body: string;
  raw: string;
  /** Set when pi would refuse the frontmatter; the file is still listed so it can be fixed. */
  error?: string;
}

/** Every template, plus where a new one would be written. */
export interface PromptTemplatesResult {
  templates: PromptTemplateInfo[];
  globalDir: string;
  projectDir: string;
  /** pi's `.pi` trust gate: false means project templates are ignored until trusted. */
  trusted: boolean;
  /** Read failures the list met; a broken template is a row `error` instead. */
  issues?: ConfigIssue[];
}

/** What a save takes. `raw` is the whole file (frontmatter and body). */
export interface PromptTemplateInput {
  /** The file name when editing; absent when creating. */
  originalName?: string;
  /** The scope it came from, so a move can delete the old file. */
  originalScope?: PromptScope;
  /** Engine-specific surfaces (OpenCode's file/config rows); pi ignores these. */
  originalSource?: 'file' | 'config';
  source?: 'file' | 'config';
  name: string;
  scope: PromptScope;
  raw: string;
  /** The structured entry of a config-sourced command; pi never reads it. */
  entry?: {
    template: string;
    description?: string;
    agent?: string;
    model?: string;
    subtask?: boolean;
    [key: string]: unknown;
  };
}

/** What a mutation answers. */
export interface PromptTemplateMutation {
  ok: boolean;
  message?: string;
  path?: string;
  scope?: PromptScope;
  issues?: ConfigIssue[];
}

export interface PiPromptsOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the agent directory; defaults to `PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
  agentDir?: string;
}

/** A command name is a file name: letters, digits, `_`, `-`, `.`. No path is ever taken from it. */
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Driven adapter for pi's prompt templates: list the `.md` files pi would load,
 * and create, update or delete them by writing the same files.
 *
 * pi reads `~/.pi/agent/prompts` and, once the project is trusted, `<cwd>/.pi/prompts`
 * — direct `.md` children only, the file name is the command name. A project
 * definition shadows a user one with the same name, exactly as pi loads it.
 *
 * The files live behind `PiPromptStore`; this manager keeps the port the hosts
 * already speak (a `cwd` string, pi's own option names) and builds the engine
 * instance that store reads its roots from.
 */
export class PiPrompts {
  private readonly definition = new PiEngineDefinition();

  constructor(private readonly options: PiPromptsOptions = {}) {}

  /** Every template pi would see in `cwd`, plus the directories a save can target. */
  list(cwd: string): PromptTemplatesResult {
    const project = normalizeCwd(cwd);
    const listed = this.store(project).list(project);
    return {
      templates: listed.items,
      globalDir: listed.globalDir,
      // No project means no project directory; the editor still offers the user one.
      projectDir: listed.projectDir ?? '',
      trusted: listed.trusted,
      issues: listed.issues,
    };
  }

  /**
   * Create or update a template. The raw text must be frontmatter pi can parse —
   * an invalid write would produce a dead `/command` pi silently drops, so it is
   * refused by the store with the parser's own message.
   */
  save(input: PromptTemplateInput, cwd: string): PromptTemplateMutation {
    return this.store(cwd).save(input, input.scope, normalizeCwd(cwd));
  }

  /** Delete one template from the scope that defines it. */
  delete(name: string, scope: PromptScope, cwd: string): PromptTemplateMutation {
    return this.store(cwd).remove(name, scope, normalizeCwd(cwd));
  }

  /** A cheap fingerprint of the templates this directory would list, for change watching. */
  configSignature(cwd?: string): string {
    return this.store(cwd).signature(normalizeCwd(cwd));
  }

  private store(cwd?: string): PiPromptStore {
    return this.instance(cwd).prompts;
  }

  /**
   * The engine instance for one call. The resolved agent dir names pi's user
   * tree through `PI_CODING_AGENT_DIR` — expanded exactly as this module always
   * resolved it — while the project `.pi/prompts` still takes precedence.
   */
  private instance(cwd?: string): PiEngineInstance {
    const env = this.options.env ?? process.env;
    const configured = this.options.agentDir;
    const agentDir =
      configured !== undefined && configured.length > 0 ? configured : resolveAgentDir(env);
    const project = normalizeCwd(cwd);
    return this.definition.create(
      resolveEngineContext({
        ownership: 'user',
        home: homedir(),
        ...(project === undefined ? {} : { cwd: project }),
        env: { ...env, PI_CODING_AGENT_DIR: agentDir },
      }),
    );
  }
}

/** Whether a name is a safe file name (and therefore a valid `/command`). */
export function isValidTemplateName(name: string): boolean {
  return VALID_NAME.test(name) && name !== '.' && name !== '..';
}

/**
 * Rebuild a `PromptTemplateInput` from a wire payload, dropping anything of the
 * wrong shape. Every host parses the editor's `promptTemplateSave` arguments
 * through this, so the validation lives in one place.
 */
export function parsePromptTemplateInput(raw: unknown): PromptTemplateInput {
  const args = isRecord(raw) ? raw : {};
  const input: PromptTemplateInput = {
    name: typeof args.name === 'string' ? args.name.trim() : '',
    scope: args.scope === 'project' ? 'project' : 'global',
    raw: typeof args.raw === 'string' ? args.raw : '',
  };
  if (typeof args.originalName === 'string' && args.originalName.length > 0) {
    input.originalName = args.originalName;
  }
  if (args.originalScope === 'global' || args.originalScope === 'project') {
    input.originalScope = args.originalScope;
  }
  // Engine-specific surfaces: pi ignores these, OpenCode's config commands need
  // them. `raw` stays for files; a config row carries its structured entry.
  if (args.source === 'file' || args.source === 'config') {
    input.source = args.source;
  }
  if (args.originalSource === 'file' || args.originalSource === 'config') {
    input.originalSource = args.originalSource;
  }
  if (isRecord(args.entry) && typeof args.entry.template === 'string') {
    input.entry = args.entry as PromptTemplateInput['entry'];
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A real directory, or `undefined` for "no project" (the user templates alone). */
function normalizeCwd(cwd: string | undefined): string | undefined {
  const trimmed = cwd?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}
