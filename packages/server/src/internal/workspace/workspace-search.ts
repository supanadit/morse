import { spawn } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import type { WorkspaceSearchFile, WorkspaceSearchLine, WorkspaceSearchResult } from '@morse/protocol';
import { UnsupportedByHostError } from '@morse/core';
import { SKIPPED_DIRECTORIES } from './workspace-index.js';

/**
 * Text search across a project's files, for the frontend's search panel.
 *
 * The obvious engine is ripgrep: it honours `.gitignore`, skips binaries and
 * searches a large tree in the time a Node walk spends opening the first
 * thousand files. But a host machine may not have `rg`, and a panel that only
 * works on the operator's own laptop is a panel that fails at the worst moment
 * — so every search also has a built-in walk behind it, and the result reports
 * which engine answered (`engine`) so the panel can suggest installing
 * ripgrep when the walk is what replied.
 *
 * Both engines agree on the observable behaviour: fixed-string matching, the
 * same smart-case default, the same skip list, the same result caps. What they
 * cannot agree on is `.gitignore` — ripgrep honours it, the walk cannot without
 * a parser of its own — which is one more reason the panel asks for ripgrep.
 */

/** Enough rows for a panel's first view; a wider net belongs in the query. */
const MAX_MATCHES = 1_000;
/** A search that would touch more files than this answers with the first of them. */
const MAX_FILES = 250;
/** A line longer than this is cut to a window around its first match. */
const MAX_LINE_CHARS = 300;
/** Characters kept before the first match when a line is cut. */
const WINDOW_LEAD = 100;
/** Files larger than this are not searched — a bundle is not a grep target. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** How much of a file is sniffed for NUL bytes: it is binary or it is not. */
const SNIFF_BYTES = 8 * 1024;
/** ripgrep is killed with whatever it has answered after this long. */
const RG_TIMEOUT_MS = 20_000;
/** How long a "ripgrep is missing" verdict stands before the host looks again. */
const RG_RETRY_MS = 60_000;
/** A probe that hangs would stall every search, so it has a deadline of its own. */
const RG_PROBE_TIMEOUT_MS = 3_000;
const MAX_QUERY_CHARS = 512;
const MAX_PATTERNS = 32;
const MAX_PATTERN_CHARS = 256;

/** What the search panel sends; `engine` is the tests', never the panel's. */
export interface WorkspaceSearchOptions {
  query: string;
  /** Omitted: smart case, like ripgrep — sensitive only when the query has a capital. */
  caseSensitive?: boolean;
  /** Globs of files to search (`*.ts`, `src/**`); empty means every file. */
  include?: unknown;
  /** Globs of files to leave out; the skip list is always out. */
  exclude?: unknown;
  /** Which engine may answer. `auto` probes for ripgrep; tests pin it. */
  engine?: 'auto' | 'ripgrep' | 'node';
}

/**
 * Searches `cwd`'s files for `query`, grouped by file, sorted by path.
 * Throws `UnsupportedByHostError` for an empty or oversized request, which the
 * host turns into a refused command; a failed ripgrep run surfaces the same way.
 */
export async function searchWorkspace(
  cwd: string,
  options: WorkspaceSearchOptions,
): Promise<WorkspaceSearchResult> {
  const query = options.query.trim();
  if (query.length === 0) {
    throw new UnsupportedByHostError('Search needs a query.');
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new UnsupportedByHostError(`Search queries are at most ${MAX_QUERY_CHARS} characters.`);
  }
  const include = validatedPatterns(options.include, 'include');
  const exclude = validatedPatterns(options.exclude, 'exclude');
  const engine = options.engine ?? 'auto';

  if (engine === 'node') {
    return runNodeWalk(cwd, query, options.caseSensitive, include, exclude);
  }
  if (engine === 'auto' && !(await ripgrepAvailable())) {
    return runNodeWalk(cwd, query, options.caseSensitive, include, exclude);
  }
  try {
    return await runRipgrep(cwd, query, options.caseSensitive, include, exclude);
  } catch (error: unknown) {
    // rg vanished between the probe and the spawn (a PATH edited under the
    // host): the walk still answers. Anything else — a bad glob, a real
    // failure — is the user's news and reaches the panel as a refusal.
    if (engine === 'auto' && spawnMissing(error)) {
      return runNodeWalk(cwd, query, options.caseSensitive, include, exclude);
    }
    throw error;
  }
}

/* ---------------------------------------------------------------- ripgrep -- */

/** The last probe's verdict and when it was made; a stale "no" is re-probed. */
let rgVerdict: { at: number; ok: boolean } | undefined;

/**
 * Whether `rg` runs on this machine. A "yes" stands for the host's lifetime —
 * an install cannot silently break — while a "no" expires after a minute, so
 * installing ripgrep lands without restarting the host.
 */
export async function ripgrepAvailable(): Promise<boolean> {
  if (rgVerdict?.ok === true) {
    return true;
  }
  if (rgVerdict !== undefined && Date.now() - rgVerdict.at < RG_RETRY_MS) {
    return false;
  }
  const ok = await probeRipgrep();
  rgVerdict = { at: Date.now(), ok };
  return ok;
}

/** One `rg --version` spawn: present and runnable, or not. */
function probeRipgrep(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('rg', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, RG_PROBE_TIMEOUT_MS);
    child.once('error', () => done(false));
    child.once('exit', (code) => done(code === 0));
  });
}

/** One `rg --json` match event, as much of it as this search reads. */
interface RgMatchEvent {
  type: 'match';
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: { start: number }[];
  };
}

type RgEvent = RgMatchEvent | { type: string };

/**
 * The ripgrep run: `--json` for machine-readable matches (byte-accurate
 * submatches, no colour, no quoting), fixed-string matching, and the skip
 * list as `!glob`s so both engines skip the same noise. The caps are enforced
 * here too — the process is killed the moment one is passed, because a search
 * the panel will truncate anyway should not keep the disk busy.
 */
function runRipgrep(
  cwd: string,
  query: string,
  caseSensitive: boolean | undefined,
  include: readonly string[],
  exclude: readonly string[],
): Promise<WorkspaceSearchResult> {
  const args = [
    '--json',
    // The host's config could add globs or flags nobody can see from here;
    // a panel's search must answer the same on every machine.
    '--no-config',
    // Hidden files are search targets (a workflow under `.github` is code
    // too); `.git` and the skip list are put back as explicit excludes.
    '--hidden',
    '--max-filesize',
    String(MAX_FILE_BYTES),
    '--glob',
    '!.git/**',
    ...[...SKIPPED_DIRECTORIES].flatMap((dir) => ['--glob', `!${dir}/**`]),
    ...include.flatMap((pattern) => ['--glob', pattern]),
    ...exclude.flatMap((pattern) => ['--glob', `!${pattern}`]),
    // Fixed string: the panel searches for text, not for a pattern language.
    '-F',
    caseSensitive === true
      ? '--case-sensitive'
      : caseSensitive === false
        ? '--ignore-case'
        : '--smart-case',
    '-e',
    query,
    '.',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const files: WorkspaceSearchFile[] = [];
    const byPath = new Map<string, WorkspaceSearchFile>();
    let counted = 0;
    let truncated = false;
    let settled = false;
    let stdout = '';
    let stderr = '';

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      // `counted` is every match actually seen — exact when rg ran to the end,
      // a floor when a cap killed it, and identical to what the walk reports.
      resolve({ files, total: counted, truncated, engine: 'ripgrep' });
    };
    const stop = (): void => {
      if (!truncated) {
        truncated = true;
        child.kill();
      }
    };
    const timer = setTimeout(stop, RG_TIMEOUT_MS);

    const onMatch = (event: RgMatchEvent): void => {
      if (truncated) {
        return;
      }
      // rg's path is project-relative and prefixed with `./` (or `.\` on
      // Windows); the protocol promises `/` separators like `listFiles`, so
      // the prefix goes and any backslash is a separator too.
      const path = event.data.path.text.replace(/\\/g, '/').replace(/^\.\//, '');
      const raw = event.data.lines.text.replace(/\r?\n$/, '');
      // rg reports submatch offsets in bytes; the panel highlights characters.
      const bytes = Buffer.from(raw, 'utf8');
      const columns = event.data.submatches.map(
        (m) => bytes.subarray(0, m.start).toString('utf8').length + 1,
      );
      let file = byPath.get(path);
      if (file === undefined) {
        if (files.length >= MAX_FILES) {
          stop();
          return;
        }
        file = { path, lines: [], count: 0 };
        byPath.set(path, file);
        files.push(file);
      }
      counted += columns.length;
      file.count += columns.length;
      file.lines.push({ line: event.data.line_number, ...windowLine(raw, columns) });
      if (counted >= MAX_MATCHES) {
        stop();
      }
    };

    // One JSON event per line; a line that is not JSON cannot be an event.
    const handleLine = (line: string): void => {
      if (line.length === 0) {
        return;
      }
      let event: RgEvent;
      try {
        event = JSON.parse(line) as RgEvent;
      } catch {
        return;
      }
      if (event.type === 'match') {
        onMatch(event as RgMatchEvent);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      let newline = stdout.indexOf('\n');
      while (newline !== -1) {
        handleLine(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_096) {
        stderr += chunk.toString('utf8');
      }
    });
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) {
        return;
      }
      if (code === 0 || code === 1 || truncated) {
        // 0: matches, 1: none (not a failure), truncated: killed on purpose.
        finish();
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Exit 2 is ripgrep refusing the request — usually a glob that does not
      // parse — and its own words are the only explanation the log will get.
      const detail = stderr.split('\n').find((row) => row.length > 0);
      reject(new UnsupportedByHostError(detail ?? 'ripgrep failed to search.'));
    });
  });
}

/* -------------------------------------------------------------- node walk -- */

/**
 * The fallback: one recursive walk over the same skip list, a NUL sniff for
 * binaries and a plain substring scan. No `.gitignore` (see the file header),
 * which is exactly what the panel's ripgrep notice is about.
 */
async function runNodeWalk(
  cwd: string,
  query: string,
  caseSensitive: boolean | undefined,
  include: readonly string[],
  exclude: readonly string[],
): Promise<WorkspaceSearchResult> {
  // Smart case, ripgrep's default: a query with a capital means it.
  const fold = caseSensitive === undefined ? !/[A-Z]/.test(query) : !caseSensitive;
  const needle = fold ? query.toLowerCase() : query;
  const includeTest = include.length > 0 ? compileGlobs(include) : undefined;
  const excludeTest = exclude.length > 0 ? compileGlobs(exclude) : undefined;

  const files: WorkspaceSearchFile[] = [];
  const byPath = new Map<string, WorkspaceSearchFile>();
  let counted = 0;
  let truncated = false;

  const scanFile = async (abs: string, rel: string): Promise<void> => {
    if (truncated) {
      return;
    }
    const info = await stat(abs).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.size > MAX_FILE_BYTES) {
      return;
    }
    const handle = await open(abs, 'r').catch(() => undefined);
    if (handle === undefined) {
      return;
    }
    try {
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
      const slice = buffer.subarray(0, bytesRead);
      if (slice.subarray(0, Math.min(bytesRead, SNIFF_BYTES)).includes(0)) {
        return;
      }
      const lines = slice.toString('utf8').split('\n');
      // A file joins the result only when it matched: matches are collected
      // here, and the entry is registered on the way out.
      const matched: WorkspaceSearchLine[] = [];
      let fileCount = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
        const hay = fold ? line.toLowerCase() : line;
        const columns: number[] = [];
        let at = hay.indexOf(needle);
        while (at !== -1) {
          columns.push(at + 1);
          at = hay.indexOf(needle, at + needle.length);
        }
        if (columns.length === 0) {
          continue;
        }
        if (matched.length === 0 && byPath.size >= MAX_FILES) {
          truncated = true;
          return;
        }
        counted += columns.length;
        fileCount += columns.length;
        matched.push({ line: i + 1, ...windowLine(line, columns) });
        if (counted >= MAX_MATCHES) {
          truncated = true;
          break;
        }
      }
      if (matched.length > 0) {
        const entry: WorkspaceSearchFile = { path: rel, lines: matched, count: fileCount };
        byPath.set(rel, entry);
        files.push(entry);
      }
    } finally {
      await handle.close();
    }
  };

  const visit = async (abs: string, rel: string): Promise<void> => {
    if (truncated) {
      return;
    }
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) {
        return;
      }
      const childRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Same noise as rg's excludes; `.git` is objects, never a target.
        if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name === '.git') {
          continue;
        }
        await visit(`${abs}${sep}${entry.name}`, childRel);
        continue;
      }
      if (!entry.isFile()) {
        // Symlinks are skipped: they can point outside the project or loop.
        continue;
      }
      if (includeTest !== undefined && !includeTest(childRel)) {
        continue;
      }
      if (excludeTest !== undefined && excludeTest(childRel)) {
        continue;
      }
      await scanFile(`${abs}${sep}${entry.name}`, childRel);
    }
  };

  await visit(cwd, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, total: counted, truncated, engine: 'node' };
}

/* ----------------------------------------------------------------- shared -- */

/**
 * A line's view for one row: whole when it fits, a window around its first
 * match when it does not (a minified bundle is a screenful per line). Columns
 * outside the window are dropped — the match count still has them; the row just
 * draws what it can show.
 */
function windowLine(text: string, columns: readonly number[]): Omit<WorkspaceSearchLine, 'line'> {
  if (text.length <= MAX_LINE_CHARS) {
    return { text, columns: [...columns] };
  }
  const first = (columns[0] ?? 1) - 1;
  const from = Math.max(0, first - WINDOW_LEAD);
  const cut = text.slice(from, from + MAX_LINE_CHARS);
  const shift = from > 0 ? 1 - from : 0;
  return {
    text: (from > 0 ? '…' : '') + cut,
    columns: columns
      .filter((column) => column - 1 >= from && column - 1 < from + MAX_LINE_CHARS)
      .map((column) => column + shift),
  };
}

/** The panel's include/exclude boxes, as patterns worth passing on. */
function validatedPatterns(value: unknown, label: string): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const patterns = [
    ...new Set(
      raw
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
  if (patterns.length > MAX_PATTERNS) {
    throw new UnsupportedByHostError(`At most ${MAX_PATTERNS} ${label} patterns.`);
  }
  if (patterns.some((pattern) => pattern.length > MAX_PATTERN_CHARS)) {
    throw new UnsupportedByHostError(`A ${label} pattern is at most ${MAX_PATTERN_CHARS} characters.`);
  }
  return patterns;
}

/**
 * The include/exclude globs as one path predicate, matched the way ripgrep's
 * gitignore-style globs read them: a pattern without `/` is a file name
 * (`*.ts` anywhere), a pattern with one is a project-relative path (`src` under
 * a folder, say), and double-star crosses folders — a `src` prefix pattern
 * reaches every `.ts` beneath it, at any depth. Invalid class syntax (`[`) is
 * a literal here where rg refuses it — the walk cannot parse a pattern the way
 * rg can, and escaping it is the honest reading of a class that never closed.
 */
function compileGlobs(patterns: readonly string[]): (path: string) => boolean {
  const tests = patterns.map((pattern) => {
    let glob = pattern.replace(/^\.\//, '');
    if (glob.endsWith('/')) {
      glob += '**';
    }
    const byName = !glob.includes('/');
    let source = '';
    let index = 0;
    while (index < glob.length) {
      const char = glob[index];
      if (char === '*') {
        if (glob[index + 1] === '*') {
          if (glob[index + 2] === '/') {
            // `**/` swallows whole folders, optionally, so `src/**` is `src` too.
            source += '(?:[^/]+/)*';
            index += 3;
            continue;
          }
          source += '.*';
          index += 2;
          continue;
        }
        source += '[^/]*';
        index += 1;
        continue;
      }
      if (char === '?') {
        source += '[^/]';
        index += 1;
        continue;
      }
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      index += 1;
    }
    const re = new RegExp(`^(?:${source})$`);
    return byName
      ? (path: string): boolean => re.test(path.slice(path.lastIndexOf('/') + 1))
      : (path: string): boolean => re.test(path);
  });
  return (path) => tests.some((test) => test(path));
}

function spawnMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
