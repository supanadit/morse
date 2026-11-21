import { homedir } from 'node:os';
import {
  resolveEngineContext,
  type ConfigIssue,
  type PromptScope,
  type PromptTemplateInput,
  normalizeCwd,
} from '@morse/engine-config';
import { isRecord } from './internal/rpc/helpers.js';
import { PiEngineDefinition, type PiEngineInstance } from './engine/pi-engine.js';
import {
  isValidTemplateName,
  type PiPromptStore,
  type PiPromptTemplate,
} from './engine/pi-prompt-store.js';
import { resolveAgentDir } from './internal/project-trust.js';

export type { PromptScope, PromptTemplateInput };

/** One template on disk: the neutral row plus the file fields pi always fills. */
export type PromptTemplateInfo = PiPromptTemplate;

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

export { isValidTemplateName };

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
/** A real directory, or `undefined` for "no project" (the user templates alone). */