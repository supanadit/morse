/**
 * The two config-section stores. `ConfigResourceStore` manages named entries
 * inside one block of a JSON document; `ConfigStore` owns the whole document.
 * Both read the file chain the locator resolves (highest precedence first),
 * keep everything they do not manage, delete a block once it empties, and turn
 * every failure into an issue instead of a throw.
 */
import type { ConfigIssue, ConfigIssueCode, ConfigMutation, ConfigScope } from '@morse/protocol';

import { UnsupportedScopeError, type ConfigLocator } from '../engine/locator.js';
import { ResourceStore, type ResourceList } from '../resource/resource-store.js';
import type { ConfigFile } from './config-file.js';
import {
  configPointer,
  isPlainObject,
  type ConfigSection,
  type NamedConfigSection,
} from './section.js';
import type { ConfigDocument, ConfigPaths } from './types.js';

/** What `apply` computed: the next whole document value and its complaints. */
export interface ConfigApplyResult {
  value: unknown;
  issues: ConfigIssue[];
}

/** One file of a precedence chain after it was read. */
export interface ConfigDocumentSource {
  path: string;
  scope: ConfigScope;
  document: ConfigDocument;
}

/** What `ConfigStore.read` found in the defining document. */
export interface ConfigStoreRead<T> {
  path: string;
  scope: ConfigScope;
  value?: T;
  document?: ConfigDocument;
  issues: ConfigIssue[];
}

/** One file in a precedence chain: its path, resolved scope and handle. */
interface ConfigTarget {
  path: string;
  scope: ConfigScope;
  file: ConfigFile;
}

type WriteTargetResult = { target: ConfigTarget } | { issue: ConfigIssue };

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

  file(scope?: ConfigScope, cwd?: string): ConfigFile {
    return this.locator.file(this.fileId, scope ?? defaultConfigScope(this.locator, cwd), cwd);
  }

  /**
   * Decode the first document in the scope's chain that has a value. A missing
   * or empty higher-precedence file falls through to its fallback; issues from
   * every document consulted are reported.
   */
  read(scope?: ConfigScope, cwd?: string): ConfigStoreRead<T> {
    const targetScope = scope ?? defaultConfigScope(this.locator, cwd);
    let found: ConfigTarget[];
    try {
      found = chain(this.locator, this.fileId, targetScope, cwd);
    } catch (error) {
      return {
        path: '',
        scope: targetScope,
        issues: [rejection(error, this.fileId, targetScope, 'read')],
      };
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
    return { path: found[0]?.path ?? '', scope: targetScope, issues };
  }

  /** Encode the section into the scope's write target, preserving its other keys. */
  save(item: T, scope?: ConfigScope, cwd?: string): ConfigMutation {
    const targetScope = scope ?? defaultConfigScope(this.locator, cwd);
    const resolved = writeTarget(this.locator, this.fileId, targetScope, cwd);
    if ('issue' in resolved) {
      return { ok: false, scope: targetScope, issues: [resolved.issue] };
    }
    const file = resolved.target.file;
    const document = file.read();
    if (document.value !== undefined && !isPlainObject(document.value)) {
      return {
        ok: false,
        path: file.path,
        scope: targetScope,
        issues: [rootIssue(file.path, this.fileId, targetScope)],
      };
    }
    let value: unknown;
    try {
      value = this.section.encode(item, document.value);
    } catch (error) {
      return {
        ok: false,
        path: file.path,
        scope: targetScope,
        issues: [issue(file.path, this.fileId, targetScope, 'shape', messageOf(error))],
      };
    }
    return file.write(value);
  }

  /** Fix every existing, non-strict file in the scope's chain. */
  normalize(scope?: ConfigScope, cwd?: string): ConfigMutation {
    const targetScope = scope ?? defaultConfigScope(this.locator, cwd);
    let found: ConfigTarget[];
    try {
      found = chain(this.locator, this.fileId, targetScope, cwd);
    } catch (error) {
      return {
        ok: false,
        scope: targetScope,
        issues: [rejection(error, this.fileId, targetScope, 'read')],
      };
    }
    return normalizeTargets(found, targetScope);
  }

  signature(cwd?: string): string {
    try {
      return chainSignature(
        chain(this.locator, this.fileId, defaultConfigScope(this.locator, cwd), cwd),
      );
    } catch {
      return '';
    }
  }
}

export abstract class ConfigResourceStore<
  T extends { name: string },
  TItem = T,
> extends ResourceStore<TItem, T> {
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

  file(scope?: ConfigScope, cwd?: string): ConfigFile {
    return this.locator.file(this.fileId, scope ?? defaultConfigScope(this.locator, cwd), cwd);
  }

  /**
   * The whole read chain as documents, highest precedence first. Subclasses
   * reuse it for their own listings; it throws only when the locator cannot
   * resolve the chain, which the concrete operations catch.
   */
  protected documents(cwd?: string): ConfigDocumentSource[] {
    return chain(this.locator, this.fileId, defaultConfigScope(this.locator, cwd), cwd).map(
      (target) => ({
        path: target.path,
        scope: target.scope,
        document: target.file.read(),
      }),
    );
  }

  /**
   * Every entry the read chain defines, highest precedence first, with the
   * first name winning. A malformed file yields its siblings; a malformed entry
   * is skipped with its pointer.
   */
  list(cwd?: string): ResourceList<TItem> {
    const scope = defaultConfigScope(this.locator, cwd);
    let sources: ConfigDocumentSource[];
    try {
      sources = this.documents(cwd);
    } catch (error) {
      return { items: [], issues: [rejection(error, this.fileId, scope, 'read')] };
    }
    const items: TItem[] = [];
    const issues: ConfigIssue[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      const own: ConfigIssue[] = [];
      const entries = this.section.decode(source.document.value, {
        file: source.path,
        fileId: this.fileId,
        scope: source.scope,
        issues: own,
        pointer: configPointer,
      });
      issues.push(...tagged(source.document.issues, source), ...own);
      for (const [name, item] of Object.entries(entries)) {
        if (seen.has(name)) {
          continue;
        }
        seen.add(name);
        items.push(this.toItem(item, source.path, source.scope));
      }
    }
    return { items, issues };
  }

  /** Save an entry; its `name` field keys the section entry. */
  save(input: T, scope: ConfigScope, cwd?: string): ConfigMutation {
    return this.upsert(input.name, input, scope, cwd);
  }

  /** Add or replace one named entry, keeping every other entry and document key. */
  upsert(name: string, item: T, scope: ConfigScope, cwd?: string): ConfigMutation {
    const resolved = writeTarget(this.locator, this.fileId, scope, cwd);
    if ('issue' in resolved) {
      return { ok: false, scope, issues: [resolved.issue] };
    }
    const file = resolved.target.file;
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

  /**
   * Remove one entry from the scope's write target. The block is deleted when
   * it empties. A name defined only in a read fallback is refused: a mutation
   * never writes a fallback file.
   */
  remove(name: string, scope: ConfigScope, cwd?: string, _source?: string): ConfigMutation {
    const resolved = writeTarget(this.locator, this.fileId, scope, cwd);
    if ('issue' in resolved) {
      return { ok: false, scope, issues: [resolved.issue] };
    }
    const file = resolved.target.file;
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
      const message = `No "${this.section.key}" entry named "${name}" is configured in ${file.path}; a ${scope} mutation does not edit a read fallback.`;
      return {
        ok: false,
        path: file.path,
        scope,
        message,
        issues: [
          issue(
            file.path,
            this.fileId,
            scope,
            'unsupported',
            message,
            configPointer(this.section.key, name),
          ),
        ],
      };
    }
    const nextBlock: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [entryName, raw] of Object.entries(existing)) {
      if (entryName !== name) {
        nextBlock[entryName] = raw;
      }
    }
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
  replaceManaged(items: readonly T[], scope: ConfigScope, cwd?: string): ConfigMutation {
    const resolved = writeTarget(this.locator, this.fileId, scope, cwd);
    if ('issue' in resolved) {
      return { ok: false, scope, issues: [resolved.issue] };
    }
    const file = resolved.target.file;
    const applied = this.apply(file.read(), items);
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
  apply(document: ConfigDocument, items: readonly T[]): ConfigApplyResult {
    if (document.value !== undefined && !isPlainObject(document.value)) {
      return {
        value: undefined,
        issues: [rootIssue(document.path, this.fileId, document.scope)],
      };
    }
    const issues: ConfigIssue[] = [];
    const root = isPlainObject(document.value) ? document.value : {};
    const existing = blockOf(root[this.section.key]);
    const managed = new Map<string, T>();
    for (const item of items) {
      if (item.name.trim().length === 0) {
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
      managed.set(item.name, item);
    }
    const nextBlock: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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
      found = chain(this.locator, this.fileId, scope, cwd);
    } catch (error) {
      return { ok: false, scope, issues: [rejection(error, this.fileId, scope, 'read')] };
    }
    return normalizeTargets(found, scope);
  }

  signature(cwd?: string): string {
    try {
      return chainSignature(
        chain(this.locator, this.fileId, defaultConfigScope(this.locator, cwd), cwd),
      );
    } catch {
      return '';
    }
  }

  /** The item a listed entry becomes; `source` is the file that defined it. */
  protected toItem(item: T, _source: string, _scope: ConfigScope): TItem {
    return item as unknown as TItem;
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

/**
 * The scope an unnamed read or write uses. An isolated tree has only its own
 * global root, and a call without a session directory has no project to read,
 * so both fall back to the engine's global files. A caller that names a session
 * directory gets the project chain (project first, then global).
 */
export function defaultConfigScope(locator: ConfigLocator, cwd?: string): ConfigScope {
  if (locator.ownership === 'isolated') {
    return 'global';
  }
  return cwd === undefined || cwd.length === 0 ? 'global' : 'project';
}

/**
 * The whole precedence chain: read paths in order, then the write target when
 * it is not already read. Every path is opened by path so a chain may hold
 * more than the project and global files.
 */
function chain(
  locator: ConfigLocator,
  fileId: string,
  scope: ConfigScope,
  cwd?: string,
): ConfigTarget[] {
  const paths = locator.paths(fileId, scope, cwd);
  const ordered: string[] = [];
  for (const path of paths.read) {
    if (!ordered.includes(path)) {
      ordered.push(path);
    }
  }
  if (!ordered.includes(paths.write)) {
    ordered.push(paths.write);
  }
  return ordered.map((path) => {
    const targetScope = locator.scopeOf(fileId, path);
    return { path, scope: targetScope, file: locator.fileAt(fileId, path, targetScope) };
  });
}

/** Resolve and open the scope's write target, or report why it cannot be opened. */
function writeTarget(
  locator: ConfigLocator,
  fileId: string,
  scope: ConfigScope,
  cwd?: string,
): WriteTargetResult {
  let path: string | undefined;
  try {
    const paths = locator.paths(fileId, scope, cwd);
    path = paths.write;
    const targetScope = locator.scopeOf(fileId, paths.write);
    return {
      target: {
        path: paths.write,
        scope: targetScope,
        file: locator.fileAt(fileId, paths.write, targetScope),
      },
    };
  } catch (error) {
    return { issue: rejection(error, fileId, scope, 'write', path) };
  }
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

function tagged(
  issues: ConfigIssue[],
  source: { path: string; scope: ConfigScope },
): ConfigIssue[] {
  return issues.map((existing) => ({
    ...existing,
    file: existing.file || source.path,
    scope: source.scope,
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

function chainSignature(found: ConfigTarget[]): string {
  return found.map((target) => target.file.signature()).join(',');
}

/**
 * A locator's typed scope refusal becomes `unsupported`; any other thrown error
 * is a real read/write failure. The issue names the would-be path when one is
 * known — the engines put it on the refusal — and otherwise leaves `file`
 * empty: a bare file id is not a path, and the panel would print it as one.
 */
function rejection(
  error: unknown,
  fileId: string,
  scope: ConfigScope,
  intent: 'read' | 'write',
  path?: string,
): ConfigIssue {
  const known = path ?? (error instanceof UnsupportedScopeError ? error.path : undefined) ?? '';
  if (error instanceof UnsupportedScopeError) {
    return {
      file: known,
      fileId,
      scope,
      code: 'unsupported',
      message: error.message,
      fixable: false,
    };
  }
  const message = messageOf(error);
  return {
    file: known,
    fileId,
    scope,
    code: intent,
    message: path !== undefined ? `${path}: ${message}` : message,
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
