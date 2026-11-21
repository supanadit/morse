/**
 * pi's prompt-template store: one `.md` file per template, in the user's
 * `<agentDir>/prompts` and this project's `<cwd>/.pi/prompts`. The file name is
 * the `/command` name, a project file shadows a user one by name, and the
 * frontmatter is parsed with the same YAML parser pi uses.
 */
import { join } from 'node:path';
import {
  FileResourceStore,
  type ConfigIssue,
  type ConfigScope,
  type PromptTemplate,
  type PromptTemplateInput,
  type ResourceDirs,
  type ResourceList,
  normalizeCwd,
  messageOf,
} from '@morse/engine-config';

import { extractFrontmatter, parsePromptTemplate } from '../internal/prompt-frontmatter.js';

/**
 * pi's template row: the neutral template with the file fields a `.md` template
 * always has. `PromptTemplate` itself keeps them optional because OpenCode also
 * lists config-sourced commands, which have no file.
 */
export interface PiPromptTemplate extends PromptTemplate {
  path: string;
  raw: string;
  body: string;
}

/** pi's file rows, plus where a new one lands and whether the project's load. */
export interface PiPromptList extends ResourceList<PiPromptTemplate> {
  globalDir: string;
  projectDir?: string;
  trusted: boolean;
}

/** The engine facts a prompt store needs: the user tree and who owns its files. */
export interface PiPromptStoreHost {
  /** pi's user agent directory (the parent of `prompts/`). */
  readonly agentDir: string;
  /** `isolated` makes a bot's own tree private from the moment it exists. */
  readonly ownership: 'user' | 'isolated';
  /** Whether pi would load `cwd`'s `.pi` resources; always false for an isolated tree. */
  trusted(cwd: string): boolean;
}

/**
 * pi's templates on the shared file-store mechanics: the project directory
 * shadows the user one, a save writes before it deletes a moved file, an
 * unreadable file keeps its row, and every failure is a message plus an issue.
 *
 * A template the YAML parser rejects stays listed with `error` — pi would drop
 * the whole command, so the editor has to show it to be fixed — and the same
 * parser refuses a save, so an invalid write never creates a dead `/command`.
 */
export class PiPromptStore extends FileResourceStore<PiPromptTemplate, PromptTemplateInput> {
  readonly extension = 'md';
  private readonly host: PiPromptStoreHost;

  constructor(host: PiPromptStoreHost) {
    super('prompt', { ownership: host.ownership }, { merge: 'shadow' });
    this.host = host;
  }

  dirs(cwd?: string): ResourceDirs {
    const project = this.projectDir(cwd);
    return {
      global: join(this.host.agentDir, 'prompts'),
      // No project means no project directory: the empty-session view lists the
      // user's templates alone.
      ...(project === undefined ? {} : { project }),
    };
  }

  /** One file as the editor reads it; broken frontmatter is a row `error`, not a skip. */
  decode(
    name: string,
    raw: string,
    path: string,
    scope: ConfigScope,
    _issues: ConfigIssue[],
  ): PiPromptTemplate {
    // A frontmatterless file keeps its trailing newline through pi's extractor;
    // the editor wants the body clean, and a save re-adds the newline.
    const info: PiPromptTemplate = {
      name,
      scope,
      source: 'file',
      path,
      body: extractFrontmatter(raw).body.trim(),
      raw,
    };
    try {
      const parsed = parsePromptTemplate(raw);
      const description = parsed.frontmatter['description'];
      if (typeof description === 'string' && description.length > 0) {
        info.description = description;
      }
      const hint = parsed.frontmatter['argument-hint'];
      if (typeof hint === 'string' && hint.length > 0) {
        info.argumentHint = hint;
      }
      info.body = parsed.body.trim();
    } catch (error: unknown) {
      info.error = messageOf(error);
    }
    return info;
  }

  /**
   * The file to write. The editor composes `raw` (frontmatter and body), so it
   * is written as given — after pi's parser accepts it, and with pi's trailing
   * newline.
   */
  encode(input: PromptTemplateInput): string {
    const raw = input.raw ?? '';
    parsePromptTemplate(raw);
    return raw.endsWith('\n') ? raw : `${raw}\n`;
  }

  /** The file list, plus where a new one lands and whether pi would load the project's. */
  override list(cwd?: string): PiPromptList {
    const root = this.projectRoot(cwd);
    const project = root === undefined ? undefined : join(root, '.pi', 'prompts');
    const listed = super.list(cwd);
    const dirs = this.dirs(cwd);
    return {
      ...listed,
      globalDir: dirs.global,
      ...(project === undefined ? {} : { projectDir: project }),
      // Trust is decided at the project root, exactly where pi decides it; a
      // prompts symlink or a `.pi` entry must not change the answer.
      trusted: root !== undefined && this.host.trusted(root),
    };
  }

  /** pi's `/command` rule is also the file-name rule, with one implementation. */
  protected override isValidName(name: string): boolean {
    return isValidTemplateName(name);
  }

  /**
   * This project's prompt directory, or `undefined` for "no project". An
   * isolated tree (a bot's own config) has no project of its own, so a stray
   * `cwd` can never make it read or write the user's `.pi/prompts`.
   */
  private projectDir(cwd?: string): string | undefined {
    const project = this.projectRoot(cwd);
    return project === undefined ? undefined : join(project, '.pi', 'prompts');
  }

  /** The directory pi evaluates trust at, or `undefined` for "no project". */
  private projectRoot(cwd?: string): string | undefined {
    const project = normalizeCwd(cwd);
    return project === undefined || this.host.ownership === 'isolated' ? undefined : project;
  }
}

/** A command name is a file name: letters, digits, `_`, `-`, `.`. No path is ever taken from it. */
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Whether a name is a safe file name (and therefore a valid `/command`). */
export function isValidTemplateName(name: string): boolean {
  return VALID_NAME.test(name) && name !== '.' && name !== '..';
}
