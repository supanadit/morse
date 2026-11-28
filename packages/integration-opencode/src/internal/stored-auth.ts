import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MorseLogger } from '@morse/system';
import { createBotOpenCodeEngine } from '../bot-engine.js';
import { findOpenCodeBinary } from './resolve-opencode.js';

/** One record of `opencode auth export`: any integration, any credential type. */
interface ExportedCredential {
  id?: unknown;
  integrationID?: unknown;
  value?: unknown;
}

/**
 * The raw export, so a bot's own server can import it without a temp file.
 *
 * Every integration is exported, not a chosen one: whatever this machine is
 * logged into — subscriptions, coding plans, API keys — is what "use global
 * configuration" means to the reader. Integrations named in `keep` are left
 * out, so a key the wizard collected for the same provider is never replaced.
 */
export function readOpenCodeAuthExport(
  run: (binary: string, args: string[]) => string = runAuth,
  keep: ReadonlySet<string> = new Set(),
): string | undefined {
  try {
    const raw = run(findOpenCodeBinary() ?? 'opencode', exportArgs(process.env));
    const records = parseExport(raw);
    if (records === undefined) {
      return undefined;
    }
    const kept = records.filter((record) => !keep.has(integrationOf(record)));
    return kept.length === 0 ? undefined : JSON.stringify(kept);
  } catch {
    return undefined;
  }
}

/**
 * `auth export` needs a server to read the store through. A host attached to
 * one (`MORSE_OPENCODE_URL`) asks it directly; otherwise `--standalone` starts a
 * private one. Without this, OpenCode 2's CLI tries its *managed* background
 * service — which a sidecar already owns — and dies with "port already in
 * use", so every stored credential silently read as absent and the bot listed
 * no models.
 */
function exportArgs(env: NodeJS.ProcessEnv): string[] {
  const url = env['MORSE_OPENCODE_URL']?.trim();
  const password = env['MORSE_OPENCODE_PASSWORD']?.trim();
  if (url !== undefined && url.length > 0 && password !== undefined && password.length > 0) {
    return ['auth', 'export', '--server', url];
  }
  return ['auth', 'export', '--standalone'];
}

function parseExport(raw: string): ExportedCredential[] | undefined {
  if (raw.trim().length === 0) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as ExportedCredential[]) : undefined;
}

function integrationOf(record: ExportedCredential): string {
  return typeof record.integrationID === 'string' ? record.integrationID : '';
}

/**
 * Brings this machine's OpenCode credentials into one bot's isolated store.
 *
 * OpenCode 2 keeps credentials in its own data store, not in the `auth.json`
 * API keys are written to. `auth import` needs a live server and a password, so
 * a short-lived one is started against the bot's data dir; what it writes
 * outlives this process and the next real engine reads it. The payload passes
 * through unmodified — import validates the exporter's own record shape.
 *
 * Nothing stored, or nothing left once the bot's own providers are kept out,
 * is `false` and not a failure.
 */
export async function importOpenCodeCredentials(
  botRoot: string,
  logger: MorseLogger,
): Promise<boolean> {
  const payload = readOpenCodeAuthExport(undefined, botOwnedProviders(botRoot));
  if (payload === undefined) {
    return false;
  }
  let engine: Awaited<ReturnType<typeof createBotOpenCodeEngine>> | undefined;
  try {
    engine = await createBotOpenCodeEngine({ botRoot, logger });
    execFileSync(findOpenCodeBinary() ?? 'opencode', ['auth', 'import', '--server', engine.baseUrl], {
      input: payload,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, OPENCODE_PASSWORD: engine.serverPassword },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return true;
  } catch (error: unknown) {
    // No binary, or an import the engine refused: a bot that needs one of these
    // credentials says so plainly, and no secret is put in the message.
    logger.warn('The stored OpenCode credentials could not be imported into a bot', error);
    return false;
  } finally {
    await engine?.dispose();
  }
}

/**
 * Provider ids this bot already answers for on its own: the keys the wizard
 * pasted (`auth.json`) and the providers its config declares. The global copy
 * leaves those alone, so what the reader typed here always wins.
 */
export function botOwnedProviders(botRoot: string): Set<string> {
  const owned = new Set<string>();
  const authPath = join(botRoot, 'sessions', 'opencode', 'auth.json');
  if (existsSync(authPath)) {
    try {
      const auth: unknown = JSON.parse(readFileSync(authPath, 'utf8'));
      if (typeof auth === 'object' && auth !== null && !Array.isArray(auth)) {
        for (const id of Object.keys(auth)) {
          owned.add(id);
        }
      }
    } catch {
      // An unreadable bot key file adds nothing to keep; the copy proceeds.
    }
  }
  const configPath = join(botRoot, 'config', 'opencode', 'opencode.json');
  if (existsSync(configPath)) {
    try {
      const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
      if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
        for (const block of ['provider', 'providers']) {
          const entries = (config as Record<string, unknown>)[block];
          if (typeof entries === 'object' && entries !== null && !Array.isArray(entries)) {
            for (const id of Object.keys(entries)) {
              owned.add(id);
            }
          }
        }
      }
    } catch {
      // Same: a config Morse cannot parse keeps nothing back.
    }
  }
  return owned;
}

function runAuth(binary: string, args: string[]): string {
  const password = process.env['MORSE_OPENCODE_PASSWORD']?.trim();
  return execFileSync(binary, args, {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
    // An attached server asks for the password the CLI must present.
    env: { ...process.env, ...(password ? { OPENCODE_PASSWORD: password } : {}) },
  });
}
