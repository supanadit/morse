import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type {
  BotCreateInput,
  BotProviderApi,
  BotProviderCredentialInput,
  BotProviderInput,
  ModelOption,
  ThinkingLevel,
} from '@morse/protocol';
import type { BotProviderModel } from '@morse/system';
import { MorseService } from '../../host/morse.service';

/** The wizard's steps, in the order the spec pins them. */
type Step = 'identity' | 'engine' | 'connect' | 'persona' | 'advanced' | 'review';

/** One OpenCode subagent the reader defined: a name and its own system prompt. */
interface SubagentRow {
  name: string;
  prompt: string;
}

/** One custom provider the reader is adding, with its models as they resolve. */
interface ProviderDraft {
  id: string;
  label: string;
  api: BotProviderApi;
  baseUrl: string;
  /** `'stored'` when a key is pasted; `'env'` when the reader named a variable. */
  credentialKind: 'stored' | 'env';
  apiKey: string;
  envName: string;
  /** Discovered (`/models`) plus hand-entered rows; what the bot's config gets. */
  models: BotProviderModel[];
}

/** A catalog provider the engine discovers itself: a preset chip and a key. */
interface KnownProviderPreset {
  /** The credential's engine-side provider name (`auth.json` key for OpenCode). */
  credential: string;
  label: string;
  /** Engines whose catalogs carry it; others hide the chip. */
  engines: readonly string[];
}

/**
 * Catalog providers per engine, as preset chips. The key goes into the bot's
 * own `auth.json` (OpenCode) / `auth.json` (pi) and the engine's probe lists
 * the models the key unlocks — no provider JSON needed for these.
 */
const KNOWN_PROVIDERS: KnownProviderPreset[] = [
  { credential: 'opencode', label: 'OpenCode (Zen & Go)', engines: ['opencode'] },
  { credential: 'anthropic', label: 'Anthropic', engines: ['opencode', 'pi'] },
  { credential: 'openai', label: 'OpenAI', engines: ['opencode', 'pi'] },
  { credential: 'google', label: 'Google', engines: ['opencode', 'pi'] },
  { credential: 'openrouter', label: 'OpenRouter', engines: ['opencode', 'pi'] },
  { credential: 'xai', label: 'xAI', engines: ['opencode', 'pi'] },
  { credential: 'deepseek', label: 'DeepSeek', engines: ['pi'] },
  { credential: 'groq', label: 'Groq', engines: ['pi'] },
  { credential: 'mistral', label: 'Mistral', engines: ['pi'] },
];

/** The API types a custom provider can speak, with the picker's wording. */
const PROVIDER_APIS: { value: BotProviderApi; label: string; hint: string }[] = [
  { value: 'openai-completions', label: 'OpenAI-compatible (chat completions)', hint: 'Most proxies, gateways, Ollama, vLLM, LM Studio' },
  { value: 'openai-responses', label: 'OpenAI Responses', hint: 'Endpoints speaking /responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages', hint: 'Anthropic-compatible gateways' },
  { value: 'google-generative-ai', label: 'Google Generative AI', hint: 'Gemini-style endpoints' },
];

/** pi's thinking levels, ordered from least to most. */
const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const STEP_LABELS: Record<Step, string> = {
  identity: 'Identity',
  engine: 'Engine',
  connect: 'Connect',
  persona: 'Persona',
  advanced: 'Advanced',
  review: 'Review',
};

/** A wizard-local request id for probes; the host echoes it whole. */
let wizardRequests = 0;
function nextRequestId(): string {
  wizardRequests += 1;
  return `wizard-${Date.now()}-${wizardRequests}`;
}

/** `A, B  C` → `['A', 'B', 'C']`: names, however the reader separated them. */
function parseEnvVars(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * The wizard that creates one isolated bot — a full page, not a modal.
 *
 * The order is the point: identity, engine, then Connect, where the reader adds
 * providers the way they would hand-edit the engine's config — a preset chip and
 * key for catalog providers, an "Add provider" form (wire protocol, base URL,
 * key) for everything else, with models discovered from the endpoint where it
 * can list them. The model picker searches everything Connect found. The
 * persona and Advanced steps follow; Review shows exactly what will be sent.
 */
@Component({
  selector: 'morse-bot-wizard',
  templateUrl: './bot-wizard.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './bot-wizard.css',
})
export class BotWizard {
  private readonly morse = inject(MorseService);

  protected readonly step = signal<Step>('identity');
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly avatar = signal('');
  protected readonly engineKind = signal('');
  /** Catalog provider keys: `{provider, apiKey}` rows, written to `auth.json`. */
  protected readonly credentials = signal<{ provider: string; apiKey: string }[]>([]);
  /** Custom providers, written into the engine's own provider config. */
  protected readonly providers = signal<ProviderDraft[]>([]);
  /** The custom-provider form, while it is open. */
  protected readonly addingProvider = signal(false);
  protected readonly draftId = signal('');
  protected readonly draftLabel = signal('');
  protected readonly draftApi = signal<BotProviderApi>('openai-completions');
  protected readonly draftBaseUrl = signal('');
  protected readonly draftKeyKind = signal<'stored' | 'env'>('stored');
  protected readonly draftApiKey = signal('');
  protected readonly draftEnvName = signal('');
  /** Manual model rows for the custom provider being added. */
  protected readonly draftModels = signal<BotProviderModel[]>([]);
  protected readonly draftModelId = signal('');
  /** True while a discovery request for the draft is in flight. */
  protected readonly draftProbing = signal(false);
  /** The discovery failure, said on the draft card instead of a toast. */
  protected readonly draftError = signal<string | null>(null);

  protected readonly envVars = signal('');
  protected readonly persona = signal('');
  protected readonly agentsMd = signal('');
  protected readonly subagents = signal<SubagentRow[]>([]);
  /** The model pick, keyed `provider/id`; empty until the reader chooses. */
  protected readonly modelKey = signal('');
  /** The thinking level picked; empty means "Engine default" — stores nothing. */
  protected readonly thinking = signal<ThinkingLevel | ''>('');
  /** The catalog probe this wizard is waiting on, keyed by request id. */
  private readonly probeRequestId = signal<string | null>(null);
  /** Engine + credentials + env the last probe ran with; a changed one re-probes. */
  private readonly probeSignature = signal<string | null>(null);
  /** The discovery in flight on the draft, keyed by its request id. */
  private readonly draftRequestId = signal<string | null>(null);
  /** The bot being created, while the roster has not named it yet. */
  protected readonly pending = signal<string | null>(null);
  protected readonly createError = signal<string | null>(null);
  private readonly knownBotsAtSubmit = signal<readonly string[]>([]);
  private readonly noticeAtSubmit = signal<{ level: string; text: string; at: number } | null>(null);
  /** The model search box, filtering everything Connect found. */
  protected readonly modelFilter = signal('');

  protected readonly engines = this.morse.engines;
  protected readonly thinkingLevels = THINKING_LEVELS;
  protected readonly labels = STEP_LABELS;
  protected readonly providerApis = PROVIDER_APIS;

  protected readonly steps = computed<Step[]>(() => [
    'identity',
    'engine',
    'connect',
    'persona',
    'advanced',
    'review',
  ]);

  /** The presets this engine's catalog carries, so the chips never lie. */
  protected readonly knownProviders = computed(() =>
    KNOWN_PROVIDERS.filter((preset) => preset.engines.includes(this.engineKind())),
  );

  /** The models the catalog probe answered with, for this wizard's request. */
  protected readonly probedModels = computed<ModelOption[]>(() => {
    const requestId = this.probeRequestId();
    return requestId === null ? [] : (this.morse.bot.models()[requestId] ?? []);
  });
  protected readonly probeReady = computed(() => {
    const requestId = this.probeRequestId();
    return requestId !== null && this.morse.bot.models()[requestId] !== undefined;
  });

  /**
   * Everything Connect can offer, one flat searchable list: catalog probe hits
   * first (their provider is the credential's), then each custom provider's
   * models keyed `<providerId>/<modelId>`.
   */
  protected readonly allModels = computed<ModelOption[]>(() => {
    const catalog = this.probedModels();
    const custom = this.providers().flatMap((provider) =>
      provider.models.map((model) => ({
        provider: provider.id,
        id: model.id,
        name: model.name ?? model.id,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      })),
    );
    return [...catalog, ...custom];
  });

  protected readonly visibleModels = computed<ModelOption[]>(() => {
    const filter = this.modelFilter().trim().toLowerCase();
    const models = this.allModels();
    if (filter.length === 0) {
      return models;
    }
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(filter) ||
        model.name.toLowerCase().includes(filter) ||
        model.provider.toLowerCase().includes(filter),
    );
  });

  protected readonly model = computed<ModelOption | undefined>(() =>
    this.allModels().find((candidate) => this.modelOptionKey(candidate) === this.modelKey()),
  );

  /** The custom-provider drafts, as the create will send them. */
  protected readonly collectedProviders = computed<BotProviderInput[]>(() =>
    this.providers()
      .filter((draft) => draft.id.trim().length > 0 && draft.models.length > 0)
      .map((draft) => ({
        id: draft.id.trim(),
        label: draft.label.trim() || draft.id.trim(),
        api: draft.api,
        ...(draft.baseUrl.trim().length > 0 ? { baseUrl: draft.baseUrl.trim() } : {}),
        credential:
          draft.credentialKind === 'stored'
            ? ({ kind: 'stored', apiKey: draft.apiKey } satisfies BotProviderCredentialInput)
            : ({ kind: 'env', name: draft.envName.trim() } satisfies BotProviderCredentialInput),
        models: draft.models.map((model) => ({ ...model })),
      })),
  );

  protected readonly collectedCredentials = computed(() =>
    this.credentials()
      .filter((row) => row.provider.trim().length > 0 && row.apiKey.trim().length > 0)
      .map((row) => ({ provider: row.provider.trim(), apiKey: row.apiKey.trim() })),
  );

  protected readonly namedSubagents = computed<SubagentRow[]>(() =>
    this.subagents()
      .filter((row) => row.name.trim().length > 0)
      .map((row) => ({ name: row.name.trim(), prompt: row.prompt.trim() })),
  );

  protected readonly subagentNames = computed(() =>
    this.namedSubagents()
      .map((row) => row.name)
      .join(', '),
  );

  constructor() {
    // `bot/create` has no per-request echo: the roster is the only confirmation.
    // The name must have been absent at submit — a duplicate the host refused
    // appears in every roster push and is not this wizard's bot.
    effect(() => {
      const roster = this.morse.bot.roster();
      const pending = this.pending();
      if (roster === null || pending === null) {
        return;
      }
      const handle = pending.toLowerCase();
      const before = this.knownBotsAtSubmit();
      const created = roster.bots.some(
        (bot) => bot.name.toLowerCase() === handle && !before.includes(bot.name.toLowerCase()),
      );
      if (!created) {
        return;
      }
      untracked(() => {
        this.pending.set(null);
        this.morse.ui.wizardOpen.set(false);
      });
    });
    // A create can also fail. The host says so as a notice; any notice after
    // submit ends the wait and is shown in place.
    effect(() => {
      const notice = this.morse.lastNotice();
      const pending = this.pending();
      if (pending === null || notice === undefined || notice === this.noticeAtSubmit()) {
        return;
      }
      untracked(() => {
        this.pending.set(null);
        this.createError.set(notice.text);
      });
    });
    // A discovery answer for the draft's request fills the draft's model rows.
    effect(() => {
      const requestId = this.draftRequestId();
      if (requestId === null) {
        return;
      }
      const answer = this.morse.bot.models()[requestId];
      if (answer === undefined) {
        return;
      }
      untracked(() => {
        this.draftRequestId.set(null);
        this.draftProbing.set(false);
        this.draftModels.set(
          answer.map((model) => ({
            id: model.id,
            ...(model.name === undefined ? {} : { name: model.name }),
          })),
        );
        if (answer.length === 0) {
          this.draftError.set('The endpoint listed no models.');
        }
      });
    });
    // A discovery can also fail (refused key, unreachable endpoint). The host
    // says so as a notice; a new notice while a discovery is in flight is that
    // failure, shown on the draft card.
    effect(() => {
      const notice = this.morse.lastNotice();
      const waiting = this.draftProbing();
      if (!waiting || notice === undefined) {
        return;
      }
      untracked(() => {
        this.draftRequestId.set(null);
        this.draftProbing.set(false);
        this.draftError.set(notice.text);
      });
    });
  }

  protected setText(
    target:
      | 'name'
      | 'description'
      | 'avatar'
      | 'persona'
      | 'agentsMd'
      | 'envVars'
      | 'modelFilter',
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    switch (target) {
      case 'name':
        this.name.set(value);
        return;
      case 'description':
        this.description.set(value);
        return;
      case 'avatar':
        this.avatar.set(value);
        return;
      case 'persona':
        this.persona.set(value);
        return;
      case 'agentsMd':
        this.agentsMd.set(value);
        return;
      case 'envVars':
        this.envVars.set(value);
        return;
      case 'modelFilter':
        this.modelFilter.set(value);
        return;
    }
  }

  protected chooseEngine(kind: string): void {
    if (kind !== this.engineKind()) {
      this.engineKind.set(kind);
      this.credentials.set([]);
      this.providers.set([]);
      this.modelKey.set('');
    }
  }

  protected choosePreset(credential: string): void {
    const rows = this.credentials();
    if (rows.some((row) => row.provider === credential)) {
      this.credentials.update((current) => current.filter((row) => row.provider !== credential));
      return;
    }
    this.credentials.update((current) => [...current, { provider: credential, apiKey: '' }]);
  }

  protected hasPreset(credential: string): boolean {
    return this.credentials().some((row) => row.provider === credential);
  }

  protected setPresetKey(credential: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.credentials.update((rows) =>
      rows.map((row) => (row.provider === credential ? { ...row, apiKey: value } : row)),
    );
  }

  protected presetKey(credential: string): string {
    return this.credentials().find((row) => row.provider === credential)?.apiKey ?? '';
  }

  protected openAddProvider(): void {
    this.addingProvider.set(true);
    this.draftId.set('');
    this.draftLabel.set('');
    this.draftApi.set('openai-completions');
    this.draftBaseUrl.set('');
    this.draftKeyKind.set('stored');
    this.draftApiKey.set('');
    this.draftEnvName.set('');
    this.draftModels.set([]);
    this.draftModelId.set('');
    this.draftError.set(null);
    this.draftProbing.set(false);
    this.draftRequestId.set(null);
  }

  protected cancelAddProvider(): void {
    this.addingProvider.set(false);
  }

  protected setDraft(
    target: 'id' | 'label' | 'baseUrl' | 'apiKey' | 'envName' | 'draftModelId',
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement).value;
    switch (target) {
      case 'id':
        this.draftId.set(value);
        return;
      case 'label':
        this.draftLabel.set(value);
        return;
      case 'baseUrl':
        this.draftBaseUrl.set(value);
        return;
      case 'apiKey':
        this.draftApiKey.set(value);
        return;
      case 'envName':
        this.draftEnvName.set(value);
        return;
      case 'draftModelId':
        this.draftModelId.set(value);
        return;
    }
  }

  protected setDraftApi(event: Event): void {
    this.draftApi.set((event.target as HTMLSelectElement).value as BotProviderApi);
  }

  protected setDraftKeyKind(kind: 'stored' | 'env'): void {
    this.draftKeyKind.set(kind);
  }

  /** Asks the endpoint what it serves; the effects above file the answer. */
  protected discoverDraft(): void {
    const baseUrl = this.draftBaseUrl().trim();
    if (baseUrl.length === 0 || this.draftRequestId() !== null) {
      return;
    }
    const requestId = nextRequestId();
    this.draftRequestId.set(requestId);
    this.draftProbing.set(true);
    this.draftError.set(null);
    void this.morse.discoverModels(
      baseUrl,
      this.draftKeyKind() === 'stored'
        ? { kind: 'stored', apiKey: this.draftApiKey() }
        : { kind: 'env', name: this.draftEnvName().trim() },
      requestId,
    );
  }

  protected addDraftModel(): void {
    const id = this.draftModelId().trim();
    if (id.length === 0) {
      return;
    }
    this.draftModels.update((rows) => [...rows, { id }]);
    this.draftModelId.set('');
  }

  protected removeDraftModel(index: number): void {
    this.draftModels.update((rows) => rows.filter((_, at) => at !== index));
  }

  protected saveDraft(): void {
    const id = this.draftId().trim();
    if (id.length === 0) {
      return;
    }
    if (this.providers().some((row) => row.id === id)) {
      this.draftError.set(`A provider named "${id}" is already in this bot.`);
      return;
    }
    this.providers.update((rows) => [
      ...rows,
      {
        id,
        label: this.draftLabel().trim() || id,
        api: this.draftApi(),
        baseUrl: this.draftBaseUrl().trim(),
        credentialKind: this.draftKeyKind(),
        apiKey: this.draftApiKey(),
        envName: this.draftEnvName().trim(),
        models: this.draftModels(),
      },
    ]);
    this.addingProvider.set(false);
  }

  protected removeProvider(id: string): void {
    this.providers.update((rows) => rows.filter((row) => row.id !== id));
  }

  protected pickModel(key: string): void {
    this.modelKey.set(key);
  }

  protected pickThinking(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.thinking.set(value === '' ? '' : (value as ThinkingLevel));
  }

  /** A model's stable key in the chooser, unique across providers. */
  protected modelOptionKey(model: ModelOption): string {
    return `${model.provider}/${model.id}`;
  }

  protected addSubagent(): void {
    this.subagents.update((rows) => [...rows, { name: '', prompt: '' }]);
  }

  protected removeSubagent(index: number): void {
    this.subagents.update((rows) => rows.filter((_, at) => at !== index));
  }

  protected setSubagent(index: number, field: 'name' | 'prompt', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.subagents.update((rows) =>
      rows.map((row, at) => (at === index ? { ...row, [field]: value } : row)),
    );
  }

  protected canAdvance(): boolean {
    switch (this.step()) {
      case 'identity':
        return this.name().trim().length > 0;
      case 'engine':
        return this.engines().some((engine) => engine.kind === this.engineKind());
      case 'connect':
        // A model from any source, or an explicit choice to run on the engine
        // default (no key at all is also allowed: e.g. free OpenCode models).
        return true;
      case 'persona':
      case 'advanced':
        return true;
      case 'review':
        return false;
    }
  }

  protected next(): void {
    if (!this.canAdvance()) {
      return;
    }
    const steps = this.steps();
    const following = steps[steps.indexOf(this.step()) + 1];
    if (following === undefined) {
      return;
    }
    // Leaving Connect probes the catalog providers: the engine lists what the
    // pasted keys unlock, under this wizard's request id. Re-entering and
    // leaving again with the same answers must not re-probe: a new request id
    // would replace the list the reader is picking from.
    if (this.step() === 'connect' && this.collectedCredentials().length > 0) {
      const signature = JSON.stringify([
        this.engineKind(),
        this.collectedCredentials(),
        parseEnvVars(this.envVars()),
      ]);
      if (signature !== this.probeSignature()) {
        const requestId = nextRequestId();
        this.probeRequestId.set(requestId);
        this.probeSignature.set(signature);
        this.morse.probeModels(
          this.engineKind(),
          parseEnvVars(this.envVars()),
          this.collectedCredentials(),
          requestId,
        );
      }
    }
    this.step.set(following);
  }

  protected back(): void {
    const steps = this.steps();
    const index = steps.indexOf(this.step());
    if (index > 0) {
      this.step.set(steps[index - 1] as Step);
    }
  }

  protected cancel(): void {
    this.morse.ui.wizardOpen.set(false);
  }

  protected canSubmit(): boolean {
    return this.step() === 'review' && this.pending() === null;
  }

  protected submit(): void {
    if (!this.canSubmit()) {
      return;
    }
    const requestId = this.probeRequestId() ?? nextRequestId();
    const name = this.name().trim();
    const agentsMd = this.agentsMd().trim();
    const subagents = this.namedSubagents();
    const providers = this.collectedProviders();
    const model = this.model();
    const thinking = this.thinking();
    const input: BotCreateInput & { requestId: string } = {
      name,
      description: this.description().trim(),
      ...(this.avatar().trim().length > 0 ? { avatar: this.avatar().trim() } : {}),
      engineKind: this.engineKind(),
      credentials: this.collectedCredentials(),
      envVars: parseEnvVars(this.envVars()),
      persona: this.persona(),
      ...(model === undefined ? {} : { model }),
      ...(thinking === '' ? {} : { thinkingLevel: thinking }),
      ...(agentsMd.length > 0 ? { agentsMd } : {}),
      ...(subagents.length > 0 ? { subagents } : {}),
      ...(providers.length > 0 ? { providers } : {}),
      requestId,
    };
    this.knownBotsAtSubmit.set(
      (this.morse.bot.roster()?.bots ?? []).map((bot) => bot.name.toLowerCase()),
    );
    this.noticeAtSubmit.set(this.morse.lastNotice() ?? null);
    this.createError.set(null);
    this.morse.createBot(input);
    this.morse.listBots();
    this.pending.set(name);
  }
}
