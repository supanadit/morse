import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnsupportedByHostError } from '@morse/core';
import type { WorkbenchSnapshot } from '@morse/protocol';

/** The reader's shell layout: tabs, panel and terminals. Small, rewritten on a change. */
const LAYOUT_FILE = 'workbench.json';
/**
 * The half-written prompts, keyed by tab. Larger than the layout because a draft
 * can carry inline image attachments, and rewritten as the reader types.
 */
const DRAFTS_FILE = 'drafts.json';

/**
 * A layout is a handful of tab names and shell ids, so anything past a quarter
 * of a megabyte is not a layout — it is a client trying to use the host as a
 * scratch disk. The cap keeps the file small and the parse cheap.
 */
const LAYOUT_MAX_BYTES = 256 * 1024;
/**
 * A draft carries text, pins and (possibly) base64 images, so it is allowed to
 * be much larger. The cap is still bounded: a client that keeps pushing past this
 * is not writing drafts, and an unbounded file would eventually fail to parse.
 */
const DRAFTS_MAX_BYTES = 32 * 1024 * 1024;

/**
 * A host's persisted shell state under its own data directory: the layout the
 * reader left (`workbench.json`) and the prompts they were typing (`drafts.json`),
 * so opening the shell again lands them on the tab they left, with the words and
 * attachments still in the composer.
 *
 * The frontend owns the inner shape (`snapshot.data`); the host only guards the
 * envelope's version and size, so a newer frontend can add a field without a
 * host change. A missing, unreadable or stale file is not an error: it just
 * means "nothing to restore", and the frontend starts clean.
 *
 * Both hosts share this module: the browser host points it at `<MORSE_HOME>`, and
 * the VS Code extension at its `globalStorageUri`, so a window reload restores
 * the session that was in front instead of starting empty.
 */
export function readWorkbench(dataDir: string): WorkbenchSnapshot | undefined {
  return readSlot(join(dataDir, LAYOUT_FILE), LAYOUT_MAX_BYTES);
}

/**
 * Writes the layout the frontend just handed back. The write is atomic (a temp
 * file beside it, then a rename), so a crash mid-write leaves the previous
 * layout intact instead of a truncated one. Returns false when the envelope is
 * unusable or the directory is not writable; a failed save is not fatal.
 */
export function saveWorkbench(dataDir: string, snapshot: unknown): boolean {
  return saveSlot(dataDir, LAYOUT_FILE, snapshot, LAYOUT_MAX_BYTES);
}

/** The half-written prompts, per tab, as the frontend last saved them. */
export function readDrafts(dataDir: string): WorkbenchSnapshot | undefined {
  return readSlot(join(dataDir, DRAFTS_FILE), DRAFTS_MAX_BYTES);
}

/** Writes the drafts back, with the same atomic write and envelope guard. */
export function saveDrafts(dataDir: string, snapshot: unknown): boolean {
  return saveSlot(dataDir, DRAFTS_FILE, snapshot, DRAFTS_MAX_BYTES);
}

function readSlot(path: string, maxBytes: number): WorkbenchSnapshot | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  if (raw.length > maxBytes) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return asSnapshot(parsed);
}

function saveSlot(dataDir: string, file: string, snapshot: unknown, maxBytes: number): boolean {
  const valid = asSnapshot(snapshot);
  if (valid === undefined) {
    throw new UnsupportedByHostError(`Saving ${file} needs a { version, data } snapshot.`);
  }
  const serialized = JSON.stringify(valid);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new UnsupportedByHostError(`That ${file} snapshot is too large to save.`);
  }
  const target = join(dataDir, file);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(temp, serialized);
    renameSync(temp, target);
    return true;
  } catch {
    // Some filesystems refuse a rename over an existing file (a Windows mount).
    try {
      writeFileSync(target, serialized);
      return true;
    } catch {
      rmSync(temp, { force: true });
      return false;
    }
  }
}

/** The envelope, with anything that is not a `{ version, data }` object dropped. */
function asSnapshot(value: unknown): WorkbenchSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const version = candidate['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return undefined;
  }
  return { version, data: candidate['data'] };
}
