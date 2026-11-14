import type { BotProviderCredential, BotProviderModel } from './types.js';

/**
 * Model discovery for OpenAI-compatible endpoints — the one listing API both
 * engines' custom providers commonly speak (`GET {baseUrl}/models`, bearer
 * credential). Morse reads the listing so the wizard can show it; writing the
 * discovered entries into the bot's own config is each integration's job.
 *
 * Everything else (catalog providers, Anthropic/Google-native endpoints without
 * a listing route) is discovered by the engine's own probe or entered by hand.
 */

export async function discoverOpenAiCompatibleModels(
  baseUrl: string,
  credential: BotProviderCredential,
  timeoutMs = 15_000,
): Promise<BotProviderModel[]> {
  const listing = await fetchListing(joinUrl(baseUrl, 'models'), credential, timeoutMs);
  const data = plainObjectOf(listing)?.['data'];
  if (!Array.isArray(data)) {
    throw new Error('The endpoint did not answer with a model listing.');
  }
  return data
    .filter((entry): entry is Record<string, unknown> => plainObjectOf(entry) !== undefined)
    .map((entry) => ({
      id: String(entry['id'] ?? ''),
      ...(typeof entry['owned_by'] === 'string' && entry['owned_by'].length > 0
        ? { name: `${entry['id']} (${entry['owned_by']})` }
        : {}),
    }))
    .filter((model) => model.id.length > 0);
}

async function fetchListing(
  url: string,
  credential: BotProviderCredential,
  timeoutMs: number,
): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (credential.kind === 'stored') {
    headers['authorization'] = `Bearer ${credential.apiKey}`;
  } else {
    const value = process.env[credential.name];
    if (value === undefined || value.length === 0) {
      throw new Error(`The environment variable ${credential.name} is not set on the host.`);
    }
    headers['authorization'] = `Bearer ${value}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`The endpoint answered ${response.status} for ${url}`);
  }
  return response.json();
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}/${suffix}`;
}

function plainObjectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
