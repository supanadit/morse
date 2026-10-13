import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { PiSpawn } from './resolve-pi.js';

export type { PiSpawn } from './resolve-pi.js';

/**
 * Where an installed pi actually lives on disk, for every way pi is installed.
 *
 * Morse reads two things out of the pi install it launched: the version (for
 * the frontend's "a newer pi is out" notice) and the package behind the binary
 * (whose `dist/core/slash-commands.js` feeds the palette's builtins). Neither is
 * served by `pi --version` or the RPC, so both are answered by resolving the
 * package root and reading its manifest.
 *
 * That resolution has to survive every install method pi advertises. They fall
 * into three shapes:
 *
 * - a symlink into the package: npm on POSIX (`bin/pi -> .../dist/bundle/cli.js`),
 *   and bun's global install where it links rather than copies. A realpath plus a
 *   short walk up reaches the manifest.
 * - a *script shim* outside the package: npm on Windows (`.cmd`/`.ps1`), and pnpm
 *   on both platforms (`$PNPM_HOME/bin/pi` is a copied `sh` shim into pnpm's
 *   global store, not a symlink). The walk up finds a bin directory, never a
 *   manifest; the real `node_modules` path is named inside the shim and is
 *   followed from there.
 * - a *compiled binary shim*: bun on Windows cannot symlink and cannot run a
 *   shebang, so it writes `pi.exe` — a real PE — beside a `pi.bunx` sidecar whose
 *   UTF-16 payload names the target relative to the shim's grandparent. The file
 *   is opaque to any text scan, so the sidecar is decoded on its own.
 * - a managed `releases-v1` install (`curl pi.dev/install.sh`, the PowerShell
 *   `install.ps1`): no manifest anywhere above the launcher, only an installer
 *   marker and `current-version`. Its layout is reconstructed from the files the
 *   installer wrote.
 *
 * Every step is best-effort and reads only real files: a layout that cannot be
 * recognized yields `undefined`, and the caller degrades (no version notice, or
 * a palette without builtins) rather than misreporting some other package.
 */

export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

/** Walk-up depth cap — pi's entry can be `bin/`, `dist/`, `dist/bundle/`. */
const MAX_ROOT_DEPTH = 5;
/** The marker pi's installer writes beside the launcher (`<agent>/bin/pi`). */
const MANAGED_MARKER = 'managed-install.json';
/** Climb cap from the entry to the directory whose `install/` holds the marker. */
const MAX_MANAGED_DEPTH = 3;
/** A `current-version` release name: the installer's own rule, minus `.`/`..`. */
const MANAGED_VERSION = /^[0-9A-Za-z._+-]+$/;
/** Windows shell hosts Morse starts a `.ps1` shim through. */
const SHELL_HOST = /^(?:powershell|pwsh)(?:\.exe)?$/i;
/**
 * A shim reference: a maximal run of non-delimiter characters around a
 * `node_modules` segment. Quotes, whitespace and shell/path punctuation end a
 * token, which is what keeps `cmd-shim-target=<path>` or `node "<path>" %*` from
 * swallowing the surrounding syntax.
 */
const SHIM_REFERENCE = /[^\s"'`(){};,&|=<>]*node_modules[\\/][^\s"'`(){};,&|=<>]*/gi;
/** A token's leading anchor for the shim's own directory (Windows / POSIX). */
const SHIM_ANCHOR = /^(?:%~?dp0%?|\$\{?basedir(?:_win)?\}?)/i;
/**
 * The anchor plus the separator right after it. `%~dp0` already ends in one
 * (`...\`); `$basedir` does not (`.../x`). Both shims therefore appear as
 * `%~dp0\x` and `$basedir/x`, but also as `%~dp0x` — the separator, when there,
 * belongs to the anchor. Excluding a leading separator is not possible here
 * (`%~dp0` is itself `...\`), so it is consumed when present.
 */
const SHIM_ANCHOR_BODY = /^(?:%~?dp0%?|\$\{?basedir(?:_win)?\}?)[\\/]?/i;
/** Read as a shim only when it can plausibly be one, and never a huge file. */
const SHIM_MAX_BYTES = 1024 * 1024;

/**
 * The path pi was started from: the command itself, the `dist/**[.js]` entry of
 * a node launch, or the `.ps1` shim passed to `powershell -File`.
 */
export function piEntry(spawn: PiSpawn): string | undefined {
  if (spawn.source === 'node-entry') {
    return spawn.args.find((arg) => /\.(?:c|m)?js$/.test(arg));
  }
  if (SHELL_HOST.test(basename(spawn.command))) {
    const index = spawn.args.indexOf('-File');
    const shim = index >= 0 ? spawn.args[index + 1] : undefined;
    if (shim !== undefined) {
      return shim;
    }
  }
  return spawn.command;
}

/**
 * The pi package root for a pi entry (`pi` binary or a `dist/**[.js]` entry).
 *
 * Three places are tried, cheapest and most direct first:
 * 1. the manifest above the entry's realpath'd directory (symlinked installs);
 * 2. the `node_modules` path written inside a script shim (Windows `.cmd`,
 *    pnpm's POSIX shim) — a shim is not the package, so its ancestors are not it;
 * 3. the managed-install layout (below) when there is no manifest at all.
 *
 * Each result is the first directory whose `package.json` names pi's own
 * package, so a shim pointing at something else cannot misreport.
 */
export function piPackageRoot(entry: string, maxDepth = MAX_ROOT_DEPTH): string | undefined {
  const directory = entryDirectory(entry);
  if (directory === undefined) {
    return undefined;
  }
  const adjacent = climbForPiPackage(directory, maxDepth);
  if (adjacent !== undefined) {
    return adjacent;
  }
  for (const referenced of referencedDirectoriesFromShim(entry)) {
    const shimmed = climbForPiPackage(referenced, maxDepth);
    if (shimmed !== undefined) {
      return shimmed;
    }
  }
  // bun's Windows `.exe` shim is a compiled image, so the text scan above cannot
  // read it; its target lives in a sidecar instead.
  for (const referenced of bunShimTargets(entry)) {
    const shimmed = climbForPiPackage(referenced, maxDepth);
    if (shimmed !== undefined) {
      return shimmed;
    }
  }
  return managedPackageRoot(directory);
}

/**
 * The installed pi version, read from the package that owns the resolved entry
 * (`pi` is a symlink to `.../@earendil-works/pi-coding-agent/dist/bundle/cli.js`,
 * so its `package.json` sits two directories up). Best effort: a pi installed by
 * a package manager that does not leave a readable package.json next to the
 * binary simply has no version, and the only cost is the frontend's "a newer pi
 * is out" notice.
 *
 * Not `pi --version`: this runs while a host builds its capabilities, and a
 * subprocess there would delay every connection. Reading one file does not.
 */
export function readPiVersion(spawn: PiSpawn): string | undefined {
  const entry = piEntry(spawn);
  if (entry === undefined || entry.length === 0) {
    return undefined;
  }
  // Deliberately the same resolution the builtins read uses: a managed install
  // and a shimmed one answer both questions or neither.
  const root = piPackageRoot(entry);
  return root === undefined ? undefined : versionOf(root);
}

/** The `version` of the package at `root`, which `piPackageRoot` certified as pi's. */
export function versionOf(root: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    if (typeof parsed.version !== 'string') {
      return undefined;
    }
    const version = parsed.version.trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The directory the search starts from: the entry itself if it is one. */
function entryDirectory(entry: string): string | undefined {
  try {
    const resolved = realpathSync(entry);
    return statSync(resolved).isDirectory() ? resolved : dirname(resolved);
  } catch {
    return undefined;
  }
}

/** First directory at or above `start` whose manifest is pi's own package. */
function climbForPiPackage(start: string, maxDepth: number): string | undefined {
  let current = start;
  for (let depth = 0; depth < maxDepth && current !== dirname(current); depth += 1) {
    if (isPiPackageDirectory(current)) {
      return current;
    }
    current = dirname(current);
  }
  return undefined;
}

/** True when `directory` holds a manifest that is pi's own package. */
function isPiPackageDirectory(directory: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    return parsed.name === PI_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * The directories a script shim points into, resolved against the shim's own
 * location. A shim is a script — npm's Windows `.cmd`, npm's POSIX `sh`, pnpm's
 * copied `sh` — so its ancestors are a bin directory, not the package; the real
 * entry is named inside it, usually as `"%dp0%\node_modules\..."` or
 * `"$basedir/../global/.../node_modules/..."`, and (for pnpm) also in the
 * machine-readable `# cmd-shim-target=` trailer.
 *
 * Every reference found is returned; the caller climbs from each and takes the
 * one that reaches pi's manifest, which keeps an unrecognized or stale branch
 * from deciding the answer. Best effort: an unreadable or binary shim yields
 * none.
 */
function referencedDirectoriesFromShim(entry: string): string[] {
  if (!isShimCandidate(entry)) {
    return [];
  }
  let text: string;
  try {
    if (statSync(entry).size > SHIM_MAX_BYTES) {
      return [];
    }
    text = readFileSync(entry, 'utf8');
  } catch {
    return [];
  }
  const directory = dirname(entry);
  const found = new Set<string>();
  for (const match of text.matchAll(SHIM_REFERENCE)) {
    const resolved = resolveShimReference(match[0], directory);
    if (resolved !== undefined) {
      found.add(resolved);
    }
  }
  return [...found];
}

/** A `.cmd`/`.bat`/`.ps1`/`sh` script or a bare name; never a `.js`/binary entry. */
function isShimCandidate(entry: string): boolean {
  return !/\.(?:exe|com|js|mjs|cjs|json)$/i.test(entry);
}

/**
 * The directories a bun Windows `.exe` shim points into.
 *
 * bun cannot hand a child the target path in its process image, so it writes a
 * second file beside the launcher: `pi.exe` is a tiny PE that reads `pi.bunx` and
 * `NtCreateProcess`es what it names. That makes the pair the only install shape
 * Morse cannot read as text — the `.exe` is an image and the `.bunx` is UTF-16 —
 * which is why a bun-global pi on Windows resolved to nothing.
 *
 * The sidecar's first field is `[WSTR:bin_path][u16 '"'][u16 0]…` and the encoder
 * stores the target relative to the shim's own directory with a leading `..\`
 * removed, so joined against that directory's parent it reconstructs the target
 * (see `bun_shim_impl.rs`, which rebuilds the same path by overwriting the shim's
 * filename with the payload). Best effort: no `.exe` suffix, no readable sidecar
 * or no quote terminator yields none.
 */
function bunShimTargets(entry: string): string[] {
  if (!/\.exe$/i.test(entry)) {
    return [];
  }
  const sidecar = `${entry.slice(0, -'.exe'.length)}.bunx`;
  let payload: string;
  try {
    if (statSync(sidecar).size > SHIM_MAX_BYTES) {
      return [];
    }
    payload = readFileSync(sidecar).toString('utf16le');
  } catch {
    return [];
  }
  const terminator = payload.indexOf('"');
  const reference = (terminator >= 0 ? payload.slice(0, terminator) : payload).trim();
  if (reference.length === 0) {
    return [];
  }
  // The payload is a Windows path in every case, so its separators are normalized
  // rather than joined literally — the same resolution then works on any host.
  const base = dirname(dirname(entry));
  const target = join(base, reference.replace(/\\/g, '/'));
  return target === base ? [] : [target];
}

/**
 * A shim reference as the directory of the file it names. The reference is
 * relative to the shim's directory unless it is anchored to it (`%dp0%`,
 * `$basedir`) or already absolute.
 */
function resolveShimReference(reference: string, shimDirectory: string): string | undefined {
  // `$basedir_win` is the shim's Windows spelling of the same directory; a POSIX
  // host cannot resolve it, so let it fail and the plain spelling win.
  const windowsSpelling = /_win\//.test(reference.replace(/\\/g, '/'));
  let value = reference.replace(/\\/g, '/');
  const anchored = SHIM_ANCHOR.test(value);
  if (anchored) {
    value = value.replace(SHIM_ANCHOR_BODY, '');
  }
  if (value.length === 0) {
    return undefined;
  }
  const absolute = isAbsolute(value) || /^[A-Za-z]:\//.test(value);
  const base = absolute || windowsSpelling ? '' : shimDirectory;
  const resolved = absolute ? value : join(base, value);
  const file = dirname(resolved);
  return file === resolved ? undefined : file;
}

/**
 * pi's package root in a managed install — the layout `curl pi.dev/install.sh`
 * creates by default. There `pi` on PATH is an `sh` launcher (`<agent>/bin/pi`,
 * symlinked from a bin dir on PATH) that reads `<agent>/install/current-version`
 * and execs that release's `node_modules/.bin/pi`, so no pi manifest is ever
 * above the entry and the walk-up alone comes back empty — which is issue #1:
 * the palette lost its builtins and warned about an "unreadable" install.
 *
 * The PowerShell installer lays out the same tree, with `pi.cmd`/`pi.ps1` beside
 * the launcher and `<agent>/bin` prepended to the user PATH, so a `.cmd` entry
 * reaches the same marker one level up.
 *
 * Mirrors the launcher: climb to the directory whose `install/` carries the
 * installer's marker, take the version from `current-version`, and return the
 * package `npm ci` laid down under `releases/<version>/node_modules`. Every
 * step reads a file the installer wrote, and the manifest-name check is what
 * certifies the result as pi's.
 */
function managedPackageRoot(directory: string): string | undefined {
  let current = directory;
  for (let depth = 0; depth < MAX_MANAGED_DEPTH && current !== dirname(current); depth += 1) {
    const installDir = join(current, 'install');
    if (isManagedMarker(join(installDir, MANAGED_MARKER))) {
      return managedReleaseRoot(installDir);
    }
    current = dirname(current);
  }
  return undefined;
}

/** The installer's marker, checked for what it declares before it is trusted. */
function isManagedMarker(marker: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { kind?: unknown };
    return parsed.kind === 'pi-managed-install';
  } catch {
    return false;
  }
}

function managedReleaseRoot(installDir: string): string | undefined {
  let version: string;
  try {
    version = readFileSync(join(installDir, 'current-version'), 'utf8').trim();
  } catch {
    return undefined;
  }
  // The version is joined into a path, so it is validated, not trusted: the
  // installer's release-name rule also excludes `/`, and `.`/`..` cannot name
  // a release either.
  if (version === '.' || version === '..' || !MANAGED_VERSION.test(version)) {
    return undefined;
  }
  const root = join(installDir, 'releases', version, 'node_modules', PI_PACKAGE_NAME);
  return isPiPackageDirectory(root) ? root : undefined;
}
