/**
 * The two config-section stores. `ConfigResourceStore` manages named entries
 * inside one block of a JSON document; `ConfigStore` owns the whole document.
 * Both read the file chain the locator resolves (highest precedence first),
 * keep everything they do not manage, delete a block once it empties, and turn
 * every failure into an issue instead of a throw.
 */
import type { ConfigIssue, ConfigIssueCode, ConfigMutation, ConfigScope } from '@morse/protocol';

import type { ConfigLocator } from '../engine/locator.js';
import { ResourceStore, type ResourceList } from '../resource/resource-store.js';
import type { ConfigFile } from './config-file.js';
import {
  configPointer,
  isPlainObject,
  type ConfigSection,
  type NamedConfigEntry,
  type NamedConfigSection,
} from './section.js';
import type { ConfigDocument, ConfigPaths } from './types.js';

/** What `apply` computed: the next whole document value and its complaints. */
export interface ConfigApplyResult {
  value: unknown;
  issues: ConfigIssue[];
}

/** One managed entry: a name/item pair, or an item that already carries its name. */
export type ConfigManagedEntry<T> = NamedConfigEntry<T> | T;

/** What `ConfigStore.read` found in the defining document. */
export interface ConfigStoreRead<T> {
  path: string;
  scope: ConfigScope;
  value?: T;
  document?: ConfigDocument;
  issues: ConfigIssue[];
}

/** One file in a precedence chain: its path, the scope it belongs to, and its handle. */
interface ConfigTarget {
  path: string;
  scope: ConfigScope;
  file: ConfigFile;
}

export abstract class ConfigStore<T> {
  protected readonly locator: ConfigLocator;
  readonly fileId: string;
  abstract readonly section: ConfigSection<T>;

  protected constructor(locator: ConfigLocator, fileId: string) {
    this.locator = locator;
    this.fileId = fileId;
  }

  paths(scope: ConfigScope, cwd?: string): ConfigPaths {
    return this.locator.paths(this.fileId, scope, cwd);
  }

  file(scope: ConfigScope = defaultScope(this.locator), cwd?: string): ConfigFile {
    return this.locator.file(this.fileId, scope, cwd);
  }

  /**
   * Decode the first document in the scope's chain that has a value. A missing
   * or empty higher-precedence file falls through to its fallback; issues from
   * every document consulted are reported.
   */
  read(scope: ConfigScope = defaultScope(this.locator), cwd?: string): ConfigStoreRead<T> {
    let found: ConfigTarget[];
    try {
      found = targets(this.locator, this.fileId, scope, cwd);
    } catch (error) {
      return { path: '', scope, issues: [rejection(error, this.fileId, scope)] };
    }
    const issues: ConfigIssue[] = [];
    for (const target of found) {
      const document = target.file.read();
      issues.push(...tagged(document.issues, target));
      if (document.value === undefined) {
        continue;
      }
      const own: ConfigIssue[] = [];
      const value = this.section.decode(document.value, {
        file: target.path,
        fileId: this.fileId,
        scope: target.scope,
        issues: own,
        pointer: configPointer,
      });
      issues.push(...own);
      return { path: target.path, scope: target.scope, value, document, issues };
    }
    return { path: found[0]?.path ?? '', scope, issues };
  }

  /** Encode the section into the scope's write target, preserving its other keys. */
  save(item: T, scope: ConfigScope = defaultScope(this.locator), cwd?: string): ConfigMutation {
    let file: ConfigFile;
    try {
      file = this.locator.file(this.fileId, scope, cwd);
    } catch (error) {
      return { ok: false, scope, issues: [rejection(error, this.fileId, scope)] };
    }
    const document = file.read();
    let value: unknown;
    try {
      value = this.section.encode(item, document.value);
    } catch (error) {
      return {
        ok: false,
        path: file.path,
        scope,
        issues: [issue(file.path, this.fileId, scope, 'shape', messageOf(error))],
      };
    }
    return file.write(value);
  }

  /** Fix every existing, non-strict file in the scope's chain. */
  normalize(scope: ConfigScope = defaultScope(this.locator), cwd?: string): ConfigMutation {
    let found: ConfigTarget[];
    try {
      found = targets(this.locator, this.fileId, scope, cwd);
    } catch (error) {
      return { ok: false, scope, issues: [rejection(error, this.fileId, scope)] };
    }
    return normalizeTargets(found, scope);
  }

  signature(cwd?: string): string {
    try {
      return targetsSignature(targets(this.locator, this.fileId, defaultScope(this.locator), cwd));
    } catch {
      return '';
    }
  }
}

export abstract class ConfigResourceStore<T, TItem = T> extends ResourceStore<TItem, T> {
  protected readonly locator: ConfigLocator;
  readonly fileId: string;
  abstract readonly section: NamedConfigSection<T>;

  protected constructor(locator: ConfigLocator, fileId: string) {
    super();
    this.locator = locator;
    this.fileId = fileId;
  }

  paths(scope: ConfigScope, cwd?: string): ConfigPaths {
    return this.locator.paths(this.fileId, scope, cwd);
  }

  file(scope: ConfigScope = defaultScope(this.locator), cwd?: string): ConfigFile {
    return this.locator.file(this.fileId, scope, cwd);
  }

  /**
   * Every entry the read chain defines, highest precedence first, with the
   * first name winning. A malformed entry is skipped with its pointer; its
   * siblings in the same file still list.
   */
  list(cwd?: string): ResourceList<TItem> {
    const scope = defaultScope(this.locator);
    let found: ConfigTarget[];
    try {
      found = targets(this.locator, this.fileId, scope, cwd);
    } catch (error) {
      return { items: [], issues: [rejection(error, this.fileId, scope)] };
    }
    const items: TItem[] = [];
    const issues: ConfigIssue[] = [];
    const seen = new Set<string>();
    for (const target of found) {
      const document = target.file.read();
      const own: ConfigIssue[] = [];
      const entries = this.section.decode(document.value, {
        file: target.path,
        fileId: this.fileId,
        scope: target.scope,
        issues: own,
        pointer: configPointer,
      });
      issues.push(...tagged(document.issues, target), ...own);
      for (const [name, item] of Object.entries(entries)) {
        if (seen.has(name)) {
          continue;
        }
        seen.add(name);
        items.push(this.toItem({ name, item }));
      }
    }
    return { items, issues };
  }

  /** Save an item whose own `name` field names its section entry. */
  save(input: T, scope: ConfigScope, cwd?: string): ConfigMutation {
    return this.upsert(this.nameOf(input), input, scope, cwd);
  }

  /** Add or replace one named entry, keeping every other entry and document key. */
  upsert(name: string, item: T, scope: ConfigScope, cwd?: string): ConfigMutation {
    let file: ConfigFile;
    try {
      file = this.locator.file(this.fileId, scope, cwd);
    } catch (error) {
      return { ok: false, scope, issues: [rejection(error, this.fileId, scope)] };
    }
    if (name.trim().length === 0) {
      return {
        ok: false,
        path: file.path,
        scope,
        message: 'A config entry needs a name.',
        issues: [issue(file.path, this.fileId, scope, 'name', 'A config entry needs a name.')],
      };
    }
    const document = file.read();
    const root = documentRoot(document);
    if (root === undefined) {
      return {
        ok: false,
        path: file.path,
        scope,
        issues: [rootIssue(file.path, this.fileId, scope)],
      };
    }
    const existing = blockOf(root[this.section.key]);
    let encoded: unknown;
    try {
      encoded = this.section.encodeEntry(item, existing[name]);
    } catch (error) {
      return {
        ok: false,
        path: file.path,
        scope,
        issues: [
          issue(
            file.path,
            this.fileId,
            scope,
            'shape',
            messageOf(error),
            configPointer(this.section.key, name),
          ),
        ],
      };
    }
    const next: Record<string, unknown> = {
      ...root,
      [this.section.key]: { ...existing, [name]: encoded },
    };
    return file.write(next);
  }

  /** Remove one named entry from the scope's target; the block goes when empty. */
  remove(name: string, scope: ConfigScope, cwd?: string, _source?: string): ConfigMutation {
    let file: ConfigFile;
    try {
      file = this.locator.file(this.fileId, scope, cwd);
    } catch (error) {
      return { ok: false, scope, issues: [rejection(error, this.fileId, scope)] };
    }
    const document = file.read();
    const root = documentRoot(document);
    if (root === undefined) {
      return {
        ok: false,
        path: file.path,
        scope,
        issues: [rootIssue(file.path, this.fileId, scope)],
      };
    }
    const existing = blockOf(root[this.section.key]);
    if (!Object.hasOwn(existing, name)) {
      return {
        ok: false,
        path: file.path,
        scope,
        message: `No "${this.section.key}" entry named "${name}" is configured in ${file.path}.`,
        issues: [],
      };
    }
    const nextBlock = { ...existing };
    delete nextBlock[name];
    const next: Record<string, unknown> = { ...root };
    if (Object.keys(nextBlock).length === 0) {
      delete next[this.section.key];
    } else {
      next[this.section.key] = nextBlock;
    }
    return file.write(next);
  }

  /**
   * Replace the managed set. Unlisted entries are dropped unless the section
   * keeps them (`keepsOnReplace`); listed entries keep their unknown fields.
   */
  replaceManaged(
    items: readonly ConfigManagedEntry<T>[],
    scope: ConfigScope,
    cwd?: string,
  ): ConfigMutation {
    let file: ConfigFile;
    try {
      file = this.locator.file(this.fileId, scope, cwd);
    } catch (error) {
      return { ok: false, scope, issues: [rejection(error, this.fileId, scope)] };
    }
    const document = file.read();
    if (documentRoot(document) === undefined) {
      return {
        ok: false,
        path: file.path,
        scope,
        issues: [rootIssue(file.path, this.fileId, scope)],
      };
    }
    const applied = this.apply(document, items);
    if (applied.issues.length > 0) {
      return { ok: false, path: file.path, scope, issues: applied.issues };
    }
    return file.write(applied.value);
  }

  /**
   * Pure: compute the next whole document for a managed set, without touching
   * disk. A caller that also edits other sections composes on this value and
   * writes once.
   */
  apply(document: ConfigDocument, items: readonly ConfigManagedEntry<T>[]): ConfigApplyResult {
    const issues: ConfigIssue[] = [];
    const root = isPlainObject(document.value) ? document.value : {};
    const existing = blockOf(root[this.section.key]);
    const managed = new Map<string, T>();
    for (const input of items) {
      const entry = this.managedEntry(input);
      if (entry.name.trim().length === 0) {
        issues.push(
          issue(
            document.path,
            this.fileId,
            document.scope,
            'name',
            `${document.path}: a managed entry needs a name.`,
          ),
        );
        continue;
      }
      managed.set(entry.name, entry.item);
    }
    const nextBlock: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(existing)) {
      const item = managed.get(name);
      if (item !== undefined) {
        const encoded = this.encode(document, name, item, raw, issues);
        if (encoded !== undefined) {
          nextBlock[name] = encoded;
        }
        managed.delete(name);
      } else if (this.section.keepsOnReplace(raw)) {
        nextBlock[name] = raw;
      }
    }
    for (const [name, item] of managed) {
      const encoded = this.encode(document, name, item, existing[name], issues);
      if (encoded !== undefined) {
        nextBlock[name] = encoded;
      }
    }
    const value: Record<string, unknown> = { ...root };
    if (Object.keys(nextBlock).length === 0) {
      delete value[this.section.key];
    } else {
      value[this.section.key] = nextBlock;
    }
    return { value, issues };
  }

  /** Fix every existing, non-strict file in the scope's chain. */
  normalize(scope: ConfigScope, cwd?: string): ConfigMutation {
    let found: ConfigTarget[];
    try {
      found = targets(this.locator, this.fileId, scope, cwd);
    } catch (error) {
      return { ok: false, scope, issues: [rejection(error, this.fileId, scope)] };
    }
    return normalizeTargets(found, scope);
  }

  signature(cwd?: string): string {
    try {
      return targetsSignature(targets(this.locator, this.fileId, defaultScope(this.locator), cwd));
    } catch {
      return '';
    }
  }

  /** The item a listed entry becomes; the default drops the name (the item carries it). */
  protected toItem(entry: NamedConfigEntry<T>): TItem {
    return entry.item as unknown as TItem;
  }

  /** The entry name an item saves under; items managed by name expose `name`. */
  protected nameOf(item: T): string {
    const name = (item as { name?: unknown }).name;
    return typeof name === 'string' ? name : '';
  }

  /**
   * Normalize a managed-set input. A plain `{ name, item }` pair names itself;
   * otherwise the item's own `name` is used. A section whose value also has an
   * `item` key overrides this.
   */
  protected managedEntry(input: ConfigManagedEntry<T>): NamedConfigEntry<T> {
    if (isPlainObject(input) && typeof input['name'] === 'string' && 'item' in input) {
      return { name: input['name'], item: input['item'] as T };
    }
    return { name: this.nameOf(input as T), item: input as T };
  }

  private encode(
    document: ConfigDocument,
    name: string,
    item: T,
    kept: unknown,
    issues: ConfigIssue[],
  ): unknown {
    try {
      return this.section.encodeEntry(item, kept);
    } catch (error) {
      issues.push(
        issue(
          document.path,
          this.fileId,
          document.scope,
          'shape',
          `${document.path}: ${messageOf(error)}`,
          configPointer(this.section.key, name),
        ),
      );
      return undefined;
    }
  }
}

/** `project` for a user tree; an isolated tree has only its own global root. */
function defaultScope(locator: ConfigLocator): ConfigScope {
  return locator.ownership === 'isolated' ? 'global' : 'project';
}

/** The write target plus each read fallback, deduplicated and tagged with its scope. */
function targets(
  locator: ConfigLocator,
  fileId: string,
  scope: ConfigScope,
  cwd?: string,
): ConfigTarget[] {
  const paths = locator.paths(fileId, scope, cwd);
  const ordered: string[] = [];
  for (const path of [paths.write, ...paths.read]) {
    if (!ordered.includes(path)) {
      ordered.push(path);
    }
  }
  return ordered.map((path) => {
    const targetScope: ConfigScope =
      locator.ownership === 'isolated' || path !== paths.write ? 'global' : scope;
    return { path, scope: targetScope, file: fileAt(locator, fileId, path, targetScope, cwd) };
  });
}

/** Open the file for a path, preferring the scope it was resolved under. */
function fileAt(
  locator: ConfigLocator,
  fileId: string,
  path: string,
  scope: ConfigScope,
  cwd?: string,
): ConfigFile {
  const file = locator.file(fileId, scope, cwd);
  if (file.path === path) {
    return file;
  }
  const alternate: ConfigScope = scope === 'project' ? 'global' : 'project';
  try {
    const other = locator.file(fileId, alternate, cwd);
    if (other.path === path) {
      return other;
    }
  } catch {
    // The engine has no such scope; keep the requested file.
  }
  return file;
}

/** The section block as a name-to-raw map; a malformed block reads as empty. */
function blockOf(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

/** The document root object, or `undefined` when the file holds a non-object value. */
function documentRoot(document: ConfigDocument): Record<string, unknown> | undefined {
  if (document.value === undefined) {
    return {};
  }
  return isPlainObject(document.value) ? document.value : undefined;
}

function rootIssue(path: string, fileId: string, scope: ConfigScope): ConfigIssue {
  return issue(
    path,
    fileId,
    scope,
    'shape',
    `${path}: expected a JSON object at the document root.`,
  );
}

function tagged(issues: ConfigIssue[], target: ConfigTarget): ConfigIssue[] {
  return issues.map((existing) => ({
    ...existing,
    file: existing.file || target.path,
    scope: target.scope,
  }));
}

function normalizeTargets(found: ConfigTarget[], scope: ConfigScope): ConfigMutation {
  const issues: ConfigIssue[] = [];
  let ok = true;
  let path: string | undefined;
  for (const target of found) {
    const document = target.file.read();
    if (!document.exists) {
      continue;
    }
    if (document.strict && document.issues.length === 0) {
      continue;
    }
    const fixed = target.file.normalize();
    path ??= fixed.path;
    if (!fixed.ok) {
      ok = false;
    }
    issues.push(...fixed.issues);
  }
  return { ok, path, scope, issues };
}

function targetsSignature(found: ConfigTarget[]): string {
  return found.map((target) => target.file.signature()).join(',');
}

/** A locator that refuses a scope becomes an unsupported issue, never a throw. */
function rejection(error: unknown, fileId: string, scope: ConfigScope): ConfigIssue {
  const carried = (error as { issue?: ConfigIssue }).issue;
  if (carried !== undefined) {
    return { ...carried, fileId: carried.fileId || fileId, scope };
  }
  return {
    file: (error as { path?: string }).path ?? '',
    fileId,
    scope,
    code: 'unsupported',
    message: messageOf(error),
    fixable: false,
  };
}

function issue(
  file: string,
  fileId: string,
  scope: ConfigScope,
  code: ConfigIssueCode,
  message: string,
  pointer?: string,
): ConfigIssue {
  return { file, fileId, scope, pointer, code, message, fixable: false };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
