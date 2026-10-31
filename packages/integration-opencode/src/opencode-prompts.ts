import type { OpenCodeCommand } from './internal/opencode-prompts-config.js';
import {
  composeCommandFile,
  listCommands,
  moveConfigCommand,
  openCodeCommandDirs,
  parseCommandFile,
  removeCommandFile,
  upsertConfigCommand,
  writeCommandFile,
  type CommandScope,
  type CommandSource,
} from './internal/opencode-prompts-config.js';

/**
 * OpenCode's prompt-template administration: its `/commands`, both the markdown
 * files and the `command` entries of `opencode.json`, behind the same port
 * pi's `PiPrompts` satisfies. Commands are plain templates — there is no
 * live state to probe, so like the MCP side the answers are configured truth
 * only.
 *
 * The rows carry `source: 'file' | 'config'` so the host and the editor can
 * label where each command lives and route edits back to the right surface.
 */
export class OpenCodePrompts {
  list(cwd: string): {
    templates: (OpenCodeCommand & { argumentHint?: undefined })[];
    globalDir: string;
    projectDir?: string;
    /** OpenCode has no pi-style trust gate: project commands always load. */
    trusted: true;
    configPath: string;
  } {
    const { commands, globalDir, projectDir, configPath } = listCommands(cwd);
    return { templates: commands, globalDir, projectDir, trusted: true, configPath };
  }

  save(
    input: {
      name: string;
      scope: CommandScope;
      source?: CommandSource;
      /** For `file` commands: the whole markdown file. */
      raw?: string;
      /** For `config` commands: the structured entry; `raw` is ignored. */
      entry?: { template: string; description?: string; agent?: string; model?: string; subtask?: boolean };
      originalName?: string;
      originalScope?: CommandScope;
      originalSource?: CommandSource;
    },
    cwd: string,
  ): { ok: true; path?: string; source: CommandSource } {
    const source = input.source ?? 'file';
    if (source === 'config') {
      if (input.entry === undefined) {
        throw new Error('A config command needs its structured entry (template, description, ...).');
      }
      const configPath = openCodeCommandDirs(cwd).configPath;
      upsertConfigCommand(configPath, input.name, input.entry);
      if (input.originalName !== undefined && input.originalName !== input.name && input.originalSource === 'config') {
        moveConfigCommand(configPath, input.originalName);
      }
      return { ok: true, path: configPath, source: 'config' };
    }
    if (input.raw === undefined) {
      throw new Error('A file command needs its raw markdown.');
    }
    // Touch nothing but the target: a scope move deletes the old file only
    // after the new one is written.
    const dirs = openCodeCommandDirs(cwd);
    const dir = input.scope === 'project' ? dirs.projectDir : dirs.globalDir;
    if (dir === undefined) {
      throw new Error('No workspace is open, so there is no project command directory.');
    }
    const path = writeCommandFile(dir, input.name, input.raw);
    if (
      input.originalName !== undefined &&
      input.originalScope !== undefined &&
      (input.originalName !== input.name || input.originalScope !== input.scope) &&
      input.originalSource !== 'config'
    ) {
      const oldDir =
        input.originalScope === 'project' ? dirs.projectDir ?? dirs.globalDir : dirs.globalDir;
      removeCommandFile(oldDir, input.originalName);
    }
    return { ok: true, path, source: 'file' };
  }

  /** Delete by source: a file command removes the file, a config one the JSON key. */
  delete(name: string, scope: CommandScope, cwd: string, source: CommandSource = 'file'): { ok: boolean } {
    if (source === 'config') {
      return { ok: moveConfigCommand(openCodeCommandDirs(cwd).configPath, name) };
    }
    const dirs = openCodeCommandDirs(cwd);
    const dir = scope === 'project' ? dirs.projectDir ?? dirs.globalDir : dirs.globalDir;
    return { ok: removeCommandFile(dir, name) };
  }
}

export { composeCommandFile, parseCommandFile };
