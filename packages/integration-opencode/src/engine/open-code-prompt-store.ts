/**
 * OpenCode's prompt templates — its `/commands` — on the shared resource stores.
 *
 * Two surfaces answer to the same `/name`, and OpenCode loads both:
 * - markdown files: `<configDir>/commands/*.md` (global) and
 *   `<cwd>/.opencode/commands/*.md` (project). The file name is the command name
 *   and the frontmatter carries `description`; a file pi-style `argument-hint`
 *   does not exist. A project file does *not* shadow a global one: OpenCode
 *   merges both lists, so the file store lists them all (`merge: 'all'`).
 * - the `command` key of the user-level `opencode.json` (or `opencode.jsonc`):
 *   structured `{ template, description?, agent?, model?, subtask? }` entries.
 *   OpenCode defines that block only in the user's config, so the whole
 *   config-command store is pinned to the global scope; a project `command`
 *   block is not read or written.
 *
 * The composite answers in the order file then config, and every row says which
 * surface it came from, so an edit is routed back to the right one.
 */
import { join } from 'node:path';
import {
  CompositeResourceStore,
  ConfigResourceStore,
  FileResourceStore,
  isPlainObject,
  type ConfigLocator,
  type ConfigMutation,
  type ConfigPaths,
  type ConfigScope,
  type PromptList,
  type PromptTemplate,
  type PromptTemplateInput,
  type ResourceDirs,
  normalizeCwd,
  messageOf,
} from '@morse/engine-config';

import { isValidCommandName, parseCommandFile } from '../internal/opencode-prompts-config.js';
import { OPEN_CODE_CONFIG_FILE_ID } from './config-discovery.js';
import { OpenCodeCommandSection } from './open-code-command-section.js';

/** The engine facts the file store needs: the user tree and who owns its files. */
export interface OpenCodeFilePromptStoreHost {
  /** The app-level config dir: the parent of `commands/`. */
  readonly configDir: string;
  /** `isolated` makes a bot's own tree private from the moment it exists. */
  readonly ownership: 'user' | 'isolated';
}

/**
 * OpenCode's `commands/*.md` files on the shared file-store mechanics. Both
 * scopes list (OpenCode merges them rather than shadowing), a save writes the
 * new file before it deletes a moved one, and a broken file stays listed with
 * its frontmatter `error` so the editor can show what OpenCode would drop.
 *
 * Order note: the base store lists the global rows before the project ones,
 * while the old `listCommands` listed project first. Both rows are still
 * listed; only presentation order differs, and it is intentional.
 */
export class OpenCodeFilePromptStore extends FileResourceStore<
  PromptTemplate,
  PromptTemplateInput
> {
  readonly extension = 'md';
  private readonly host: OpenCodeFilePromptStoreHost;

  constructor(host: OpenCodeFilePromptStoreHost) {
    super('command', { ownership: host.ownership }, { merge: 'all' });
    this.host = host;
  }

  dirs(cwd?: string): ResourceDirs {
    const project = normalizeCwd(cwd);
    return {
      global: join(this.host.configDir, 'commands'),
      // No workspace means no project directory: the empty-session view lists
      // the user's commands alone.
      ...(project === undefined ? {} : { project: join(project, '.opencode', 'commands') }),
    };
  }

  /** One file as the editor reads it; broken frontmatter is a row `error`, not a skip. */
  decode(name: string, raw: string, path: string, scope: ConfigScope): PromptTemplate {
    const row: PromptTemplate = { name, scope, source: 'file', path, raw };
    try {
      const { frontmatter, body } = parseCommandFile(raw);
      row.body = body;
      const description = frontmatter['description'];
      if (description !== undefined) {
        row.description = description;
      }
    } catch (error) {
      row.error = messageOf(error);
    }
    return row;
  }

  /**
   * The file to write. The editor composes `raw`, so it is written verbatim —
   * but only after the same frontmatter parser a list uses accepts it: a write
   * must never create a `/command` OpenCode would silently drop. A file broken
   * by hand still lists with `error` and can be fixed in the editor.
   */
  encode(input: PromptTemplateInput): string {
    if (input.raw === undefined) {
      throw new Error('A file command needs its raw markdown.');
    }
    parseCommandFile(input.raw);
    return input.raw;
  }

  /**
   * A `file` row that was a `config` command has no file of its own, so a
   * surface move never deletes a same-named file that belonged to another
   * command.
   */
  override save(input: PromptTemplateInput, scope: ConfigScope, cwd?: string): ConfigMutation {
    if (!isValidCommandName(input.name)) {
      return this.nameRefusal(scope, input.name);
    }
    const next: PromptTemplateInput =
      input.originalSource === 'config'
        ? { ...input, originalName: input.name, originalScope: scope }
        : input;
    return super.save(next, scope, cwd);
  }

  override remove(
    name: string,
    scope: ConfigScope,
    cwd?: string,
    _source?: string,
  ): ConfigMutation {
    if (!isValidCommandName(name)) {
      return this.nameRefusal(scope, name);
    }
    return super.remove(name, scope, cwd);
  }

  /** OpenCode's `/command` rule is also its file-name rule. */
  protected override isValidName(name: string): boolean {
    return isValidCommandName(name);
  }

  private nameRefusal(scope: ConfigScope, name: string): ConfigMutation {
    return this.refusal(
      scope,
      'name',
      `"${name}" is not a valid command name (letters, digits, "_" and "-").`,
    );
  }
}

/**
 * The `command` key of the user-level `opencode.json`. The section is the only
 * half that knows the entry shape; this store pins every read and write to the
 * global file, because OpenCode's project config has no `command` block.
 *
 * A user config read as JSONC lists its commands and reports a fixable
 * `normalize` issue; the write is refused until that file is normalized, the
 * same rule the MCP store follows.
 */
export class OpenCodeConfigPromptStore extends ConfigResourceStore<PromptTemplate, PromptTemplate> {
  override readonly section = new OpenCodeCommandSection();

  constructor(locator: ConfigLocator) {
    super(globalOnly(locator), OPEN_CODE_CONFIG_FILE_ID);
  }

  /** The user-level file the commands live in (the `jsonc` spelling when it exists). */
  configPath(cwd?: string): string {
    return this.paths('global', cwd).write;
  }

  /**
   * Save the entry, then drop the key a rename left behind. The write comes
   * first so a failed save never loses the old command; the old key is removed
   * from whichever file in the read chain defines it.
   */
  override save(input: PromptTemplateInput, scope: ConfigScope, cwd?: string): ConfigMutation {
    if (!isValidCommandName(input.name)) {
      return this.nameRefusal(input.name, cwd);
    }
    const written = super.save(input, scope, cwd);
    if (!written.ok) {
      return written;
    }
    const from = input.originalName;
    if (from === undefined || from === input.name || input.originalSource !== 'config') {
      return written;
    }
    const removed = this.removeKeyEverywhere(from, cwd);
    // No file defining the old key leaves the rename complete; a refusal (a
    // file that cannot be decoded, or a write that failed) must not hide behind
    // the entry that was already written.
    if (removed === undefined || removed.ok) {
      return written;
    }
    return { ...removed, ok: false, message: removed.message ?? removed.issues[0]?.message };
  }

  override remove(name: string, scope: ConfigScope, cwd?: string, source?: string): ConfigMutation {
    if (!isValidCommandName(name)) {
      return this.nameRefusal(name, cwd);
    }
    // A listed row may be defined in a read fallback (a `json` beside the
    // `jsonc` write target), so a delete follows the key rather than the write
    // target. Nothing found keeps the base store's "not defined" refusal.
    return this.removeKeyEverywhere(name, cwd) ?? super.remove(name, scope, cwd, source);
  }

  /** OpenCode's `/command` rule is also its `command`-key rule. */
  private nameRefusal(name: string, cwd?: string): ConfigMutation {
    const message = `"${name}" is not a valid command name (letters, digits, "_" and "-").`;
    let path = this.fileId;
    try {
      path = this.configPath(cwd);
    } catch {
      // The file id still names the surface when the path cannot be resolved.
    }
    return {
      ok: false,
      path,
      scope: 'global',
      message,
      issues: [
        { file: path, fileId: this.fileId, scope: 'global', code: 'name', message, fixable: false },
      ],
    };
  }

  /**
   * Delete one `command` key from whichever file in the read chain defines it.
   * The write target is not necessarily that file: with both `opencode.jsonc`
   * and `opencode.json`, a key defined only in the JSON fallback has to be
   * removed there, or a rename would leave the old row behind.
   *
   * `undefined` means no readable file defines the key. A file that cannot be
   * decoded might still hold it, so that is a refusal naming the file instead
   * of a silent success.
   */
  private removeKeyEverywhere(name: string, cwd?: string): ConfigMutation | undefined {
    let paths: ConfigPaths;
    try {
      paths = this.paths('global', cwd);
    } catch (error) {
      const message = messageOf(error);
      return {
        ok: false,
        scope: 'global',
        message,
        issues: [
          {
            file: this.fileId,
            fileId: this.fileId,
            scope: 'global',
            code: 'read',
            message,
            fixable: false,
          },
        ],
      };
    }
    for (const path of paths.read) {
      const scope = this.locator.scopeOf(this.fileId, path);
      const file = this.locator.fileAt(this.fileId, path, scope);
      const document = file.read();
      const blocked = document.issues.find(
        (issue) => issue.code === 'parse' || issue.code === 'read',
      );
      if (blocked !== undefined) {
        return { ok: false, path, scope, message: blocked.message, issues: document.issues };
      }
      if (!isPlainObject(document.value)) {
        continue;
      }
      const root = document.value;
      const block = root[this.section.key];
      const existing = isPlainObject(block) ? block : undefined;
      if (existing === undefined || !Object.hasOwn(existing, name)) {
        continue;
      }
      const nextBlock: Record<string, unknown> = { ...existing };
      delete nextBlock[name];
      const next: Record<string, unknown> = { ...root };
      if (Object.keys(nextBlock).length === 0) {
        delete next[this.section.key];
      } else {
        next[this.section.key] = nextBlock;
      }
      return file.write(next);
    }
    return undefined;
  }
}

/**
 * OpenCode's prompt templates as one store: the markdown files first, then the
 * user config's `command` entries. A save routes by the input's `source` and an
 * absent one lands on a file (the surface the editor creates by default), while
 * a removal routes the same way.
 */
export class OpenCodePromptStore extends CompositeResourceStore<
  PromptTemplate,
  PromptTemplateInput
> {
  private readonly files: OpenCodeFilePromptStore;
  private readonly config: OpenCodeConfigPromptStore;
  private readonly configDir: string;

  constructor(locator: ConfigLocator, configDir: string) {
    const files = new OpenCodeFilePromptStore({ configDir, ownership: locator.ownership });
    const config = new OpenCodeConfigPromptStore(locator);
    super([
      { source: 'file', store: files },
      { source: 'config', store: config },
    ]);
    this.files = files;
    this.config = config;
    this.configDir = configDir;
  }

  /** Every row, plus the directories a new command can land in. */
  override list(cwd?: string): PromptList {
    const listed = super.list(cwd);
    const dirs = this.files.dirs(cwd);
    return {
      ...listed,
      globalDir: dirs.global,
      ...(dirs.project === undefined ? {} : { projectDir: dirs.project }),
      // OpenCode has no pi-style trust gate: project commands always load.
      trusted: true,
      configPath: this.configPath(cwd),
    };
  }

  private configPath(cwd?: string): string {
    try {
      return this.config.configPath(cwd);
    } catch {
      // Unresolvable paths are reported by the config store's own listing; the
      // path a fresh tree would get is still the useful answer here.
      return join(this.configDir, 'opencode.json');
    }
  }
}

/**
 * The locator narrowed to the user-level file. Every scope asks for `global`,
 * so the base store's list/save/remove/normalize all act on `opencode.json[c]`
 * and its entries are tagged `global`, with no project chain to shadow it.
 */
function globalOnly(locator: ConfigLocator): ConfigLocator {
  return {
    ownership: locator.ownership,
    paths(fileId: string, _scope: ConfigScope, cwd?: string): ConfigPaths {
      return locator.paths(fileId, 'global', cwd);
    },
    file(fileId: string, _scope: ConfigScope, cwd?: string) {
      return locator.file(fileId, 'global', cwd);
    },
    fileAt(fileId: string, path: string, _scope: ConfigScope) {
      return locator.fileAt(fileId, path, 'global');
    },
    scopeOf(): ConfigScope {
      return 'global';
    },
  };
}

/** A real directory, or `undefined` for "no project". */