/**
 * OpenCode provider sign-ins, managed from Morse's settings page.
 *
 * Morse holds no provider catalog: the list comes from OpenCode's own auth file
 * and config. Sign-in always runs OpenCode's `auth login` in an interactive
 * terminal, so OpenCode owns the provider list, auth method and credential
 * shape (which has moved between releases). A new provider or auth method needs
 * no change here, and no secret is ever sent to the UI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asProviderModel, type ConfigMutation, type ProviderInfo, type ProviderModel } from '@morse/protocol';
import { resolveEngineContext, type ConfigDocument } from '@morse/engine-config';
import { discoverOpenAiCompatibleModels, writePrivateJson } from '@morse/system';

import {
  OpenCodeEngineDefinition,
  type OpenCodeEngineInstance,
} from '../engine/open-code-engine.js';
import type { OpenCodeApi } from '../internal/client.js';
import { resolveOpenCodeSpawn } from '../internal/resolve-opencode.js';
import { OPENCODE_PACKAGE } from '../bot-engine.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const DEFAULT_API = 'openai-completions';

interface ConnectInput {
  providerId: string;
  key?: string;
  name?: string;
  baseURL?: string;
  api?: string;
  models?: ProviderModel[];
}

function inputOf(value: unknown): ConnectInput {
  const data = isRecord(value) ? value : undefined;
  const providerId = typeof data?.['providerId'] === 'string' ? data['providerId'].trim() : '';
  if (!ID_PATTERN.test(providerId)) {
    throw new Error('A provider id of letters, digits, dashes and underscores is required.');
  }
  return {
    providerId,
    ...(typeof data?.['key'] === 'string' ? { key: data['key'].trim() } : {}),
    ...(typeof data?.['name'] === 'string' ? { name: data['name'].trim() } : {}),
    ...(typeof data?.['baseURL'] === 'string' ? { baseURL: data['baseURL'].trim() } : {}),
    ...(typeof data?.['api'] === 'string' ? { api: data['api'].trim() } : {}),
    ...(Array.isArray(data?.['models'])
      ? { models: data['models'].flatMap((m) => asProviderModel(m) ?? []) }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(value)) {
      throw new Error('expected a JSON object');
    }
    return value;
  } catch (error: unknown) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function displayName(id: string): string {
  return id
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface NativeIntegration {
  id: string;
  name: string;
  methods: { type: string }[];
  connections: unknown[];
}

export class OpenCodeProviders {
  private readonly engine: OpenCodeEngineInstance;
  private readonly authPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly api?: OpenCodeApi;

  constructor(
    options: { env?: NodeJS.ProcessEnv; configDir?: string; api?: OpenCodeApi } = {},
  ) {
    this.env = options.env ?? process.env;
    this.api = options.api;
    const context = resolveEngineContext({ env: this.env });
    this.engine = new OpenCodeEngineDefinition(
      options.configDir === undefined ? {} : { configDir: options.configDir },
    ).create(context) as OpenCodeEngineInstance;
    this.authPath = join(context.xdgDataHome, 'opencode', 'auth.json');
  }

  /** OpenCode's own integration registry: every provider and auth method it knows. */
  private async integrations(): Promise<NativeIntegration[]> {
    if (this.api === undefined) {
      return [];
    }
    try {
      const data = await this.api.get<unknown>('/integration');
      if (!Array.isArray(data)) {
        return [];
      }
      return data.flatMap((raw) => {
        const one = isRecord(raw) ? raw : {};
        if (typeof one['id'] !== 'string' || typeof one['name'] !== 'string') {
          return [];
        }
        return [{
          id: one['id'],
          name: one['name'],
          methods: Array.isArray(one['methods'])
            ? one['methods'].flatMap((m) => {
                const method = isRecord(m) ? m : {};
                return typeof method['type'] === 'string' ? [{ type: method['type'] }] : [];
              })
            : [],
          connections: Array.isArray(one['connections']) ? one['connections'] : [],
        }];
      });
    } catch {
      return [];
    }
  }

  /** The config document the provider blocks live in, with its write issues. */
  private config(): ConfigDocument {
    return this.engine.file('config', 'global').read();
  }

  private async writeConfig(value: unknown): Promise<ConfigMutation> {
    return this.engine.file('config', 'global').write(value) as ConfigMutation;
  }

  /** OpenCode's own `auth login`, for every provider and auth method it supports. */
  async loginCommand(value: unknown): Promise<unknown> {
    const data = isRecord(value) ? value : undefined;
    const providerId = typeof data?.['providerId'] === 'string' ? data['providerId'].trim() : '';
    if (!ID_PATTERN.test(providerId)) {
      return undefined;
    }
    const spawn = resolveOpenCodeSpawn('opencode', this.env);
    if (spawn === undefined) {
      return undefined;
    }
    return { file: spawn.command, args: [...spawn.prefix, 'auth', 'login', providerId] };
  }

  async list(): Promise<unknown> {
    const auth = readObject(this.authPath);
    const document = this.config();
    const root = isRecord(document.value) ? document.value : {};
    // OpenCode's native schema uses singular `provider`; older Morse writes used
    // plural `providers`. Read both so a config block is never missed (a missed
    // block would demote a custom endpoint to a key-only builtin).
    const configured = {
      ...(isRecord(root['providers']) ? root['providers'] : {}),
      ...(isRecord(root['provider']) ? root['provider'] : {}),
    };
    const providers = new Map<string, ProviderInfo>();
    const put = (next: ProviderInfo): void => {
      const previous = providers.get(next.id);
      providers.set(next.id, previous === undefined ? next : {
        ...previous,
        ...next,
        // A provider with a config block is a custom endpoint even when the
        // engine's registry also knows the id. Keep its models and endpoint.
        ...(previous.kind === 'custom' || next.kind === 'custom'
          ? {
              kind: 'custom' as const,
              baseURL: next.baseURL ?? previous.baseURL,
              api: next.api ?? previous.api,
              models: next.models ?? previous.models,
              description: next.kind === 'custom' ? next.description : previous.description,
            }
          : {}),
        connected: previous.connected || next.connected,
      });
    };

    // OpenCode's own registry: every provider it knows, with the sign-in methods
    // it actually offers. Morse holds no catalog of its own.
    const integrations = await this.integrations();
    if (integrations.length > 0) {
      for (const one of integrations) {
        const connected = one.connections.length > 0 || hasStored(auth, one.id);
        put({
          id: one.id,
          name: one.name,
          description: 'Provider in OpenCode',
          kind: 'builtin',
          connected,
          ...(one.connections.length > 0 ? { source: 'stored' as const } : {}),
          auth: {
            ...(one.methods.some((method) => method.type === 'key') ? { key: true } : {}),
            ...(one.methods.some((method) => method.type === 'oauth') ? { signIn: true } : {}),
          },
        });
      }
    } else {
      // No running OpenCode to ask: stored credentials still name providers.
      for (const [id, entry] of Object.entries(auth)) {
        const one = isRecord(entry) ? entry : {};
        const type = typeof one['type'] === 'string' ? one['type'] : '';
        const connected = (typeof one['key'] === 'string' && one['key'].length > 0) ||
          (type.length > 0 && type !== 'api');
        put({
          id,
          name: displayName(id),
          description: type.length > 0 ? `${type} sign-in` : 'Stored sign-in',
          kind: 'builtin',
          connected,
          ...(connected ? { source: 'stored' as const } : {}),
        });
      }
    }

    // Custom provider blocks in OpenCode's own config.
    for (const [id, entry] of Object.entries(configured)) {
      const one = isRecord(entry) ? entry : {};
      // OpenCode accepts both `settings` (its newer schema) and `options`
      // (the legacy schema still in use by existing configs).
      const settings = {
        ...(isRecord(one['options']) ? one['options'] : {}),
        ...(isRecord(one['settings']) ? one['settings'] : {}),
      };
      const hasKey =
        (typeof settings['apiKey'] === 'string' && settings['apiKey'].length > 0) || hasStored(auth, id);
      const connected = hasKey || hasEnvOf(one['env'], this.env);
      put({
        id,
        name: typeof one['name'] === 'string' && one['name'].length > 0 ? one['name'] : displayName(id),
        description: 'Custom endpoint',
        kind: 'custom',
        connected,
        ...(hasKey ? { source: 'config' as const } : {}),
        ...(typeof settings['baseURL'] === 'string' ? { baseURL: settings['baseURL'] } : {}),
        ...(typeof one['package'] === 'string'
          ? { api: packageApi(one['package']) }
          : typeof one['npm'] === 'string'
            ? { api: packageApi(one['npm']) }
            : {}),
        ...(isRecord(one['models'])
          ? {
              models: Object.entries(one['models']).flatMap(([modelId, raw]) => {
                const row = isRecord(raw) ? raw : {};
                const limit = isRecord(row['limit']) ? row['limit'] : {};
                // OpenCode writes `modalities: { input: [...] }`; older Morse
                // writes used `capabilities: { input: [...] }`. Read both.
                const modalities = isRecord(row['modalities']) ? row['modalities'] : {};
                const capabilities = isRecord(row['capabilities']) ? row['capabilities'] : {};
                const input = Array.isArray(modalities['input'])
                  ? modalities['input']
                  : Array.isArray(capabilities['input'])
                    ? capabilities['input']
                    : undefined;
                const variants = Array.isArray(row['variants'])
                  ? row['variants'].flatMap((variant) => {
                      const v = isRecord(variant) ? variant : {};
                      return typeof v['id'] === 'string' ? [v['id']] : [];
                    })
                  : [];
                return asProviderModel({
                  id: modelId,
                  ...row,
                  ...(typeof limit['context'] === 'number' ? { contextWindow: limit['context'] } : {}),
                  ...(typeof limit['output'] === 'number' ? { maxTokens: limit['output'] } : {}),
                  ...(input === undefined ? {} : { input }),
                  ...(variants.length > 0 ? { thinkingLevels: variants } : {}),
                }) ?? [];
              }),
            }
          : {}),
      });
    }

    return { engine: 'opencode', providers: [...providers.values()], issues: document.issues ?? [] };
  }

  async connect(value: unknown): Promise<unknown> {
    const input = inputOf(value);
    const custom = input.baseURL !== undefined && input.baseURL.length > 0;
    if (!custom) {
      if (input.key === undefined) {
        return {
          ok: false,
          message: 'Paste an API key, or use `Sign in` for an account/subscription.',
        };
      }
      if (this.api !== undefined) {
        // OpenCode owns its credential store (a backend DB in 2.x); ask its own
        // connect endpoint rather than guessing where a key should be written.
        try {
          await this.api.post(
            `/integration/${encodeURIComponent(input.providerId)}/connect/key`,
            { key: input.key, ...(input.name === undefined ? {} : { label: input.name }) },
          );
          return { ok: true, message: `Connected ${input.name ?? input.providerId} for OpenCode.` };
        } catch (error: unknown) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : 'OpenCode could not save this key.',
          };
        }
      }
      const auth = readObject(this.authPath);
      writePrivateJson(this.authPath, { ...auth, [input.providerId]: { type: 'api', key: input.key } });
      return { ok: true, message: `Connected ${input.name ?? input.providerId} for OpenCode.` };
    }
    if (!/^https?:\/\//.test(input.baseURL ?? '')) {
      return { ok: false, message: 'The base URL must start with http:// or https://.' };
    }
    if ((input.models ?? []).length === 0) {
      return { ok: false, message: 'Add at least one model id for a custom provider.' };
    }

    const document = this.config();
    const root = isRecord(document.value) ? document.value : {};
    // Native schema is singular `provider`; keep writing where the entry lives
    // so OpenCode keeps reading it. New entries use the native singular key.
    const blockKey = isRecord(root['provider']) &&
        (input.providerId in root['provider'] || !isRecord(root['providers']) || !(input.providerId in root['providers']))
      ? 'provider'
      : isRecord(root['providers']) && input.providerId in root['providers'] && !isRecord(root['provider'])
        ? 'providers'
        : isRecord(root['provider'])
          ? 'provider'
          : isRecord(root['providers'])
            ? 'providers'
            : 'provider';
    const configured = isRecord(root[blockKey]) ? root[blockKey] : {};
    const keptProvider = configured[input.providerId];
    const previous = isRecord(keptProvider) ? keptProvider : {};
    // Preserve whichever schema the existing block uses. Writing `settings` into
    // an `options` block would leave the URL and key where OpenCode never reads.
    const legacy = isRecord(previous['options']);
    const field = legacy ? 'options' : 'settings';
    const settings = isRecord(previous[field]) ? previous[field] : {};
    const models = isRecord(previous['models']) ? previous['models'] : {};
    const npm = typeof previous['npm'] === 'string' ? previous['npm'] : undefined;
    const api = input.api ?? (npm !== undefined
      ? packageApi(npm)
      : typeof previous['package'] === 'string'
        ? packageApi(previous['package'])
        : DEFAULT_API);
    const entry = {
      ...previous,
      name: input.name ?? (typeof previous['name'] === 'string' ? previous['name'] : input.providerId),
      ...(legacy ? { npm: npm ?? OPENCODE_PACKAGE[api as keyof typeof OPENCODE_PACKAGE] ?? OPENCODE_PACKAGE[DEFAULT_API] } : {}),
      ...(legacy ? {} : { package: OPENCODE_PACKAGE[api as keyof typeof OPENCODE_PACKAGE] ?? OPENCODE_PACKAGE[DEFAULT_API] }),
      [field]: {
        ...settings,
        baseURL: input.baseURL,
        ...(input.key === undefined ? {} : { apiKey: input.key }),
      },
      models: Object.fromEntries((input.models ?? []).map((model) => {
        const keptModel = models[model.id];
        const kept = isRecord(keptModel) ? keptModel : {};
        const keptLimit = isRecord(kept['limit']) ? kept['limit'] : {};
        const keptModalities = isRecord(kept['modalities']) ? kept['modalities'] : {};
        const context = model.contextWindow ?? (typeof keptLimit['context'] === 'number' ? keptLimit['context'] : undefined);
        const output = model.maxTokens ?? (typeof keptLimit['output'] === 'number' ? keptLimit['output'] : undefined);
        const variants = model.thinkingLevels ?? (Array.isArray(kept['variants']) ? kept['variants'] : undefined);
        return [model.id, (() => {
          const { capabilities: _dropped, ...rest } = kept;
          return {
            ...rest,
            name: model.name ?? (typeof kept['name'] === 'string' ? kept['name'] : model.id),
            ...(context === undefined && output === undefined ? {} : {
              limit: {
                ...keptLimit,
                ...(context === undefined ? {} : { context }),
                ...(output === undefined ? {} : { output }),
              },
            }),
            // Native schema is `modalities: { input, output }`.
            ...(model.input === undefined && !isRecord(kept['modalities']) ? {} : {
              modalities: {
                ...keptModalities,
                ...(model.input === undefined ? {} : { input: model.input }),
              },
            }),
            ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
            ...(variants === undefined ? {} : { variants: variants.map((level) => ({ id: level })) }),
          };
        })()];
      })),
    };
    const written = await this.writeConfig({ ...root, [blockKey]: { ...configured, [input.providerId]: entry } });
    return written.ok
      ? { ok: true, message: `Connected ${input.name ?? input.providerId} for OpenCode.` }
      : { ok: false, message: written.message ?? 'Could not update the OpenCode config.', ...(written.issues ? { issues: written.issues } : {}) };
  }

  /** List a custom endpoint's models, reusing the same discovery bot mode uses. */
  async discover(value: unknown): Promise<unknown> {
    const data = isRecord(value) ? value : undefined;
    const baseURL = typeof data?.['baseURL'] === 'string' ? data['baseURL'].trim() : '';
    if (!/^https?:\/\//.test(baseURL)) {
      return { ok: false, message: 'The base URL must start with http:// or https://.' };
    }
    const raw = typeof data?.['key'] === 'string' ? data['key'].trim() : '';
    const env = raw.match(/^\{env:([^}]+)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    const name = env?.[1] ?? env?.[2];
    const credential =
      raw.length === 0
        ? undefined
        : name !== undefined && this.env[name] !== undefined
          ? { kind: 'env' as const, name }
          : { kind: 'stored' as const, apiKey: raw };
    try {
      const models = await discoverOpenAiCompatibleModels(
        baseURL,
        credential ?? { kind: 'stored', apiKey: '' },
      );
      return { ok: true, models };
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : 'Discovery failed.' };
    }
  }

  async disconnect(value: unknown): Promise<unknown> {
    const data = isRecord(value) ? value : undefined;
    const providerId = typeof data?.['providerId'] === 'string' ? data['providerId'] : '';
    if (providerId.length === 0) {
      return { ok: false, message: 'No provider named to disconnect.' };
    }

    let changed = false;
    if (this.api !== undefined) {
      try {
        const credentials = await this.api.get<unknown>('/credential');
        if (Array.isArray(credentials)) {
          for (const raw of credentials) {
            const one = isRecord(raw) ? raw : {};
            if (one['integrationID'] === providerId && typeof one['id'] === 'string') {
              await this.api.delete(`/credential/${encodeURIComponent(one['id'])}`);
              changed = true;
            }
          }
        }
      } catch {
        // A failed credential removal still leaves the config cleanup below.
      }
    }

    const auth = readObject(this.authPath);
    if (providerId in auth) {
      const next = { ...auth };
      delete next[providerId];
      writePrivateJson(this.authPath, next);
      changed = true;
    }

    const document = this.config();
    const root = isRecord(document.value) ? document.value : {};
    // The entry may live under native `provider` or legacy `providers`; clean
    // whichever block holds it.
    const blockKey = isRecord(root['provider']) && providerId in root['provider']
      ? 'provider'
      : isRecord(root['providers']) && providerId in root['providers']
        ? 'providers'
        : isRecord(root['provider'])
          ? 'provider'
          : 'providers';
    const configured = isRecord(root[blockKey]) ? root[blockKey] : {};
    const keptEntry = configured[providerId];
    const entry = isRecord(keptEntry) ? keptEntry : undefined;
    if (entry !== undefined) {
      const field = isRecord(entry['options']) ? 'options' : 'settings';
      const settings = isRecord(entry[field]) ? entry[field] : {};
      if ('apiKey' in settings || 'env' in entry) {
        const next = { ...settings };
        delete next['apiKey'];
        const provider: Record<string, unknown> = { ...entry, [field]: next };
        delete provider['env'];
        const written = await this.writeConfig({ ...root, [blockKey]: { ...configured, [providerId]: provider } });
        if (!written.ok) {
          return { ok: false, message: written.message ?? 'Could not update the OpenCode config.', ...(written.issues ? { issues: written.issues } : {}) };
        }
        changed = true;
      }
    }
    return { ok: true, message: changed ? `Disconnected ${providerId} from OpenCode.` : `${providerId} was not connected.` };
  }
}

function hasStored(auth: Record<string, unknown>, id: string): boolean {
  const entry = auth[id];
  return isRecord(entry) && typeof entry['key'] === 'string' && entry['key'].length > 0;
}

function hasEnv(name: unknown, env: NodeJS.ProcessEnv): boolean {
  return typeof name === 'string' && name.length > 0 && (env[name] ?? '').length > 0;
}

function hasEnvOf(names: unknown, env: NodeJS.ProcessEnv): boolean {
  return Array.isArray(names) && names.some((name) => hasEnv(name, env));
}

function packageApi(pkg: string): string {
  const entry = Object.entries(OPENCODE_PACKAGE).find(([, value]) => value === pkg);
  return entry?.[0] ?? DEFAULT_API;
}
