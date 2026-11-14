/**
 * The engine-neutral MCP store. An engine supplies the block key, the entry
 * codec and (optionally) a project-override writer; this base validates names,
 * merges an override onto the server it modifies, and keeps every operation's
 * failures as issues.
 */
import type { ConfigIssue, ConfigMutation, ConfigScope, McpServer } from '@morse/protocol';

import { ConfigResourceStore, type ConfigDocumentSource } from '../core/config-store.js';
import { configPointer, isPlainObject } from '../core/section.js';
import type { SectionContext } from '../core/types.js';
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
interface McpDefinition {
  server: McpServer;
  source: string;
  scope: ConfigScope;
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
      const entries = this.section.decode(source.document.value, {
        file: source.path,
        fileId: this.fileId,
        scope: source.scope,
        issues,
        pointer: configPointer,
      });
      const block = blockOf(source.document.value, this.section.key);
      for (const [name, server] of Object.entries(entries)) {
        if (!isValidMcpServerName(name)) {
          issues.push(this.nameIssue(name, source));
          continue;
        }
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
   * Enable or disable one server. In the project scope an engine with an
   * override mechanism (pi) writes an override so a user-level server changes
   * for this project only. Otherwise the defining entry is edited in place —
   * and a project change to a user-level server is refused when the engine has
   * no way to express it.
   */
  setEnabled(name: string, enabled: boolean, scope: ConfigScope, cwd?: string): ConfigMutation {
    if (!isValidMcpServerName(name)) {
      return this.refusal(scope, cwd, 'name', invalidMcpServerNameMessage(name), name);
    }

    if (scope === 'project' && cwd !== undefined) {
      const overridden = this.writeProjectOverride(name, enabled, cwd);
      if (overridden !== undefined) {
        return overridden;
      }
    }

    const definition = this.findDefinition(name, cwd);
    if (definition === undefined) {
      const message = `No server named "${name}" is configured.`;
      return this.refusal(scope, cwd, 'name', message, name);
    }

    if (scope === 'project' && definition.scope !== 'project') {
      const message = `"${name}" is defined in ${definition.source}; this engine cannot write a project override.`;
      return {
        ok: false,
        path: definition.source,
        scope,
        message,
        issues: [this.issue(definition.source, scope, 'unsupported', message, name)],
      };
    }

    return this.upsert(name, withEnabled(definition.server, enabled), definition.scope, cwd);
  }

  /**
   * The engine's project-override writer. `undefined` means the engine has no
   * override concept (or cannot write one here), so the store edits the
   * defining entry instead. pi overrides this.
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

  /** The nearest file that defines `name` (not merely overrides it). */
  private findDefinition(name: string, cwd?: string): McpDefinition | undefined {
    let sources: ConfigDocumentSource[];
    try {
      sources = this.documents(cwd);
    } catch {
      return undefined;
    }
    for (const source of sources) {
      const block = blockOf(source.document.value, this.section.key);
      if (!Object.hasOwn(block, name)) {
        continue;
      }
      const raw = block[name];
      if (this.section.isOverride(raw)) {
        continue;
      }
      const context: SectionContext = {
        file: source.path,
        fileId: this.fileId,
        scope: source.scope,
        issues: [],
        pointer: configPointer,
      };
      const server = this.section.decodeEntry(name, raw, context);
      if (server !== undefined) {
        return { server, source: source.path, scope: source.scope };
      }
    }
    return undefined;
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
    code: 'name' | 'unsupported' | 'read',
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
    const scope = this.locator.ownership === 'isolated' ? 'global' : 'project';
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
