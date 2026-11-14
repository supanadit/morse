/**
 * pi's MCP store. Beyond the shared block mechanics it knows two pi-only rules:
 * a project entry with no transport *overrides* a user-level server instead of
 * defining one, and such an override is how "disabled in this project" is
 * written without touching the user's `mcp.json`.
 */
import {
  McpStore,
  isPlainObject,
  isValidMcpServerName,
  type ConfigLocator,
  type ConfigMutation,
  type ConfigScope,
  type McpServer,
  type McpServerEntry,
  type ResourceList,
} from '@morse/engine-config';

import { PiMcpSection } from './pi-mcp-section.js';

export class PiMcpStore extends McpStore {
  constructor(locator: ConfigLocator) {
    super(locator, 'mcp', new PiMcpSection());
  }

  /**
   * A standalone override (one with no server to modify) is not a server pi
   * would load, so it is not listed; it stays editable through `setEnabled`.
   */
  override list(cwd?: string): ResourceList<McpServerEntry> {
    const listed = super.list(cwd);
    return { ...listed, items: listed.items.filter((entry) => definesServer(entry.server)) };
  }

  /**
   * The base only routes to the override hook when a global definition exists.
   * pi also let an orphan project override be turned back on, so a project edit
   * with no project definition gets one attempt first; the hook answers
   * `undefined` when there is nothing to override, and the base then refuses.
   */
  override setEnabled(
    name: string,
    enabled: boolean,
    scope: ConfigScope | undefined,
    cwd?: string,
  ): ConfigMutation {
    if (
      scope === 'project' &&
      cwd !== undefined &&
      this.locator.ownership === 'user' &&
      isValidMcpServerName(name)
    ) {
      const found = this.findDefinitions(name, cwd);
      if (found.project === undefined) {
        const written = this.writeProjectOverride(name, enabled, cwd);
        if (written !== undefined) {
          return found.issues.length === 0
            ? written
            : { ...written, issues: [...found.issues, ...(written.issues ?? [])] };
        }
      }
    }
    return super.setEnabled(name, enabled, scope, cwd);
  }

  /**
   * Apply an override to the server it modifies: only the keys pi lets a
   * project pin change; the transport, env and headers stay the base's.
   */
  protected override mergeOverride(base: McpServer, override: McpServer): McpServer {
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
   * Write (or clear) this project's override of a user-level server. Disabling
   * stores `enabled: false` and keeps any other override keys; enabling removes
   * the key and deletes the entry, and then the block, once it is empty.
   *
   * `undefined` means this name has nothing to override here: no global
   * definition and no existing project override.
   */
  protected override writeProjectOverride(
    name: string,
    enabled: boolean,
    cwd: string,
  ): OverrideMutation | undefined {
    let file;
    try {
      file = this.locator.file(this.fileId, 'project', cwd);
    } catch {
      return undefined;
    }
    const found = this.findDefinitions(name, cwd);
    const document = file.read();
    const root = document.value;
    if (root !== undefined && !isPlainObject(root)) {
      return {
        ok: false,
        path: file.path,
        scope: 'project',
        issues: [
          {
            file: file.path,
            fileId: this.fileId,
            scope: 'project',
            code: 'shape',
            message: `${file.path}: expected a JSON object at the document root.`,
            fixable: false,
          },
        ],
      };
    }
    const record = isPlainObject(root) ? root : {};
    const current = record[this.section.key];
    if (current !== undefined && current !== null && !isPlainObject(current)) {
      return {
        ok: false,
        path: file.path,
        scope: 'project',
        issues: [
          {
            file: file.path,
            fileId: this.fileId,
            scope: 'project',
            code: 'shape',
            message: `${file.path}: "${this.section.key}" must be an object.`,
            fixable: false,
          },
        ],
      };
    }
    const block: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
    const existing = block[name];
    const orphan = isPlainObject(existing) && this.section.isOverride(existing);
    if (found.global === undefined && !orphan) {
      return undefined;
    }
    // Enabling a server that has no pin is already true in pi; writing would
    // create a project file just to say nothing.
    if (enabled && !orphan) {
      return { ok: true, path: file.path, scope: 'project', override: true, issues: [] };
    }

    const entry: Record<string, unknown> = orphan ? { ...existing } : {};
    if (enabled) {
      delete entry.enabled;
      if (Object.keys(entry).length === 0) {
        delete block[name];
      } else {
        block[name] = entry;
      }
    } else {
      entry.enabled = false;
      block[name] = entry;
    }

    const next: Record<string, unknown> = { ...record };
    if (Object.keys(block).length === 0) {
      delete next[this.section.key];
    } else {
      next[this.section.key] = block;
    }
    return { ...file.write(next), override: true };
  }
}

/** A config mutation that names the project override it wrote (or refused). */
type OverrideMutation = ConfigMutation & { override?: boolean };

/** A decoded entry that names a transport is a server; a bare override is not. */
function definesServer(server: McpServer): boolean {
  return server.command !== undefined || server.url !== undefined;
}
