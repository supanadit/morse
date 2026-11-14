import { MODEL_INPUTS, type ModelInput } from '@morse/agent';
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
      ...capabilitiesOf(entry),
    }))
    .filter((model) => model.id.length > 0);
}

/**
 * What a listing happens to say about a model's capabilities — the context
 * window, the response cap, the modalities — read from the handful of field
 * spellings OpenAI-compatible servers actually use.
 *
 * Deliberately best-effort: a listing is not a spec, and a wrong guess is worse
 * than none (a too-small window makes an engine compact early, a too-large one
 * overflows the model). Anything not found stays absent, which writes nothing and
 * leaves the engine's own default; the wizard shows each field so a reader can
 * correct it either way.
 */
function capabilitiesOf(entry: Record<string, unknown>): Partial<BotProviderModel> {
  const top = plainObjectOf(entry['top_provider']) ?? {};
  const architecture = plainObjectOf(entry['architecture']) ?? {};
  const contextWindow =
    positiveNumber(entry['context_length']) ??
    positiveNumber(entry['context_window']) ??
    positiveNumber(entry['max_context_length']) ??
    positiveNumber(entry['max_model_len']) ??
    positiveNumber(top['context_length']);
  const maxTokens =
    positiveNumber(entry['max_output_tokens']) ??
    positiveNumber(entry['max_completion_tokens']) ??
    positiveNumber(entry['max_tokens']) ??
    positiveNumber(top['max_completion_tokens']);
  const modalities = modalitiesOf(entry, architecture);
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(modalities === undefined ? {} : { input: modalities }),
  };
}

/**
 * The input modalities a listing declares: OpenRouter's
 * `architecture.input_modalities`, a `capabilities.vision` flag, or a bare
 * `supports_vision`. Absent when the server said nothing, so the reader's choice
 * stands instead of being overwritten by a guess.
 */
function modalitiesOf(
  entry: Record<string, unknown>,
  architecture: Record<string, unknown>,
): ModelInput[] | undefined {
  const listed = architecture['input_modalities'] ?? entry['input_modalities'] ?? entry['input'];
  if (Array.isArray(listed)) {
    const known = listed.filter(
      (one): one is ModelInput =>
        typeof one === 'string' && MODEL_INPUTS.includes(one as ModelInput),
    );
    if (known.length > 0) {
      return [...new Set(['text' as ModelInput, ...known])];
    }
  }
  const capabilities = plainObjectOf(entry['capabilities']) ?? {};
  const vision = capabilities['vision'] ?? entry['supports_vision'] ?? entry['vision'];
  if (typeof vision === 'boolean') {
    return vision ? ['text', 'image'] : ['text'];
  }
  return undefined;
}

/** A token count a listing can be trusted with: a positive, finite integer. */
function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
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
