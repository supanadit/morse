/**
 * Provider management: the wire shapes a settings page reads and writes.
 *
 * Morse holds no provider catalog and no opinion about how a provider signs in.
 * Each engine reports the providers it knows in `providerStatus`, and opens its
 * own login TUI through `providerLogin`. A new provider or auth method in an
 * engine therefore needs no change here. No credential ever comes back to the
 * frontend: `connected` is a boolean, and the secret stays in the engine's own
 * store, where the CLI can use it too.
 */
import type { ConfigIssue } from './config.js';
import type { ModelInput, ThinkingLevel } from './primitives.js';

/** One model of a provider, with the fields both engines' config files hold. */
export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInput[];
  reasoning?: boolean;
  /** Level → the engine's own value; null disables a level. pi stores this map. */
  thinking?: Partial<Record<ThinkingLevel, string | null>>;
  /** Enabled thinking levels (OpenCode variants). */
  thinkingLevels?: ThinkingLevel[];
}

/** One provider as the host's engine reports it, with no credential attached. */
export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  /** Built-ins come from the engine's own catalog; custom endpoints from its config. */
  kind: 'builtin' | 'custom';
  connected: boolean;
  /** How the engine found a credential, for the connected badge's tooltip. */
  source?: 'stored' | 'env' | 'config';
  /** A custom provider's models, so an Edit can prefill every field. */
  models?: ProviderModel[];
  /** Custom provider's endpoint and protocol, so an Edit can prefill them. */
  baseURL?: string;
  api?: string;
  /** What the engine itself lets Morse do with this provider. */
  auth?: {
    /** An API key pasted in Morse can be stored by the engine. */
    key?: boolean;
    /** The engine has an account sign-in (run in Morse's terminal). */
    signIn?: boolean;
  };
}

/** What the `providerStatus` command answers for one engine. */
export interface ProviderStatus {
  engine: string;
  providers: ProviderInfo[];
  /** A config file that must be fixed before the page can write to it. */
  issues: ConfigIssue[];
}

/** What `providerConnect` takes. A custom provider needs the endpoint fields. */
export interface ProviderConnectInput {
  providerId: string;
  /** Omitted, `{env:NAME}`, or `$NAME` to point at an environment variable. */
  key?: string;
  name?: string;
  baseURL?: string;
  api?: string;
  models?: ProviderModel[];
}

/** What `providerDiscover` takes: list the models a custom endpoint serves. */
export interface ProviderDiscoverInput {
  baseURL: string;
  providerId?: string;
  /** Stored literal or `{env:NAME}` / `$NAME` env reference. */
  key?: string;
  api?: string;
}

/** What `providerDiscover` answers: models the endpoint listed, or why it could not. */
export interface ProviderDiscoverResult {
  ok: boolean;
  message?: string;
  models?: ProviderModel[];
}

/** What `providerDisconnect` takes. */
export interface ProviderDisconnectInput {
  providerId: string;
}

/** What the two provider mutations answer. */
export interface ProviderMutation {
  ok: boolean;
  message?: string;
  issues?: ConfigIssue[];
}

/** What `providerLogin` answers: the terminal the engine's login TUI is in. */
export interface ProviderLoginResult {
  ok: boolean;
  message?: string;
  /** The terminal id to show, when the host opened one. */
  terminalId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const INPUTS: readonly ModelInput[] = ['text', 'image', 'audio', 'video', 'pdf'];
const LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Reads one model, dropping fields that are not engine-valid. */
export function asProviderModel(value: unknown): ProviderModel | undefined {
  const one = record(value);
  if (one === undefined || typeof one['id'] !== 'string' || one['id'].length === 0) {
    return undefined;
  }
  const thinking: Partial<Record<ThinkingLevel, string | null>> = {};
  const rawThinking = record(one['thinking']);
  if (rawThinking !== undefined) {
    for (const level of LEVELS) {
      const value = rawThinking[level];
      if (value === null || typeof value === 'string') {
        thinking[level] = value;
      }
    }
  }
  return {
    id: one['id'],
    ...(typeof one['name'] === 'string' && one['name'].length > 0 ? { name: one['name'] } : {}),
    ...(typeof one['contextWindow'] === 'number' && one['contextWindow'] > 0
      ? { contextWindow: Math.floor(one['contextWindow']) }
      : {}),
    ...(typeof one['maxTokens'] === 'number' && one['maxTokens'] > 0
      ? { maxTokens: Math.floor(one['maxTokens']) }
      : {}),
    ...(Array.isArray(one['input'])
      ? { input: one['input'].filter((i): i is ModelInput => typeof i === 'string' && INPUTS.includes(i as ModelInput)) }
      : {}),
    ...(typeof one['reasoning'] === 'boolean' ? { reasoning: one['reasoning'] } : {}),
    ...(Object.keys(thinking).length > 0 ? { thinking } : {}),
    ...(Array.isArray(one['thinkingLevels'])
      ? { thinkingLevels: one['thinkingLevels'].filter((l): l is ThinkingLevel => typeof l === 'string' && LEVELS.includes(l as ThinkingLevel)) }
      : {}),
  };
}

/** Reads a discovery answer; `ok: false` is the endpoint's own message. */
export function asProviderDiscover(value: unknown): ProviderDiscoverResult {
  const data = record(value);
  if (data === undefined || data['ok'] !== true) {
    return {
      ok: false,
      message: typeof data?.['message'] === 'string' ? data['message'] : 'The endpoint did not list its models.',
    };
  }
  return {
    ok: true,
    ...(typeof data['message'] === 'string' ? { message: data['message'] } : {}),
    ...(Array.isArray(data['models'])
      ? { models: data['models'].flatMap((one) => asProviderModel(one) ?? []) }
      : {}),
  };
}

/** Reads a host answer without trusting it: a malformed reply is `undefined`. */
export function asProviderStatus(value: unknown): ProviderStatus | undefined {
  const data = record(value);
  if (data === undefined || typeof data['engine'] !== 'string' || !Array.isArray(data['providers'])) {
    return undefined;
  }
  const providers: ProviderInfo[] = [];
  for (const item of data['providers']) {
    const one = record(item);
    if (one === undefined || typeof one['id'] !== 'string' || typeof one['name'] !== 'string') {
      continue;
    }
    providers.push({
      id: one['id'],
      name: one['name'],
      description: typeof one['description'] === 'string' ? one['description'] : '',
      kind: one['kind'] === 'custom' ? 'custom' : 'builtin',
      connected: one['connected'] === true,
      ...(one['source'] === 'stored' || one['source'] === 'env' || one['source'] === 'config'
        ? { source: one['source'] }
        : {}),
      ...(Array.isArray(one['models'])
        ? { models: one['models'].flatMap((m) => asProviderModel(m) ?? []) }
        : {}),
      ...(typeof one['baseURL'] === 'string' ? { baseURL: one['baseURL'] } : {}),
      ...(typeof one['api'] === 'string' ? { api: one['api'] } : {}),
      ...(() => {
        const auth = record(one['auth']);
        return auth === undefined
          ? {}
          : {
              auth: {
                ...(auth['key'] === true ? { key: true } : {}),
                ...(auth['signIn'] === true ? { signIn: true } : {}),
              },
            };
      })(),
    });
  }
  return {
    engine: data['engine'],
    providers,
    issues: Array.isArray(data['issues']) ? (data['issues'] as ConfigIssue[]) : [],
  };
}

/** Reads a mutation answer; an older host's `undefined` is a refusal, not success. */
export function asProviderMutation(value: unknown): ProviderMutation {
  const data = record(value);
  if (data === undefined || data['ok'] !== true) {
    return {
      ok: false,
      message: typeof data?.['message'] === 'string' ? data['message'] : 'The host could not save this provider.',
    };
  }
  return {
    ok: true,
    ...(typeof data['message'] === 'string' ? { message: data['message'] } : {}),
    ...(Array.isArray(data['issues']) ? { issues: data['issues'] as ConfigIssue[] } : {}),
  };
}

/** Reads a login answer; an older host's `undefined` is a refusal, not success. */
export function asProviderLogin(value: unknown): ProviderLoginResult {
  const data = record(value);
  if (data === undefined || data['ok'] !== true) {
    return {
      ok: false,
      message: typeof data?.['message'] === 'string' ? data['message'] : 'This host cannot open a provider sign-in.',
    };
  }
  return {
    ok: true,
    ...(typeof data['message'] === 'string' ? { message: data['message'] } : {}),
    ...(typeof data['terminalId'] === 'string' ? { terminalId: data['terminalId'] } : {}),
  };
}
