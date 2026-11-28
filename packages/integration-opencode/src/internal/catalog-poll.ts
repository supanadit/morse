import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MorseLogger } from '@morse/system';
import { findOpenCodeBinary } from './resolve-opencode.js';
import type { OpenCodeApi } from './client.js';
import type { ApiModel } from './model-mapping.js';

/**
 * A fresh OpenCode server lists only what it already knows: keyless builtin
 * models answer at once, while providers that need a credential (a key the
 * bot brings in `auth.json`, or a login the snapshot just imported into the
 * server's store) appear once the server's background fetch lands — seconds
 * later on a fast machine, tens of seconds later on a slow one. A single
 * catalog read right after boot therefore reports a healthy provider as
 * empty, and the wizard shows "0 models" for a key that is really there.
 *
 * So a bot server's first read waits for the credentialed providers to
 * materialize instead: poll until every provider the server holds a
 * credential for lists at least one model, or the budget runs out. A server
 * with no credentials answers at once (nothing can still be loading), and a
 * genuinely broken key costs at most the budget — then the bot is created
 * anyway and the wizard says what the probe found.
 */
export async function awaitSettledCatalog(
  api: Pick<OpenCodeApi, 'get'>,
  directory: string,
  logger: MorseLogger,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    credentialProviders?: readonly string[];
  } = {},
): Promise<ApiModel[]> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const expected = new Set(options.credentialProviders ?? []);
  const started = Date.now();
  let latest: ApiModel[] = [];
  for (;;) {
    try {
      const models = await api.get<ApiModel[]>('/model', {
        'location[directory]': directory,
      });
      latest = Array.isArray(models) ? models : [];
    } catch (error: unknown) {
      logger.warn('Could not read the OpenCode model catalog while it settles', error);
      latest = [];
    }
    if (expected.size === 0) {
      return latest;
    }
    const listed = new Set(
      latest.map((model) => (model as { providerID?: unknown }).providerID),
    );
    let missing = false;
    for (const id of expected) {
      if (!listed.has(id)) {
        missing = true;
        break;
      }
    }
    if (!missing) {
      return latest;
    }
    if (Date.now() - started + intervalMs > timeoutMs) {
      logger.warn(
        `The OpenCode model catalog settled without ${[...expected].filter((id) => !listed.has(id)).join(', ')}; the key may be wrong or unreachable.`,
      );
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Every provider id the bot's server holds a credential for: the keys Morse
 * wrote into the bot's own `auth.json`, plus what the server's store already
 * answers (a snapshot the global import just ran, or a login from an earlier
 * boot of the same roots). Best-effort: a store that cannot be read simply
 * contributes nothing, and the catalog read stays a single pass.
 */
export function credentialedProviders(
  botRoot: string,
  server: { url: string; password: string },
  logger: MorseLogger,
): string[] {
  const ids = new Set<string>();
  try {
    const raw = readFileSync(join(botRoot, 'sessions', 'opencode', 'auth.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [id, entry] of Object.entries(parsed)) {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as Record<string, unknown>)['key'] === 'string'
        ) {
          ids.add(id);
        }
      }
    }
  } catch {
    // No bot keys yet: the server's own store may still hold the snapshot.
  }
  try {
    const out = execFileSync(
      findOpenCodeBinary() ?? 'opencode',
      ['auth', 'list', '--format', 'json', '--server', server.url],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, OPENCODE_PASSWORD: server.password },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const parsed: unknown = JSON.parse(out);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) {
          continue;
        }
        const id = (entry as Record<string, unknown>)['id'];
        if (typeof id === 'string' && id.length > 0) {
          ids.add(id);
        }
      }
    }
  } catch (error: unknown) {
    logger.warn('The bot engine credential list could not be read', error);
  }
  return [...ids];
}
