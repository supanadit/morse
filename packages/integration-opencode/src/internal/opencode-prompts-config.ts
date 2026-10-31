import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Reading and editing OpenCode's command templates — its prompt-template
 * equivalent, invoked as `/name`.
 *
 * Two sources exist and both run in OpenCode, so Morse treats them as distinct,
 * independently editable rows:
 * - markdown files: `~/.config/opencode/commands/*.md` (global) and
 *   `.opencode/commands/*.md` (project); the file name is the command name and
 *   the frontmatter carries `description` (pi's `argument-hint` does not exist);
 * - entries of `opencode.json`'s `command` key: `{ template, description?,
 *   agent?, model?, subtask? }`.
 *
 * JSON writes reuse the preserve-everything discipline of the MCP config
 * module: only the edited entry may change, every other byte of meaning stays.
 */

/** Where a command lives. */
export type CommandScope = 'global' | 'project';

/** Whether a command comes from a markdown file or the `command` JSON key. */
export type CommandSource = 'file' | 'config';

/** One `command` entry as OpenCode stores it. Unknown fields are preserved. */
export interface OpenCodeCommandEntry {
  template: string;
  description?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
  [key: string]: unknown;
}

/** One command as Morse reads it, from either source. */
export interface OpenCodeCommand {
  name: string;
  scope: CommandScope;
  source: CommandSource;
  /** The file path, for `file` commands. */
  path?: string;
  description?: string;
  /** Body with the frontmatter stripped, for `file` commands. */
  body?: string;
  /** The file exactly as it is on disk, for `file` commands. */
  raw?: string;
  /** The structured entry, for `config` commands. */
  entry?: OpenCodeCommandEntry;
  /** Set when OpenCode would not load the command; it is still listed so it can be fixed. */
  error?: string;
}

/**
 * A markdown file's frontmatter mapping plus body. A file without frontmatter
 * is valid (description undefined); unparseable YAML raises, because guessing
 * would silently miswrite a hand-edit.
 */
export function parseCommandFile(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) {
    throw new Error('frontmatter is never closed.');
  }
  const frontmatter: Record<string, string> = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) {
      throw new Error(`frontmatter line "${line.trim()}" has no "key: value".`);
    }
    const key = line.slice(0, sep).trim();
    if (key.length === 0) {
      throw new Error('frontmatter has an empty key.');
    }
    frontmatter[key] = line.slice(sep + 1).trim();
  }
  const body = raw.slice(end + 4);
  return { frontmatter, body };
}

/** Compose a command file the way OpenCode reads it: frontmatter then body. */
export function composeCommandFile(description: string | undefined, body: string): string {
  const lines = ['---'];
  if (description !== undefined && description.length > 0) {
    lines.push(`description: ${description}`);
  }
  const normalized = body.startsWith('\n') ? body : `\n${body}`;
  return `${lines.join('\n')}\n---${normalized.endsWith('\n') ? normalized : `${normalized}\n`}`;}

export function isValidCommandName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/** The commands of one scope: every `commands/*.md` file, broken files included. */
export function readFileCommands(dir: string, scope: CommandScope): OpenCodeCommand[] {
  if (!existsSync(dir)) {
    return [];
  }
  const commands: OpenCodeCommand[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const path = join(dir, file);
    const raw = readFileSync(path, 'utf8');
    const base: OpenCodeCommand = {
      name: file.slice(0, -3),
      scope,
      source: 'file',
      path,
      raw,
    };
    try {
      const { frontmatter, body } = parseCommandFile(raw);
      commands.push({ ...base, description: frontmatter['description'], body });
    } catch (error) {
      commands.push({ ...base, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return commands;
}

/** The validated `command` entries of one file, keyed by name. */
export function readConfigCommands(path: string): Record<string, OpenCodeCommandEntry> {
  if (!existsSync(path)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { command?: unknown };
  const command = parsed.command;
  if (command === undefined) {
    return {};
  }
  if (typeof command !== 'object' || command === null || Array.isArray(command)) {
    throw new Error(`${path}: "command" must be an object.`);
  }
  for (const [name, entry] of Object.entries(command as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${path}: command "${name}" is not an object.`);
    }
    if (typeof (entry as OpenCodeCommandEntry).template !== 'string') {
      throw new Error(`${path}: command "${name}" needs a string "template".`);
    }
  }
  return command as Record<string, OpenCodeCommandEntry>;
}

/** Every command of a directory: both scopes' files, then the config entries. */
export function listCommands(
  cwd: string | undefined,
  configDir?: string,
): { commands: OpenCodeCommand[]; globalDir: string; projectDir?: string; configPath: string } {
  const dirs = openCodeCommandDirs(cwd, configDir);
  const commands = [
    ...(dirs.projectDir !== undefined ? readFileCommands(dirs.projectDir, 'project') : []),
    ...readFileCommands(dirs.globalDir, 'global'),
  ];
  for (const [name, entry] of Object.entries(readConfigCommands(dirs.configPath))) {
    commands.push({
      name,
      scope: 'global',
      source: 'config',
      description: entry.description,
      entry,
    });
  }
  return {
    commands,
    globalDir: dirs.globalDir,
    projectDir: dirs.projectDir,
    configPath: dirs.configPath,
  };
}

/** Add or replace one `command`-key entry, keeping every other entry and key. */
export function upsertConfigCommand(
  path: string,
  name: string,
  entry: OpenCodeCommandEntry,
): void {
  if (!isValidCommandName(name)) {
    throw new Error(`"${name}" is not a valid command name (letters, digits, "_" and "-").`);
  }
  if (typeof entry.template !== 'string' || entry.template.length === 0) {
    throw new Error(`Command "${name}" needs a "template".`);
  }
  const parsed = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  const command = (parsed.command ?? {}) as Record<string, OpenCodeCommandEntry>;
  if (typeof command !== 'object' || Array.isArray(command)) {
    throw new Error(`${path}: "command" must be an object.`);
  }
  parsed.command = { ...command, [name]: entry };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/**
 * Rename (rekey) or delete one `command`-key entry. With `to`, the entry moves
 * to the new name; without it, the entry is removed. Returns false when the
 * file did not define `from`.
 */
export function moveConfigCommand(path: string, from: string, to?: string): boolean {
  const parsed = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  const command = parsed.command as Record<string, OpenCodeCommandEntry> | undefined;
  if (command === undefined || !(from in command)) {
    return false;
  }
  const entry = command[from];
  const { [from]: _removed, ...rest } = command;
  if (to !== undefined) {
    if (!isValidCommandName(to)) {
      throw new Error(`"${to}" is not a valid command name (letters, digits, "_" and "-").`);
    }
    rest[to] = entry;
  }
  if (Object.keys(rest).length === 0) {
    delete parsed.command;
  } else {
    parsed.command = rest;
  }
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return true;
}

/** Write one command file into a scope's `commands/` directory. */
export function writeCommandFile(dir: string, name: string, raw: string): string {
  if (!isValidCommandName(name)) {
    throw new Error(`"${name}" is not a valid command name (letters, digits, "_" and "-").`);
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, raw, 'utf8');
  return path;
}

/** Delete one command file. Returns false when it was not there. */
export function removeCommandFile(dir: string, name: string): boolean {
  const path = join(dir, `${name}.md`);
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path);
  return true;
}

/** A cheap fingerprint of everything that decides a directory's commands. */
export function commandSignature(cwd: string | undefined, configDir?: string): string {
  const dirs = openCodeCommandDirs(cwd, configDir);
  const paths = [...(dirs.projectDir !== undefined ? [dirs.projectDir] : []), dirs.globalDir, dirs.configPath];
  return paths
    .map((path) => {
      try {
        const info = statSync(path);
        return `${info.size}:${info.mtimeMs}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

/** The `commands/` directories and the config file, with the project first. */
export function openCodeCommandDirs(
  cwd: string | undefined,
  configDir?: string,
): { globalDir: string; projectDir?: string; configPath: string } {
  const base = configDir ?? defaultConfigDir();
  const configPath = join(base, 'opencode.json');
  if (cwd !== undefined && cwd.length > 0) {
    return {
      globalDir: join(base, 'commands'),
      projectDir: join(cwd, '.opencode', 'commands'),
      configPath,
    };
  }
  return { globalDir: join(base, 'commands'), configPath };
}

function defaultConfigDir(): string {
  // OpenCode is XDG-aware; Morse follows the same resolution.
  const xdg = process.env['XDG_CONFIG_HOME'];
  return xdg !== undefined && xdg.length > 0 ? join(xdg, 'opencode') : join(homedir(), '.config', 'opencode');
}
