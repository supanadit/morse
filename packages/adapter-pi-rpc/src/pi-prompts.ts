import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { extractFrontmatter, parsePromptTemplate } from './internal/prompt-frontmatter.js';
import { readProjectTrust, resolveAgentDir } from './internal/project-trust.js';

/** Where a template lives: the user's prompts, or this project's `.pi/prompts`. */
export type PromptScope = 'global' | 'project';

/** One template on disk, as the editor reads it. */
export interface PromptTemplateInfo {
  name: string;
  scope: PromptScope;
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
}

/** What a save takes. `raw` is the whole file (frontmatter and body). */
export interface PromptTemplateInput {
  /** The file name when editing; absent when creating. */
  originalName?: string;
  /** The scope it came from, so a move can delete the old file. */
  originalScope?: PromptScope;
  name: string;
  scope: PromptScope;
  raw: string;
}

/** What a mutation answers. */
export interface PromptTemplateMutation {
  ok: boolean;
  message?: string;
  path?: string;
  scope?: PromptScope;
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
 */
export class PiPrompts {
  constructor(private readonly options: PiPromptsOptions = {}) {}

  /** Every template pi would see in `cwd`, plus the directories a save can target. */
  list(cwd: string): PromptTemplatesResult {
    const agentDir = this.agentDir();
    const globalDir = join(agentDir, 'prompts');
    // No session in front means no project: the user directory still lists, and
    // the caller can edit global templates without opening one first.
    const hasProject = cwd.length > 0;
    const projectDir = hasProject ? join(cwd, '.pi', 'prompts') : '';
    const trusted = hasProject ? readProjectTrust(cwd, agentDir) : false;
    // The project's files shadow the user's by name, so write them last.
    const byName = new Map<string, PromptTemplateInfo>();
    for (const info of readDir(globalDir, 'global')) {
      byName.set(info.name, info);
    }
    if (hasProject) {
      for (const info of readDir(projectDir, 'project')) {
        byName.set(info.name, info);
      }
    }
    return {
      templates: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
      globalDir,
      projectDir,
      trusted,
    };
  }

  /**
   * Create or update a template. The raw text must be frontmatter pi can parse —
   * an invalid write would produce a `dead /command` pi silently drops, so it is
   * refused here with the parser's own message.
   */
  save(input: PromptTemplateInput, cwd: string): PromptTemplateMutation {
    if (!isValidTemplateName(input.name)) {
      return {
        ok: false,
        message: `"${input.name}" is not a valid name (letters, digits, "_", "-", "." and no path).`,
      };
    }
    if (input.scope === 'project' && cwd.length === 0) {
      return { ok: false, message: 'Open or pick a project before saving a project template.' };
    }
    try {
      parsePromptTemplate(input.raw);
    } catch (error: unknown) {
      return { ok: false, message: describe(error) };
    }
    const dir = this.dirFor(input.scope, cwd);
    const path = this.filePath(dir, input.name);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, ensureTrailingNewline(input.raw), 'utf8');
    } catch (error: unknown) {
      return { ok: false, message: describe(error) };
    }
    // A rename or a scope move leaves the old file behind unless it is removed.
    const moved =
      (input.originalName !== undefined && input.originalName !== input.name) ||
      (input.originalScope !== undefined && input.originalScope !== input.scope);
    if (moved) {
      this.removeQuietly(input.originalScope ?? input.scope, input.originalName ?? input.name, cwd);
    }
    return { ok: true, path, scope: input.scope };
  }

  /** Delete one template from the scope that defines it. */
  delete(name: string, scope: PromptScope, cwd: string): PromptTemplateMutation {
    if (!isValidTemplateName(name)) {
      return { ok: false, message: `"${name}" is not a valid template name.` };
    }
    if (scope === 'project' && cwd.length === 0) {
      return { ok: false, message: 'Open or pick a project before deleting a project template.' };
    }
    const dir = this.dirFor(scope, cwd);
    const path = this.filePath(dir, name);
    try {
      statSync(path);
    } catch {
      return {
        ok: false,
        message:
          scope === 'project'
            ? `"${name}" is not defined in this project's .pi/prompts.`
            : `"${name}" is not defined in the user prompts directory.`,
      };
    }
    try {
      rmSync(path);
    } catch (error: unknown) {
      return { ok: false, message: describe(error) };
    }
    return { ok: true, path, scope };
  }

  private removeQuietly(scope: PromptScope, name: string, cwd: string): void {
    try {
      rmSync(this.filePath(this.dirFor(scope, cwd), name));
    } catch {
      // Best effort: the new file is already written, and a stale copy is not
      // worth failing the save over.
    }
  }

  private dirFor(scope: PromptScope, cwd: string): string {
    return scope === 'project' ? join(cwd, '.pi', 'prompts') : join(this.agentDir(), 'prompts');
  }

  /** The file path for a name, guaranteed to stay inside `dir`. */
  private filePath(dir: string, name: string): string {
    const path = resolve(dir, `${name}.md`);
    const root = resolve(dir);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error(`Refusing to write outside ${dir}`);
    }
    return path;
  }

  private agentDir(): string {
    if (this.options.agentDir) {
      return this.options.agentDir;
    }
    return resolveAgentDir(this.options.env ?? process.env);
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
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `.md` children of a directory, parsed; an unreadable directory reads as empty. */
function readDir(dir: string, scope: PromptScope): PromptTemplateInfo[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const templates: PromptTemplateInfo[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) {
      continue;
    }
    const path = join(dir, entry.name);
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = statSync(path).isFile();
      } catch {
        continue;
      }
    }
    if (!isFile) {
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    templates.push(parseTemplate(raw, path, entry.name.slice(0, -'.md'.length), scope));
  }
  return templates;
}

/** One file as the editor sees it. An invalid frontmatter keeps the file listed, with `error`. */
function parseTemplate(
  raw: string,
  path: string,
  name: string,
  scope: PromptScope,
): PromptTemplateInfo {
  // A frontmatterless file keeps its trailing newline through pi's extractor;
  // the editor wants the body clean, and a save re-adds the newline.
  const info: PromptTemplateInfo = {
    name,
    scope,
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
    info.error = describe(error);
  }
  return info;
}

function ensureTrailingNewline(raw: string): string {
  return raw.endsWith('\n') ? raw : `${raw}\n`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
