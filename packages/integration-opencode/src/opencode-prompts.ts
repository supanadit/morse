import { homedir } from 'node:os';
import {
  resolveEngineContext,
  type ConfigIssue,
  type ConfigMutation,
  type PromptScope,
  type PromptTemplate,
  type PromptTemplateInput,
} from '@morse/engine-config';
import type { CommandSource } from './internal/opencode-prompts-config.js';
import {
  OpenCodeEngineDefinition,
  type OpenCodeEngineInstance,
} from './engine/open-code-engine.js';
import type { OpenCodePromptStore } from './engine/open-code-prompt-store.js';

/** What a prompt-template mutation answers, plus the surface it acted on. */
export interface OpenCodePromptMutation {
  ok: boolean;
  message?: string;
  path?: string;
  scope?: PromptScope;
  source: CommandSource;
  issues?: ConfigIssue[];
}

/**
 * OpenCode's prompt-template administration: its `/commands`, both the markdown
 * files and the `command` entries of `opencode.json`, behind the same port
 * pi's `PiPrompts` satisfies. Commands are plain templates — there is no
 * live state to probe, so like the MCP side the answers are configured truth
 * only.
 *
 * The rows carry `source: 'file' | 'config'` so the host and the editor can
 * label where each command lives and route edits back to the right surface.
 *
 * The global directory is injectable because a bot mode host runs the same
 * integration against a bot's own config tree; without it the bot would edit
 * the user's `~/.config/opencode`.
 *
 * The templates live behind `OpenCodePromptStore`; this manager keeps the port
 * the hosts already speak (a `cwd` string, the old option name) and builds the
 * user engine instance whose store answers.
 */
export class OpenCodePrompts {
  private readonly definition: OpenCodeEngineDefinition;
  private readonly ownership: 'user' | 'isolated';
  private readonly root: string | undefined;

  constructor(
    options: {
      /**
       * Overrides the global config directory (the one holding `commands/` and
       * `opencode.json`). Tests inject a temp one; a bot names its tree with
       * `root` instead, so it never edits the user's `~/.config/opencode`.
       */
      configDir?: string;
      /**
       * Whose tree these files are: the reader's (`user`, the default) or one
       * Morse generated (`isolated`, a bot's). An isolated tree names its
       * `root` — the directory holding `opencode/` — and its files are private
       * from the moment they exist instead of keeping a 0644.
       */
      ownership?: 'user' | 'isolated';
      /** An isolated tree's root; ignored for a user tree. */
      root?: string;
    } = {},
  ) {
    this.definition = new OpenCodeEngineDefinition(
      options.configDir === undefined ? {} : { configDir: options.configDir },
    );
    this.ownership = options.ownership ?? 'user';
    this.root = options.root;
  }

  list(cwd: string): {
    templates: PromptTemplate[];
    globalDir: string;
    projectDir?: string;
    /** OpenCode has no pi-style trust gate: project commands always load. */
    trusted: true;
    configPath: string;
    /** Read failures the list met (a JSONC config needs normalizing before an edit). */
    issues: ConfigIssue[];
  } {
    const listed = this.store(cwd).list(normalizeCwd(cwd));
    return {
      templates: listed.items,
      globalDir: listed.globalDir,
      ...(listed.projectDir === undefined ? {} : { projectDir: listed.projectDir }),
      trusted: true,
      configPath: listed.configPath ?? '',
      issues: listed.issues,
    };
  }

  save(input: PromptTemplateInput, cwd: string): OpenCodePromptMutation {
    const source = input.source ?? 'file';
    // The manager's old contract: a missing half of the input is a caller bug,
    // not a file the user can fix, so it throws instead of returning an issue.
    if (source === 'config') {
      if (input.entry === undefined) {
        throw new Error(
          'A config command needs its structured entry (template, description, ...).',
        );
      }
    } else if (input.raw === undefined) {
      throw new Error('A file command needs its raw markdown.');
    }
    const saved = this.store(cwd).save({ ...input, source }, input.scope, normalizeCwd(cwd));
    const message = saved.ok ? undefined : (saved.message ?? saved.issues[0]?.message);
    return { ...saved, ...(message === undefined ? {} : { message }), source };
  }

  /** Delete by source: a file command removes the file, a config one the JSON key. */
  delete(
    name: string,
    scope: PromptScope,
    cwd: string,
    source: CommandSource = 'file',
  ): ConfigMutation {
    return this.store(cwd).remove(name, scope, normalizeCwd(cwd), source);
  }

  /** A cheap fingerprint of the commands this directory lists, for change watching. */
  configSignature(cwd?: string): string {
    return this.store(cwd).signature(normalizeCwd(cwd));
  }

  private store(cwd?: string): OpenCodePromptStore {
    return this.instance(cwd).prompts;
  }

  /**
   * The engine instance for one call. An injected config dir names the global
   * tree; without one the instance resolves `<xdg config home>/opencode` at the
   * same moment this module always did.
   */
  private instance(cwd?: string): OpenCodeEngineInstance {
    const project = normalizeCwd(cwd);
    return this.definition.create(
      resolveEngineContext({
        ownership: this.ownership,
        home: homedir(),
        ...(project === undefined ? {} : { cwd: project }),
        ...(this.root === undefined ? {} : { root: this.root }),
      }),
    );
  }
}

/** A real directory, or `undefined` for "no project" (the user commands alone). */
function normalizeCwd(cwd: string | undefined): string | undefined {
  const trimmed = cwd?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

export { composeCommandFile, parseCommandFile } from './internal/opencode-prompts-config.js';
