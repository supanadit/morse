/**
 * A directory-backed resource store: one file per named item, in a global
 * directory and (when a project is open) a project directory. The project file
 * shadows the global one by name, listing never throws, a save writes the new
 * file before it deletes the one a rename or scope move left behind, and every
 * failure is an issue.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { ConfigIssue, ConfigIssueCode, ConfigMutation, ConfigScope } from '@morse/protocol';

import type { WritePolicy } from '../core/types.js';
import { fileSignature, writeAtomic } from '../core/write.js';
import { ResourceStore, type ResourceDirs, type ResourceList } from './resource-store.js';

/** How a duplicate name in both scopes is listed. */
export type FileStoreMerge = 'shadow' | 'all';

export interface FileStoreOptions {
  /** `shadow` (default) keeps the project item; `all` lists both, global first. */
  merge?: FileStoreMerge;
}

/** A name safe to append to a directory: no separators, no traversal. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type DirsResult = { dirs: ResourceDirs } | { issue: ConfigIssue };

export abstract class FileResourceStore<
  TItem extends { name: string; scope: ConfigScope },
  TSave extends { name: string; originalName?: string; originalScope?: ConfigScope } = TItem,
> extends ResourceStore<TItem, TSave> {
  /** The `fileId` issues carry, so a complaint names the resource kind. */
  readonly fileId: string;
  /** How this store's files are owned and moded; an isolated bot tree writes `0600`. */
  protected readonly policy: WritePolicy;
  private readonly merge: FileStoreMerge;

  protected constructor(fileId: string, policy: WritePolicy, options: FileStoreOptions = {}) {
    super();
    this.fileId = fileId;
    this.policy = policy;
    this.merge = options.merge ?? 'shadow';
  }

  /** The global and project directories. A missing `project` means no project is open. */
  abstract dirs(cwd?: string): ResourceDirs;

  /** The file suffix without its dot (`'md'`). */
  abstract readonly extension: string;

  /**
   * One file as an item. The item's `name` is the merge key, so a codec that
   * strips a suffix returns the shortest name. A file the codec cannot fully
   * read still returns an item carrying `error`; issues it pushes are listed
   * beside the items.
   */
  abstract decode(
    name: string,
    raw: string,
    path: string,
    scope: ConfigScope,
    issues: ConfigIssue[],
  ): TItem;

  /** The whole file a save writes. */
  abstract encode(input: TSave): string;

  /** Whether a name may become a file name. Subclasses with stricter rules override this. */
  protected isValidName(name: string): boolean {
    return SAFE_NAME.test(name);
  }

  /** Every item, global first. `shadow` keeps the project item for a duplicate name, sorted. */
  list(cwd?: string): ResourceList<TItem> {
    const resolved = this.resolveDirs(cwd);
    if ('issue' in resolved) {
      return { items: [], issues: [resolved.issue] };
    }
    const collected: TItem[] = [];
    const issues: ConfigIssue[] = [];
    for (const [scope, dir] of scopeDirs(resolved.dirs)) {
      for (const name of this.fileNames(dir, scope, issues)) {
        const path = join(dir, `${name}.${this.extension}`);
        let raw: string;
        try {
          raw = readFileSync(path, 'utf8');
        } catch (error) {
          issues.push(this.issue(path, scope, 'read', `${path}: ${messageOf(error)}`));
          continue;
        }
        const item = this.decodeFile(name, raw, path, scope, issues);
        if (item !== undefined) {
          collected.push(item);
        }
      }
    }
    if (this.merge === 'all') {
      return { items: collected, issues };
    }
    const byName = new Map<string, TItem>();
    for (const item of collected) {
      byName.set(item.name, item);
    }
    const items = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
    return { items, issues };
  }

  /**
   * Write one file atomically. A rename or a scope move deletes the old file
   * only after the new one exists; the target itself is never deleted.
   */
  save(input: TSave, scope: ConfigScope, cwd?: string): ConfigMutation {
    if (!this.isValidName(input.name)) {
      return this.refusal(scope, 'name', nameMessage(this.fileId, input.name));
    }
    const target = this.targetDir(scope, cwd);
    if ('refusal' in target) {
      return target.refusal;
    }
    let path: string;
    try {
      path = this.filePath(target.dir, input.name);
    } catch (error) {
      return this.refusal(scope, 'name', messageOf(error));
    }
    let text: string;
    try {
      text = this.encode(input);
    } catch (error) {
      return this.refusal(scope, 'shape', `${path}: ${messageOf(error)}`, path);
    }
    try {
      writeAtomic(path, text, this.policy);
    } catch (error) {
      return this.refusal(scope, 'write', `${path}: ${messageOf(error)}`, path);
    }
    this.deleteMoved(input, scope, path, cwd);
    return { ok: true, path, scope, issues: [] };
  }

  /** Delete one file from the scope that defines it. */
  remove(name: string, scope: ConfigScope, cwd?: string, _source?: string): ConfigMutation {
    if (!this.isValidName(name)) {
      return this.refusal(scope, 'name', nameMessage(this.fileId, name));
    }
    const target = this.targetDir(scope, cwd);
    if ('refusal' in target) {
      return target.refusal;
    }
    const dir = target.dir;
    let path: string;
    try {
      path = this.filePath(dir, name);
    } catch (error) {
      return this.refusal(scope, 'name', messageOf(error));
    }
    if (!existsSync(path)) {
      const message = `No ${this.fileId} named "${name}" is defined in ${dir}.`;
      return { ...this.refusal(scope, 'name', message), path };
    }
    try {
      rmSync(path);
    } catch (error) {
      return this.refusal(scope, 'write', `${path}: ${messageOf(error)}`, path);
    }
    return { ok: true, path, scope, issues: [] };
  }

  /** A cheap fingerprint of every file this store lists. */
  signature(cwd?: string): string {
    const resolved = this.resolveDirs(cwd);
    if ('issue' in resolved) {
      return '';
    }
    const ignored: ConfigIssue[] = [];
    const parts: string[] = [];
    for (const [scope, dir] of scopeDirs(resolved.dirs)) {
      for (const name of this.fileNames(dir, scope, ignored)) {
        const path = join(dir, `${name}.${this.extension}`);
        parts.push(`${scope}:${name}:${fileSignature(path)}`);
      }
    }
    return parts.join(',');
  }

  /** The directory the scope writes into, or `undefined` when the scope has none. */
  private targetDir(
    scope: ConfigScope,
    cwd?: string,
  ): { dir: string } | { refusal: ConfigMutation } {
    let dirs: ResourceDirs;
    try {
      dirs = this.dirs(cwd);
    } catch (error) {
      return { refusal: this.refusal(scope, 'read', messageOf(error)) };
    }
    const dir = scope === 'project' ? projectRoot(dirs) : dirs.global;
    if (dir === undefined) {
      return { refusal: this.refusal(scope, 'unsupported', noProjectMessage(this.fileId, scope)) };
    }
    return { dir };
  }

  /** The file for a name, guaranteed to stay inside `dir`. */
  protected filePath(dir: string, name: string): string {
    const path = resolve(dir, `${name}.${this.extension}`);
    const root = resolve(dir);
    if (!path.startsWith(`${root}${sep}`)) {
      throw new Error(`Refusing to write "${name}" outside ${dir}.`);
    }
    return path;
  }

  /** A refusal mutation: `ok:false`, a message and one issue. */
  protected refusal(
    scope: ConfigScope,
    code: ConfigIssueCode,
    message: string,
    file?: string,
  ): ConfigMutation {
    return {
      ok: false,
      scope,
      message,
      issues: [this.issue(file ?? this.fileId, scope, code, message)],
    };
  }

  private issue(
    file: string,
    scope: ConfigScope,
    code: ConfigIssueCode,
    message: string,
  ): ConfigIssue {
    return { file, fileId: this.fileId, scope, code, message, fixable: false };
  }

  private resolveDirs(cwd?: string): DirsResult {
    try {
      return { dirs: this.dirs(cwd) };
    } catch (error) {
      return { issue: this.issue(this.fileId, 'global', 'read', messageOf(error)) };
    }
  }

  /** A decode that throws is a list issue for that file; its siblings still list. */
  private decodeFile(
    name: string,
    raw: string,
    path: string,
    scope: ConfigScope,
    issues: ConfigIssue[],
  ): TItem | undefined {
    try {
      return this.decode(name, raw, path, scope, issues);
    } catch (error) {
      issues.push(this.issue(path, scope, 'shape', `${path}: ${messageOf(error)}`));
      return undefined;
    }
  }

  /** The `<name>.<extension>` children of a directory, sorted; a missing directory is empty. */
  private fileNames(dir: string, scope: ConfigScope, issues: ConfigIssue[]): string[] {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) {
        issues.push(this.issue(dir, scope, 'read', `${dir}: ${messageOf(error)}`));
      }
      return [];
    }
    const suffix = `.${this.extension}`;
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(suffix) || entry.name.length === suffix.length) {
        continue;
      }
      if (!isFile(entry, join(dir, entry.name))) {
        continue;
      }
      names.push(entry.name.slice(0, -suffix.length));
    }
    return names.sort((left, right) => left.localeCompare(right));
  }

  /** Remove the file a rename or a scope move left behind, after the new write. */
  private deleteMoved(input: TSave, scope: ConfigScope, target: string, cwd?: string): void {
    const oldName = input.originalName ?? input.name;
    const oldScope = input.originalScope ?? scope;
    if (oldName === input.name && oldScope === scope) {
      return;
    }
    if (!this.isValidName(oldName)) {
      return;
    }
    const oldTarget = this.targetDir(oldScope, cwd);
    if ('refusal' in oldTarget) {
      return;
    }
    let old: string;
    try {
      old = this.filePath(oldTarget.dir, oldName);
    } catch {
      return;
    }
    if (old === target) {
      return;
    }
    try {
      rmSync(old, { force: true });
    } catch {
      // Best effort: the new file is already written, and a stale copy is not
      // worth failing the save over.
    }
  }
}

function scopeDirs(dirs: ResourceDirs): Array<[ConfigScope, string]> {
  const scopes: Array<[ConfigScope, string]> = [['global', dirs.global]];
  const project = projectRoot(dirs);
  if (project !== undefined) {
    scopes.push(['project', project]);
  }
  return scopes;
}

/** A project root; the empty string means "no project", exactly as absent does. */
function projectRoot(dirs: ResourceDirs): string | undefined {
  return dirs.project !== undefined && dirs.project.length > 0 ? dirs.project : undefined;
}

function isFile(entry: Dirent, path: string): boolean {
  if (entry.isFile()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function nameMessage(fileId: string, name: string): string {
  return `"${name}" is not a valid ${fileId} name (letters, digits, "_", "-", "." and no path).`;
}

function noProjectMessage(fileId: string, scope: ConfigScope): string {
  return `No project is open, so there is no ${scope} ${fileId} directory.`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
