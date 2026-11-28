import { execFileSync } from 'node:child_process';
import type { MorseLogger } from '@morse/system';
import { createBotOpenCodeEngine } from '../bot-engine.js';
import { findOpenCodeBinary } from './resolve-opencode.js';

/** The raw export, so a bot's own server can import it without a temp file. */
export function readOpenCodeGoExport(
  run: (binary: string, args: string[]) => string = exportCredentials,
): string | undefined {
  try {
    const raw = run(findOpenCodeBinary() ?? 'opencode', ['auth', 'export', 'opencode-go']);
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Brings the user's Go login into one bot's isolated OpenCode store.
 *
 * OpenCode 2 keeps subscription credentials in its own data store, not in the
 * `auth.json` API keys are written to. `auth import` needs a live server and a
 * password, so a short-lived one is started against the bot's data dir; the
 * credential it writes outlives this process and the next real engine reads it.
 */
export async function importOpenCodeGoCredential(
  botRoot: string,
  logger: MorseLogger,
): Promise<boolean> {
  // The export answers undefined when there is no Go login to bring: only a
  // real import failure is worth a log line, and it must not carry the secret.
  const payload = readOpenCodeGoExport();
  if (payload === undefined) {
    return false;
  }
  let engine: Awaited<ReturnType<typeof createBotOpenCodeEngine>> | undefined;
  try {
    engine = await createBotOpenCodeEngine({ botRoot, logger });
    execFileSync(
      findOpenCodeBinary() ?? 'opencode',
      ['auth', 'import', '--server', engine.baseUrl],
      {
        input: payload,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, OPENCODE_PASSWORD: engine.serverPassword },
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    return true;
  } catch (error: unknown) {
    // No Go login, no binary, or an import the engine refused: a bot that needs
    // Go says so plainly, and no secret is put in the message.
    logger.warn('The Go login could not be imported into a bot', error);
    return false;
  } finally {
    await engine?.dispose();
  }
}

function exportCredentials(binary: string, args: string[]): string {
  return execFileSync(binary, args, {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}
