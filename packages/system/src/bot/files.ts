/** Files a bot's engine reads: written private from the moment they exist. */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const PRIVATE_FILE_MODE = 0o600;

/**
 * A JSON file only the bot and its engine may read. Temp file beside the target,
 * then rename; a filesystem that refuses the rename (a Windows mount) falls back
 * to writing in place, which is what the bot registry store does too.
 */
export function writePrivateJson(path: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temp, serialized, { mode: PRIVATE_FILE_MODE });
    // `mode` only applies when the temp file is created; a stale temp left by a
    // crashed run could be broader, so the mode is enforced explicitly.
    chmodSync(temp, PRIVATE_FILE_MODE);
    renameSync(temp, path);
  } catch (error) {
    try {
      writeFileSync(path, serialized, { mode: PRIVATE_FILE_MODE });
      chmodSync(path, PRIVATE_FILE_MODE);
      rmSync(temp, { force: true });
    } catch {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
