import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MorseLogger } from '../logger.js';

/**
 * Morse's data layout, versioned.
 *
 * Upgrading Morse must never cost the reader anything. Everything Morse writes
 * under its data directory (`.morse/`) carries a layout version, and `morse
 * start` brings that directory forward before any service reads it — no manual
 * steps, no "delete your old config". The rules a migration must keep:
 *
 * - **Forward only, one version at a time.** A directory at version N is taken
 *   to N+1 by that version's step, then N+2, and so on: a reader two releases
 *   behind runs two steps, not a special case.
 * - **Idempotent.** A step sees only directories at its own version, and the
 *   version is written as soon as a step succeeds, so an interrupted upgrade
 *   resumes instead of replaying.
 * - **Never destructive.** A step moves data into a new shape; it does not drop
 *   what a later step might need. Anything a step cannot handle is reported and
 *   left alone rather than half-migrated.
 * - **Backed up first.** The JSON Morse owns is copied into `backups/` before
 *   the first step that changes anything, so a bug is recoverable by hand.
 * - **Downgrade is refused.** An older Morse must not open a newer directory: it
 *   would not understand the shape and would write over it.
 */

/** The layout version this build writes and understands. */
export const CURRENT_DATA_LAYOUT = 4;

/** The file that records which layout a data directory is at. */
const VERSION_FILE = 'version.json';

/** Where the pre-migration copies go, so a mistake is recoverable by hand. */
const BACKUP_DIR = 'backups';

/** What `version.json` holds. */
export interface DataVersionFile {
  /** The layout version of the directory. */
  layout: number;
  /** When this build last brought the directory forward (ISO 8601). */
  updatedAt: string;
  /** The Morse version that did it, when the caller knows it. */
  morse?: string;
}

/** Everything a migration step may rely on. */
export interface DataContext {
  /** Morse's data directory: the parent of `bot/`, `sessions/`, `version.json`. */
  root: string;
  logger: MorseLogger;
  /** Clock, injected so a test can pin the timestamps. */
  now(): Date;
  /** Copy the files this step is about to rewrite, before it touches them. */
  backup(files: readonly string[], label: string): void;
}

/** One step from version `to - 1` to `to`. */
export interface DataMigration {
  /** The version this step produces. Steps are applied in ascending order. */
  to: number;
  /** What it does, in one line — logged as it runs. */
  name: string;
  run(context: DataContext): void;
}

/** The outcome of a maintenance run, for the caller to log or assert on. */
export interface DataMaintenanceResult {
  /** The version the directory was at when the run started. */
  from: number;
  /** The version it is at now. */
  to: number;
  /** Steps that ran, by name. Empty on an already-current directory. */
  applied: string[];
  /** Problems that did not stop the run: drift, unknown state, skipped work. */
  warnings: string[];
}

/**
 * Reads `version.json`.
 *
 * A directory with no version file is a fresh install *or* one written by a
 * Morse older than versioning itself; both are treated as layout 0, which the
 * first step brings to 1 by doing nothing. That is deliberately forgiving: the
 * cost of guessing wrong is one no-op step, while refusing to start would strand
 * every existing reader.
 */
export function readDataVersion(root: string): DataVersionFile {
  const path = join(root, VERSION_FILE);
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} is not a JSON object.`);
  }
  const { layout, updatedAt, morse } = parsed as {
    layout?: unknown;
    updatedAt?: unknown;
    morse?: unknown;
  };
  if (typeof layout !== 'number' || !Number.isInteger(layout) || layout < 0) {
    throw new Error(`${path} has no usable "layout" version.`);
  }
  return {
    layout,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    ...(typeof morse === 'string' ? { morse } : {}),
  };
}

/** The layout version of a directory, or 0 when it has never been stamped. */
export function currentLayoutOf(root: string): number {
  try {
    return readDataVersion(root).layout;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

/** Writes `version.json` atomically. */
export function writeDataVersion(root: string, version: DataVersionFile): void {
  const path = join(root, VERSION_FILE);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(version, null, 2)}\n`, 'utf8');
  try {
    renameSync(temp, path);
  } catch {
    writeFileSync(path, `${JSON.stringify(version, null, 2)}\n`, 'utf8');
  }
}

/**
 * Brings a data directory to `CURRENT_DATA_LAYOUT`, then runs the reconcile
 * passes the caller passes in.
 *
 * Reconcile is separate from migration on purpose: a migration is a one-way
 * shape change recorded in `version.json`, while a reconcile is an *additive*
 * repair that is safe to run on every start (an engine tree that lost its
 * config, say). A reconcile must never overwrite state the reader owns.
 */
export function maintainData(options: {
  root: string;
  logger: MorseLogger;
  migrations: readonly DataMigration[];
  /** Runs after the version steps, on every start. Additive repairs only. */
  reconciles?: ReadonlyArray<{ name: string; run(context: DataContext): void }>;
  now?: () => Date;
  /** The Morse build doing the work, stamped into `version.json`. */
  morseVersion?: string;
  /**
   * Extra fields for the context a step receives — the bot steps need this
   * host's engine adapters, which the generic runner cannot know about.
   */
  extra?: Record<string, unknown>;
}): DataMaintenanceResult {
  const now = options.now ?? (() => new Date());
  const warnings: string[] = [];
  let from: number;
  try {
    from = currentLayoutOf(options.root);
  } catch (error: unknown) {
    // A broken version file is not a guess we may make: migrating the wrong
    // layout is worse than refusing, because every step assumes its shape.
    throw new Error(
      `Cannot read ${join(options.root, VERSION_FILE)}: ${(error as Error).message}. Fix it or move it away to let Morse stamp a fresh layout.`,
      { cause: error },
    );
  }
  if (from > CURRENT_DATA_LAYOUT) {
    throw new Error(
      `This Morse understands data layout ${CURRENT_DATA_LAYOUT} but ${options.root} is at ${from}: it was written by a newer Morse. Upgrade Morse instead of downgrading, or use a different data directory.`,
    );
  }

  const context: DataContext = {
    ...(options.extra ?? {}),
    root: options.root,
    logger: options.logger,
    now,
    backup: (files, label) => backupDataFiles(options.root, files, label, now),
  };

  const applied: string[] = [];
  let version = from;
  for (const migration of [...options.migrations].sort((left, right) => left.to - right.to)) {
    if (migration.to <= version) {
      continue;
    }
    if (migration.to !== version + 1) {
      throw new Error(
        `No migration from data layout ${version} to ${migration.to}: expected a step producing ${version + 1}.`,
      );
    }
    options.logger.info(`Migrating data layout ${version} → ${migration.to}: ${migration.name}`);
    migration.run(context);
    version = migration.to;
    applied.push(migration.name);
    // Stamped per step: an upgrade interrupted halfway resumes at the step that
    // did not run, instead of replaying the ones that did.
    writeDataVersion(options.root, {
      layout: version,
      updatedAt: now().toISOString(),
      ...(options.morseVersion === undefined ? {} : { morse: options.morseVersion }),
    });
  }

  // A fresh install has no version file yet: stamp it even when no step ran, so
  // the next upgrade knows what it is starting from.
  if (from === 0 && applied.length === 0) {
    writeDataVersion(options.root, {
      layout: CURRENT_DATA_LAYOUT,
      updatedAt: now().toISOString(),
      ...(options.morseVersion === undefined ? {} : { morse: options.morseVersion }),
    });
    version = CURRENT_DATA_LAYOUT;
  }

  for (const reconcile of options.reconciles ?? []) {
    try {
      reconcile.run(context);
    } catch (error: unknown) {
      // A reconcile is a repair, never a precondition: a host whose bot tree is
      // odd must still start and serve code sessions.
      const message = `${reconcile.name} failed: ${(error as Error).message}`;
      warnings.push(message);
      options.logger.warn(`Data reconcile did not finish — ${message}`);
    }
  }

  return { from, to: version, applied, warnings };
}

/**
 * Copies the files a step is about to rewrite into `backups/<label>-<stamp>/`,
 * keeping their relative paths. Only what Morse owns is copied — JSON records,
 * not sessions, workspaces or engine session databases.
 */
function backupDataFiles(
  root: string,
  files: readonly string[],
  label: string,
  now: () => Date,
): void {
  if (files.length === 0) {
    return;
  }
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const target = join(root, BACKUP_DIR, `${label}-${stamp}`);
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(join(root, file), 'utf8');
    } catch {
      // Nothing there to back up: a step must cope with a file it expected.
      continue;
    }
    const destination = join(target, file);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, raw, 'utf8');
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
}
