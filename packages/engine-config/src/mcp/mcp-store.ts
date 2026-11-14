/**
 * The engine-neutral MCP store. An engine supplies the block key, the entry
 * codec and (optionally) a project-override writer; this base validates names,
 * merges an override onto the server it modifies, and keeps every operation's
 * failures as issues.
 */
import type {
  ConfigIssue,
  ConfigIssueCode,
  ConfigMutation,
  ConfigScope,
  McpServer,
} from '@morse/protocol';

import { ConfigResourceStore, type ConfigDocumentSource } from '../core/config-store.js';
import { configPointer, isPlainObject } from '../core/section.js';
import { UnsupportedScopeError, type ConfigLocator } from '../engine/locator.js';
import type { ResourceList } from '../resource/resource-store.js';
import type { McpSection } from './mcp-section.js';
import { invalidMcpServerNameMessage, isValidMcpServerName } from './names.js';

/** One listed server: the neutral server, where it is defined, and its override. */
export interface McpServerEntry {
  server: McpServer;
  scope: ConfigScope;
  source: string;
  /** The higher-precedence file that only overrides this server, when there is one. */
  override?: string;
}

/** A file in the read chain that defines a server rather than overriding one. */
export interface McpDefinition {
  server: McpServer;
  source: string;
  scope: ConfigScope;
}

/** The nearest definition in each scope, plus the issues met while looking. */
export interface McpDefinitions {
  project?: McpDefinition;
  global?: McpDefinition;
  issues: ConfigIssue[];
}

/** The nearest definition overall (project first, then global), with its lookup issues. */
export interface McpDefinitionLookup {
  definition?: McpDefinition;
  issues: ConfigIssue[];
}

/** An override-only entry waiting for the server definition it modifies. */
interface PendingOverride {
  server: McpServer;
  source: ConfigDocumentSource;
  index: number;
}

export abstract class McpStore extends ConfigResourceStore<McpServer, McpServerEntry> {
  override readonly section: McpSection;

  protected constructor(locator: ConfigLocator, fileId: string, section: McpSection) {
    super(locator, fileId);
    this.section = section;
  }

  /**
   * List the whole chain, highest precedence first. A nearer full entry shadows
   * a farther one; an override-only entry is merged onto the definition it
   * modifies, so a project can pin `enabled`/`exposure` without repeating the
   * command. Bad names and malformed entries are skipped with an issue.
   */
  override list(cwd?: string): ResourceList<McpServerEntry> {
    let sources: ConfigDocumentSource[];
    try {
      sources = this.documents(cwd);
    } catch (error) {
      return { items: [], issues: [this.readIssue(error)] };
    }

    const issues: ConfigIssue[] = [];
    const found = new Map<string, McpServerEntry>();
    const foundAt = new Map<string, number>();
    const overrides = new Map<string, PendingOverride>();

    sources.forEach((source, index) => {
      issues.push(...source.document.issues);
      const root = source.document.value;
      const block = blockOf(root, this.section.key);
      // Validate names before decoding so an invalid name with a non-object
      // value is a `name` issue, not only the section's `shape` complaint.
      let decoded = root;
      if (isPlainObject(root) && isPlainObject(root[this.section.key])) {
        const valid: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [name, raw] of Object.entries(block)) {
          if (isValidMcpServerName(name)) {
            valid[name] = raw;
          } else {
            issues.push(this.nameIssue(name, source));
          }
        }
        decoded = { ...root, [this.section.key]: valid };
      }
      const entries = this.section.decode(decoded, {
        file: source.path,
        fileId: this.fileId,
        scope: source.scope,
        issues,
        pointer: configPointer,
      });
      for (const [name, server] of Object.entries(entries)) {
        if (this.section.isOverride(block[name])) {
          if (!overrides.has(name)) {
            overrides.set(name, { server, source, index });
          }
          continue;
        }
        if (!found.has(name)) {
          found.set(name, { server, scope: source.scope, source: source.path });
          foundAt.set(name, index);
        }
      }
    });

    for (const [name, pending] of overrides) {
      const base = found.get(name);
      if (base === undefined) {
        // No definition to modify: the entry stands on its own (the engine
        // decides whether that is meaningful).
        found.set(name, {
          server: pending.server,
          scope: pending.source.scope,
          source: pending.source.path,
        });
        continue;
      }
      // An override in a lower-precedence file cannot modify a nearer entry.
      if (pending.index > (foundAt.get(name) ?? -1)) {
        continue;
      }
      found.set(name, {
        server: this.mergeOverride(base.server, pending.server),
        scope: base.scope,
        source: base.source,
        override: pending.source.path,
      });
    }

    return { items: [...found.values()], issues };
  }

  override save(input: McpServer, scope: ConfigScope, cwd?: string): ConfigMutation {
    return this.upsert(input.name, input, scope, cwd);
  }

  override upsert(name: string, item: McpServer, scope: ConfigScope, cwd?: string): ConfigMutation {
    if (!isValidMcpServerName(name)) {
      return this.refusal(scope, cwd, 'name', invalidMcpServerNameMessage(name), name);
    }
    return super.upsert(name, item, scope, cwd);
  }

  /**
   * Replace the managed set, refusing the whole write when a name is unusable.
   * The wizard passes names straight from its form, so one bad row must not
   * produce a file the engine cannot read back.
   */
  override replaceManaged(
    items: readonly McpServer[],
    scope: ConfigScope,
    cwd?: string,
  ): ConfigMutation {
    const invalid = items.filter((item) => !isValidMcpServerName(item.name));
    if (invalid.length === 0) {
      return super.replaceManaged(items, scope, cwd);
    }
    const path = this.writePath(scope, cwd);
    const issues = invalid.map((item) =>
      this.issue(
        path ?? this.fileId,
        scope,
        'name',
        invalidMcpServerNameMessage(item.name),
        item.name,
      ),
    );
    return {
      ok: false,
      ...(path === undefined ? {} : { path }),
      scope,
      message: issues[0]?.message,
      issues,
    };
  }

  /**
   * Enable or disable one server. The scope chooses the target:
   * - `undefined` edits the nearest definition (project first, then global);
   * - `'global'` edits only the global file;
   * - `'project'` edits a project definition in place, asks an engine with an
   *   override mechanism (pi) to pin a user-level server for this project, and
   *   refuses when the engine cannot express that edit.
   */
  setEnabled(
    name: string,
    enabled: boolean,
    scope: ConfigScope | undefined,
    cwd?: string,
  ): ConfigMutation {
    const issueScope = scope ?? this.defaultScope();
    if (!isValidMcpServerName(name)) {
      return this.refusal(issueScope, cwd, 'name', invalidMcpServerNameMessage(name), name);
    }

    const found = this.findDefinitions(name, cwd);
    const definition =
      scope === 'global'
        ? found.global
        : scope === 'project'
          ? found.project
          : (found.project ?? found.global);

    if (scope === 'project' && found.project === undefined && found.global !== undefined) {
      if (cwd !== undefined) {
        const overridden = this.writeProjectOverride(name, enabled, cwd);
        if (overridden !== undefined) {
          return this.withIssues(overridden, found.issues);
        }
      }
      const message = `"${name}" is defined in ${found.global.source}; this engine cannot write a project override.`;
      return {
        ok: false,
        path: found.global.source,
        scope,
        message,
        issues: [
          ...found.issues,
          this.issue(found.global.source, scope, 'unsupported', message, name),
        ],
      };
    }

    if (definition === undefined) {
      return this.missing(name, scope, issueScope, cwd, found.issues);
    }

    const written = this.writeEntry(definition, name, withEnabled(definition.server, enabled));
    return this.withIssues(written, found.issues);
  }

  /**
   * The engine's project-override writer. It is only consulted when the server
   * is user-level (defined globally, not in the project) and the caller asked
   * for the project scope. `undefined` means the engine has no override concept
   * (or cannot write one here), so a project edit is refused. pi overrides
   * this; it can call `findDefinitions`/`findDefinition` rather than re-read.
   */
  protected writeProjectOverride(
    _name: string,
    _enabled: boolean,
    _cwd: string,
  ): ConfigMutation | undefined {
    return undefined;
  }

  /**
   * Apply an override-only entry to the server it modifies. Only the keys the
   * override sets change; pi extends this with its own override-only fields.
   */
  protected mergeOverride(base: McpServer, override: McpServer): McpServer {
    const merged: McpServer = { ...base };
    if (override.enabled !== undefined) {
      merged.enabled = override.enabled;
    }
    if (override.exposure !== undefined) {
      merged.exposure = override.exposure;
    }
    return merged;
  }

  /**
   * The nearest definition in each scope, with every parse/shape issue met on
   * the way. Never answers "not found" when a file or entry could not be read.
   */
  protected findDefinitions(name: string, cwd?: string): McpDefinitions {
    let sources: ConfigDocumentSource[];
    try {
      sources = this.documents(cwd);
    } catch (error) {
      return { issues: [this.readIssue(error)] };
    }

    const issues: ConfigIssue[] = [];
    let project: McpDefinition | undefined;
    let global: McpDefinition | undefined;

    for (const source of sources) {
      issues.push(...source.document.issues);
      const root = source.document.value;
      if (root === undefined) {
        continue;
      }
      if (!isPlainObject(root)) {
        issues.push(this.issue(source.path, source.scope, 'shape', `${source.path}: expected a JSON object.`));
        continue;
      }
      const block = root[this.section.key];
      if (block === undefined || block === null) {
        continue;
      }
      if (!isPlainObject(block)) {
        issues.push(
          this.issue(
            source.path,
            source.scope,
            'shape',
            `${source.path}: "${this.section.key}" must be an object.`,
            this.section.key,
          ),
        );
        continue;
      }
      if (!Object.hasOwn(block, name)) {
        continue;
      }
      const raw = block[name];
      if (this.section.isOverride(raw)) {
        continue;
      }
      // Decode only the entry being looked up, so an unrelated malformed
      // sibling does not hide a usable definition.
      const own: ConfigIssue[] = [];
      const entries = this.section.decode(
        { ...root, [this.section.key]: { [name]: raw } },
        {
          file: source.path,
          fileId: this.fileId,
          scope: source.scope,
          issues: own,
          pointer: configPointer,
        },
      );
      issues.push(...own);
      const server = entries[name];
      if (server === undefined) {
        continue;
      }
      const definition: McpDefinition = { server, source: source.path, scope: source.scope };
      if (source.scope === 'project') {
        project ??= definition;
      } else {
        global ??= definition;
      }
      if (project !== undefined && global !== undefined) {
        break;
      }
    }

    return { project, global, issues };
  }

  /** The nearest definition overall (project first, then global). */
  protected findDefinition(name: string, cwd?: string): McpDefinitionLookup {
    const found = this.findDefinitions(name, cwd);
    return { definition: found.project ?? found.global, issues: found.issues };
  }

  /**
   * Edit one entry in the file that defines it. Unlike `upsert`, this does not
   * write `paths(scope).write`: a definition may live in a read fallback (an
   * ancestor or a `.jsonc` sibling), and the edit must land there.
   */
  private writeEntry(
    definition: McpDefinition,
    name: string,
    server: McpServer,
  ): ConfigMutation {
    const file = this.locator.fileAt(this.fileId, definition.source, definition.scope);
    const document = file.read();
    if (document.value !== undefined && !isPlainObject(document.value)) {
      return {
        ok: false,
        path: file.path,
        scope: definition.scope,
        issues: [
          this.issue(
            file.path,
            definition.scope,
            'shape',
            `${file.path}: expected a JSON object at the document root.`,
          ),
        ],
      };
    }
    const root = isPlainObject(document.value) ? document.value : {};
    const existing = root[this.section.key];
    const block = isPlainObject(existing) ? existing : {};
    let encoded: unknown;
    try {
      encoded = this.section.encodeEntry(server, block[name]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        path: file.path,
        scope: definition.scope,
        issues: [
          this.issue(
            file.path,
            definition.scope,
            'shape',
            `${file.path}: ${message}`,
            name,
          ),
        ],
      };
    }
    return file.write({ ...root, [this.section.key]: { ...block, [name]: encoded } });
  }

  private missing(
    name: string,
    scope: ConfigScope | undefined,
    issueScope: ConfigScope,
    cwd: string | undefined,
    issues: ConfigIssue[],
  ): ConfigMutation {
    const first = issues[0];
    if (first !== undefined) {
      return {
        ok: false,
        path: first.file,
        scope: issueScope,
        message: first.message,
        issues,
      };
    }
    const message =
      scope === 'global'
        ? `No server named "${name}" is configured in the global file.`
        : `No server named "${name}" is configured.`;
    return this.refusal(issueScope, cwd, 'name', message, name);
  }

  private withIssues(mutation: ConfigMutation, issues: ConfigIssue[]): ConfigMutation {
    return issues.length === 0 ? mutation : { ...mutation, issues: [...issues, ...mutation.issues] };
  }

  private refusal(
    scope: ConfigScope,
    cwd: string | undefined,
    code: 'name',
    message: string,
    name: string,
  ): ConfigMutation {
    const path = this.writePath(scope, cwd);
    return {
      ok: false,
      ...(path === undefined ? {} : { path }),
      scope,
      message,
      issues: [this.issue(path ?? this.fileId, scope, code, message, name)],
    };
  }

  private writePath(scope: ConfigScope, cwd?: string): string | undefined {
    try {
      return this.paths(scope, cwd).write;
    } catch {
      return undefined;
    }
  }

  private defaultScope(): ConfigScope {
    return this.locator.ownership === 'isolated' ? 'global' : 'project';
  }

  private nameIssue(name: string, source: ConfigDocumentSource): ConfigIssue {
    return this.issue(
      source.path,
      source.scope,
      'name',
      invalidMcpServerNameMessage(name),
      name,
    );
  }

  private issue(
    file: string,
    scope: ConfigScope,
    code: ConfigIssueCode,
    message: string,
    pointerName?: string,
  ): ConfigIssue {
    return {
      file,
      fileId: this.fileId,
      scope,
      pointer:
        pointerName === undefined ? undefined : configPointer(this.section.key, pointerName),
      code,
      message,
      fixable: false,
    };
  }

  /** A chain the locator refused to resolve: `unsupported` or a real read failure. */
  private readIssue(error: unknown): ConfigIssue {
    const scope = this.defaultScope();
    if (error instanceof UnsupportedScopeError) {
      return {
        file: error.path ?? this.fileId,
        fileId: this.fileId,
        scope,
        code: 'unsupported',
        message: error.message,
        fixable: false,
      };
    }
    return {
      file: this.fileId,
      fileId: this.fileId,
      scope,
      code: 'read',
      message: error instanceof Error ? error.message : String(error),
      fixable: false,
    };
  }
}

/** The section block as a name-to-raw map; a malformed block reads as empty. */
function blockOf(value: unknown, key: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return {};
  }
  const block = value[key];
  return isPlainObject(block) ? block : {};
}

/** The neutral convention: absent `enabled` means enabled. */
function withEnabled(server: McpServer, enabled: boolean): McpServer {
  const next: McpServer = { ...server };
  if (enabled) {
    delete next.enabled;
  } else {
    next.enabled = false;
  }
  return next;
}
