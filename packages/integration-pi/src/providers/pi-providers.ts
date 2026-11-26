/**
 * pi's provider sign-ins, managed from Morse's settings page.
 *
 * Morse holds no provider catalog: the list comes from pi's own files — its
 * model cache (`models-store.json`), stored credentials (`auth.json`) and custom
 * endpoints (`models.json`). Sign-in is always pi's own `auth login`, run by the
 * host in an interactive terminal, so a new provider or auth method in pi needs
 * no change here. The credential stays in pi's store; Morse never returns it.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { asProviderModel, type ProviderInfo, type ProviderModel } from '@morse/protocol';
import { resolveEngineContext } from '@morse/engine-config';
import { discoverOpenAiCompatibleModels, writePrivateJson } from '@morse/system';

import { PiEngineDefinition, type PiEngineInstance } from '../engine/pi-engine.js';
import { resolvePiCli } from '../internal/resolve-pi.js';
import { isRecord } from '../internal/rpc/helpers.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const DEFAULT_API = 'openai-completions';

/** The subset of `providerConnect` this engine understands. */
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

/** Read a JSON object, or `{}` when it is absent; a corrupt file is never overwritten. */
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

/** A readable name from pi's provider id, with no hardcoded provider table. */
function displayName(id: string): string {
  return id
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Accept both `{env:NAME}` and pi's own `$NAME` env reference. */
function credentialKey(key: string | undefined): string | undefined {
  if (key === undefined || key.length === 0) {
    return undefined;
  }
  const env = key.match(/^\{env:([^}]+)\}$/);
  return env === null ? key : `$${env[1]?.trim() ?? ''}`;
}

interface BuiltinProvider {
  id: string;
  name: string;
  key: boolean;
  signIn: boolean;
}

/** Where pi keeps its own provider definitions, for managed and global installs. */
function catalogModulePath(agentDir: string, env: NodeJS.ProcessEnv): string | undefined {
  const versionFile = join(agentDir, 'install', 'current-version');
  if (existsSync(versionFile)) {
    const version = readFileSync(versionFile, 'utf8').trim();
    const path = join(
      agentDir,
      'install',
      'releases',
      version,
      'node_modules',
      '@earendil-works',
      'pi-ai',
      'dist',
      'providers',
      'all.js',
    );
    if (existsSync(path)) {
      return path;
    }
  }
  try {
    let directory = dirname(realpathSync(resolvePiCli({ env: { ...process.env, ...env } }).command));
    for (let at = 0; at < 8; at += 1) {
      const suffix = join('node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'all.js');
      const candidate = join(directory, suffix);
      if (existsSync(candidate)) {
        return candidate;
      }
      // Managed installs keep releases under the agent dir the shim lives in.
      const releases = join(directory, 'install', 'releases');
      if (existsSync(releases)) {
        for (const version of readdirSync(releases)) {
          const managed = join(releases, version, suffix);
          if (existsSync(managed)) {
            return managed;
          }
        }
      }
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  } catch {
    // A missing pi CLI means Morse could not run an agent either; keep going.
  }
  return undefined;
}

const builtinCache = new Map<string, Promise<BuiltinProvider[]>>();

/** pi's own catalog: every provider it can sign in to, with its auth methods. */
async function builtinProviders(agentDir: string, env: NodeJS.ProcessEnv): Promise<BuiltinProvider[]> {
  const path = catalogModulePath(agentDir, env);
  if (path === undefined) {
    return [];
  }
  let cached = builtinCache.get(path);
  if (cached === undefined) {
    cached = import(pathToFileURL(path).href)
      .then((module: { builtinProviders?: () => unknown }) => {
        const list = module.builtinProviders?.();
        if (!Array.isArray(list)) {
          return [];
        }
        return list.flatMap((raw): BuiltinProvider[] => {
          const one = isRecord(raw) ? raw : {};
          if (typeof one['id'] !== 'string') {
            return [];
          }
          const auth = isRecord(one['auth']) ? one['auth'] : {};
          return [{
            id: one['id'],
            name: typeof one['name'] === 'string' ? one['name'] : displayName(one['id']),
            key: auth['apiKey'] !== undefined,
            signIn: auth['oauth'] !== undefined,
          }];
        });
      })
      .catch(() => []);
    builtinCache.set(path, cached);
  }
  return cached;
}

export class PiProviders {
  private readonly agentDir: string;
  private readonly engine: PiEngineInstance;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: { env?: NodeJS.ProcessEnv } = {}) {
    this.env = options.env ?? process.env;
    this.engine = new PiEngineDefinition().create(
      resolveEngineContext({ env: this.env }),
    ) as PiEngineInstance;
    this.agentDir = this.engine.agentDir;
  }

  private get authPath(): string {
    return join(this.agentDir, 'auth.json');
  }

  private get modelsPath(): string {
    return join(this.agentDir, 'models.json');
  }

  private get catalogPath(): string {
    return join(this.agentDir, 'models-store.json');
  }

  async list(): Promise<unknown> {
    const auth = readObject(this.authPath);
    const models = readObject(this.modelsPath);
    const catalog = readObject(this.catalogPath);
    const configured = isRecord(models['providers']) ? models['providers'] : {};
    const known = isRecord(catalog) ? catalog : {};
    const providers: ProviderInfo[] = [];
    const seen = new Set<string>();

    // pi's own catalog: every provider it knows, with pi's own names and auth
    // methods. Morse adds no provider list of its own.
    const builtins = await builtinProviders(this.agentDir, this.env);
    for (const builtin of builtins) {
      const knownEntry = known[builtin.id];
      const detail = isRecord(knownEntry) ? knownEntry : undefined;
      const models = Array.isArray(detail?.['models']) ? detail['models'] : undefined;
      const has = hasStored(auth, builtin.id);
      providers.push({
        id: builtin.id,
        name: builtin.name,
        description: models === undefined ? 'Provider in pi' : `${models.length} models in pi's catalog`,
        kind: 'builtin',
        connected: has || builtin.id in configured,
        ...(has ? { source: 'stored' as const } : {}),
        auth: {
          ...(builtin.key ? { key: true } : {}),
          ...(builtin.signIn ? { signIn: true } : {}),
        },
        ...(models === undefined
          ? {}
          : {
              models: models.flatMap((raw) => {
                const row = isRecord(raw) ? raw : {};
                const map = isRecord(row['thinkingLevelMap']) ? row['thinkingLevelMap'] : {};
                return asProviderModel({
                  ...row,
                  ...(Object.keys(map).length > 0 ? { thinking: map } : {}),
                }) ?? [];
              }),
            }),
      });
      seen.add(builtin.id);
    }

    // Stored credentials for a provider pi has no cached model catalog for.
    for (const id of Object.keys(auth)) {
      if (seen.has(id)) {
        continue;
      }
      providers.push({
        id,
        name: displayName(id),
        description: 'Stored sign-in',
        kind: 'builtin',
        connected: hasStored(auth, id),
        ...(hasStored(auth, id) ? { source: 'stored' as const } : {}),
      });
      seen.add(id);
    }

    // Custom endpoints, named and configured by the reader. A config block wins
    // over the engine catalog entry: it is the endpoint Morse must let the
    // reader edit, discover models on and delete models from.
    for (const [id, entry] of Object.entries(configured)) {
      const at = providers.findIndex((one) => one.id === id);
      if (at >= 0) {
        providers.splice(at, 1);
      }
      const one = isRecord(entry) ? entry : {};
      const apiKey = one['apiKey'];
      const hasKey = typeof apiKey === 'string' && apiKey.length > 0;
      const has = hasKey || hasStored(auth, id);
      providers.push({
        id,
        name: typeof one['name'] === 'string' && one['name'].length > 0 ? one['name'] : displayName(id),
        description: 'Custom endpoint',
        kind: 'custom',
        connected: has,
        ...(has ? { source: hasKey ? ('config' as const) : ('stored' as const) } : {}),
        ...(typeof one['baseUrl'] === 'string' ? { baseURL: one['baseUrl'] } : {}),
        ...(typeof one['api'] === 'string' ? { api: one['api'] } : {}),
        ...(Array.isArray(one['models'])
          ? { models: one['models'].flatMap((raw) => {
              const row = isRecord(raw) ? raw : {};
              const thinking = isRecord(row['thinkingLevelMap']) ? row['thinkingLevelMap'] : {};
              return asProviderModel({
                ...row,
                ...(Object.keys(thinking).length > 0 ? { thinking } : {}),
              }) ?? [];
            }) }
          : {}),
      });
      seen.add(id);
    }

    return { engine: 'pi', providers, issues: [] };
  }

  async connect(value: unknown): Promise<unknown> {
    const input = inputOf(value);
    const custom = input.baseURL !== undefined && input.baseURL.length > 0;
    if (!custom) {
      // A pasted key is exactly what pi's own `auth login --api-key` writes:
      // one entry in auth.json. Subscriptions still go through the TUI, where
      // pi owns the flow and any token refresh.
      const key = credentialKey(input.key);
      if (key === undefined) {
        return {
          ok: false,
          message: 'Paste an API key, or use `Sign in` for an account/subscription.',
        };
      }
      const auth = readObject(this.authPath);
      writePrivateJson(this.authPath, { ...auth, [input.providerId]: { type: 'api_key', key } });
      return { ok: true, message: `Connected ${input.name ?? input.providerId} for pi.` };
    }
    if (!/^https?:\/\//.test(input.baseURL ?? '')) {
      return { ok: false, message: 'The base URL must start with http:// or https://.' };
    }
    if ((input.models ?? []).length === 0) {
      return { ok: false, message: 'Add at least one model id for a custom provider.' };
    }
    const modelsFile = readObject(this.modelsPath);
    const existing = isRecord(modelsFile['providers']) ? modelsFile['providers'] : {};
    const kept = existing[input.providerId];
    const previous = isRecord(kept) ? kept : {};
    const entry = {
      ...previous,
      name: input.name ?? (typeof previous['name'] === 'string' ? previous['name'] : input.providerId),
      baseUrl: input.baseURL,
      api: input.api ?? (typeof previous['api'] === 'string' ? previous['api'] : DEFAULT_API),
      ...(input.key === undefined ? {} : { apiKey: input.key }),
      models: input.models!.map((model) => ({
        id: model.id,
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        ...(model.input === undefined ? {} : { input: model.input }),
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        ...(model.thinking === undefined ? {} : { thinkingLevelMap: model.thinking }),
      })),
    };
    writePrivateJson(this.modelsPath, { ...modelsFile, providers: { ...existing, [input.providerId]: entry } });
    return { ok: true, message: `Connected ${input.name ?? input.providerId} for pi.` };
  }

  /**
   * pi's own `auth login` handles every method pi supports — key, OAuth, device
   * flow — and writes the credential in the shape pi currently expects. The host
   * only checks the id is a safe argv token; pi decides whether it is a provider.
   */
  async loginCommand(value: unknown): Promise<unknown> {
    const data = isRecord(value) ? value : undefined;
    const providerId = typeof data?.['providerId'] === 'string' ? data['providerId'].trim() : '';
    if (!ID_PATTERN.test(providerId)) {
      return undefined;
    }
    const cli = resolvePiCli({ env: this.env });
    return { file: cli.command, args: [...cli.baseArgs, 'auth', 'login', providerId] };
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
      // A key is needed to list private endpoints; public ones answer without it.
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

    const auth = readObject(this.authPath);
    if (providerId in auth) {
      const next = { ...auth };
      delete next[providerId];
      writePrivateJson(this.authPath, next);
    }

    const modelsFile = readObject(this.modelsPath);
    const configured = isRecord(modelsFile['providers']) ? modelsFile['providers'] : {};
    const keptEntry = configured[providerId];
    const entry = isRecord(keptEntry) ? keptEntry : undefined;
    if (entry !== undefined && 'apiKey' in entry) {
      const next = { ...entry };
      delete next['apiKey'];
      writePrivateJson(this.modelsPath, {
        ...modelsFile,
        providers: { ...configured, [providerId]: next },
      });
    }
    return { ok: true, message: `Disconnected ${providerId} from pi.` };
  }
}

function hasStored(auth: Record<string, unknown>, id: string): boolean {
  const entry = auth[id];
  return isRecord(entry) && typeof entry['key'] === 'string' && entry['key'].length > 0;
}
