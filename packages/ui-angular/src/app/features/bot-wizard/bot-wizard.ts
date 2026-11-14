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
  BotConfig,
  BotCreateInput,
  BotMcpServerInput,
  BotProviderApi,
  BotProviderConfig,
  BotProviderCredentialInput,
  BotProviderInput,
  ModelInput,
  ModelOption,
  ThinkingLevel,
} from '@morse/protocol';
import type { BotProviderModel } from '@morse/system';
import { MorseService } from '../../host/morse.service';
import { BotMcpStep } from './bot-mcp-step';

/** The wizard's steps, in the order the spec pins them. */
type Step = 'identity' | 'engine' | 'connect' | 'persona' | 'mcp' | 'advanced' | 'review';

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
  mcp: 'MCP',
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
/**
 * The built-in tools each engine can give a bot, in that engine's own names.
 *
 * `pi` is a coding harness: read, bash, edit and write, and no web tool at all —
 * reaching the internet means an MCP server or an extension, not a built-in.
 * OpenCode ships a wider set, web tools included. The wizard offers exactly what
 * the chosen engine can do, rather than one abstraction over both.
 */
const ENGINE_TOOLS: Record<string, { name: string; hint?: string }[]> = {
  pi: [
    { name: 'read', hint: 'read files' },
    { name: 'bash', hint: 'run shell commands' },
    { name: 'edit', hint: 'change files' },
    { name: 'write', hint: 'create files' },
  ],
  opencode: [
    { name: 'read' },
    { name: 'edit' },
    { name: 'glob' },
    { name: 'grep' },
    { name: 'list' },
    { name: 'bash' },
    { name: 'task' },
    { name: 'webfetch', hint: 'fetch a URL' },
    { name: 'websearch', hint: 'search the web' },
    { name: 'todowrite' },
  ],
};

/** What a new bot starts with, per engine: the engine's own defaults, not "none". */
const DEFAULT_TOOLS: Record<string, string[]> = {
  pi: ['read', 'bash', 'edit', 'write'],
  opencode: ['read', 'edit', 'glob', 'grep', 'list', 'bash'],
};

/** The username rules, mirrored from the host so the form can say what is wrong. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * A name turned into a candidate username: lowercase, ASCII-ish, spaces and
 * punctuation folded to dashes. Only a starting point — the reader may edit it,
 * and the host validates whatever is sent.
 */
function usernameFrom(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

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
 * persona, the optional MCP servers, and Advanced follow; Review shows exactly
 * what will be sent.
 */
@Component({
  selector: 'morse-bot-wizard',
  templateUrl: './bot-wizard.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BotMcpStep],
  styleUrl: './bot-wizard.css',
})
export class BotWizard {
  private readonly morse = inject(MorseService);

  protected readonly step = signal<Step>('identity');
  protected readonly name = signal('');
  /**
   * The bot's handle: what names its directory, its DM and its `@mention`. It is
   * derived from the name until the reader edits it, which is why the derivation
   * flag exists rather than a one-off write.
   */
  protected readonly username = signal('');
  private readonly usernameEdited = signal(false);
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
  /**
   * The providers Edit bot read out of the engine's own config, with the model
   * fields a reader can correct. Kept apart from `providers` (the create flow's
   * drafts) because these carry no credential: an edit rewrites the fields around
   * the key the engine already stores.
   */
  protected readonly engineProviders = signal<BotProviderConfig[]>([]);
  protected readonly draftModelId = signal('');
  /** True while a discovery request for the draft is in flight. */
  protected readonly draftProbing = signal(false);
  /** The discovery failure, said on the draft card instead of a toast. */
  protected readonly draftError = signal<string | null>(null);

  protected readonly envVars = signal('');
  /**
   * The built-in tools this bot may use, in its engine's own names. Empty means
   * none — a chat-only bot — and that is also what keeps a provider that emulates
   * tools by telling the model to "reply in JSON only" from doing it.
   */
  protected readonly tools = signal<string[]>([...DEFAULT_TOOLS['pi']]);
  /**
   * Whether the reader changed the tool selection. Until they do, no `tools` is
   * sent at all and the bot's settings stay byte-for-byte what a default pi
   * install has: pi's own `defaultTools` (`read`, `bash`, `edit`, `write`) is
   * resolved by pi itself, not pinned by Morse.
   */
  private readonly toolsEdited = signal(false);
  protected readonly persona = signal('');
  protected readonly agentsMd = signal('');
  protected readonly subagents = signal<SubagentRow[]>([]);
  /** The MCP servers this bot carries; written into its own engine config. */
  protected readonly mcpServers = signal<BotMcpServerInput[]>([]);
  /**
   * Whether the edited config carried an MCP list at all. A config that never
   * mentioned servers must not write one back — that is what keeps an edit from
   * touching the engine's own file.
   */
  private readonly mcpLoaded = signal(false);
  /** The model pick, keyed `provider/id`; empty until the reader chooses. */
  protected readonly modelKey = signal('');
  /** The thinking level picked; empty means "Engine default" — stores nothing. */
  protected readonly thinking = signal<ThinkingLevel | ''>('');
  /** The catalog probe this wizard is waiting on, keyed by request id. */
  private readonly probeRequestId = signal<string | null>(null);
  /** Engine + credentials + env the last probe ran with; a changed one re-probes. */
  private readonly probeSignature = signal<string | null>(null);
  /** Why the catalog probe failed, said on the Model section instead of nowhere. */
  private readonly catalogError = signal<string | null>(null);
  /** The notice the last catalog probe started with, so only a new one is a failure. */
  private probeNotice: { level: string; text: string; at: number } | undefined;
  /** The discovery in flight on the draft, keyed by its request id. */
  private readonly draftRequestId = signal<string | null>(null);
  /** The bot being created, while the roster has not named it yet. */
  protected readonly pending = signal<string | null>(null);
  protected readonly createError = signal<string | null>(null);
  private readonly knownBotsAtSubmit = signal<readonly string[]>([]);
  /** The roster as it stood at submit, so an edit knows when its save landed. */
  private readonly rosterAtSubmit = signal<{ bots: unknown[] } | null>(null);
  private readonly noticeAtSubmit = signal<{ level: string; text: string; at: number } | null>(null);
  /** The model search box, filtering everything Connect found. */
  protected readonly modelFilter = signal('');

  protected readonly engines = this.morse.engines;
  protected readonly thinkingLevels = THINKING_LEVELS;
  protected readonly labels = STEP_LABELS;
  protected readonly providerApis = PROVIDER_APIS;

  /** Why the username is unusable, or empty when it is fine. */
  protected readonly usernameError = computed(() => {
    const value = this.username();
    if (value.length === 0) {
      return 'A username is needed: it names the bot\'s directory and its @mention.';
    }
    if (!USERNAME_PATTERN.test(value)) {
      return 'Use lowercase letters, digits, dashes and underscores, starting with a letter or digit (32 max).';
    }
    if (!this.editing() && this.takenUsernames().includes(value)) {
      return 'That username is taken.';
    }
    return '';
  });

  /** The usernames the roster already holds, so a clash is caught before sending. */
  private readonly takenUsernames = computed(() =>
    (this.morse.bot.roster()?.bots ?? []).map((bot) => bot.username),
  );

  /** The bot being edited, or `null` while creating a new one. */
  protected readonly editTarget = this.morse.ui.wizardTarget;
  protected readonly editing = computed(() => this.editTarget() !== null);

  protected readonly steps = computed<Step[]>(() => [
    'identity',
    'engine',
    'connect',
    'persona',
    'mcp',
    'advanced',
    'review',
  ]);

  /**
   * The steps the reader has stood on. A tick only shows on one of these, so an
   * optional step never looks answered before it has been seen.
   */
  private readonly reached = signal<ReadonlySet<Step>>(new Set<Step>(['identity']));

  /**
   * A step is done the moment its own form is satisfied — no Next needed. The
   * tick is derived, never latched: deselect the engine or clear the name and
   * that step's tick goes away by itself.
   */
  protected isDone(entry: Step): boolean {
    return entry !== 'review' && this.reached().has(entry) && this.isStepComplete(entry);
  }

  /**
   * Whether the rail may jump to this step: it, and everything before it, must
   * already be satisfied — so a jump never skips a requirement, in either
   * direction.
   */
  protected canGoTo(entry: Step): boolean {
    if (entry === this.step()) {
      return false;
    }
    const steps = this.steps();
    const index = steps.indexOf(entry);
    // Review has nothing of its own to satisfy, so only the steps before it count.
    const required = entry === 'review' ? steps.slice(0, index) : steps.slice(0, index + 1);
    return required.every((one) => this.isStepComplete(one));
  }

  /** Jumps anywhere already satisfied, keeping every answer. */
  protected goToStep(entry: Step): void {
    if (this.canGoTo(entry)) {
      this.step.set(entry);
    }
  }

  /**
   * One step's own answers, independent of where the reader is standing. Only
   * what the step needs to be considered configured: a name, an engine, a model,
   * a persona. Advanced carries nothing required.
   */
  private isStepComplete(entry: Step): boolean {
    switch (entry) {
      case 'identity':
        return this.name().trim().length > 0 && this.usernameError().length === 0;
      case 'engine':
        return this.engines().some((engine) => engine.kind === this.engineKind());
      case 'connect':
        // A model is not optional: the bot runs on the one chosen here, so an
        // empty list leaves Next refused until a key or a provider supplies one.
        return this.model() !== undefined;
      case 'persona':
        return this.persona().trim().length > 0;
      case 'mcp':
        // Optional: a bot with no servers is the normal case, so this never
        // blocks Next or a jump to a later step.
        return true;
      case 'advanced':
        return true;
      case 'review':
        return false;
    }
  }

  /** The tools this engine can offer, so the form never invents one. */
  protected readonly engineTools = computed(() => ENGINE_TOOLS[this.engineKind()] ?? []);

  /** Whether one tool is switched on for this bot. */
  protected hasTool(name: string): boolean {
    return this.tools().includes(name);
  }

  protected toggleTool(name: string, on: boolean): void {
    this.toolsEdited.set(true);
    this.tools.update((current) =>
      on ? [...current.filter((one) => one !== name), name] : current.filter((one) => one !== name),
    );
  }

  /** The tools to send: nothing when the reader left the engine's default alone. */
  private toolsToSend(): string[] | undefined {
    return this.toolsEdited() ? [...this.tools()] : undefined;
  }

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

  /** The models each source offers, one flat searchable list. */
  protected readonly pinnedModel = signal<ModelOption | undefined>(undefined);

  /**
   * Everything Connect can offer, one flat searchable list: catalog probe hits
   * first (their provider is the credential's), then each custom provider's
   * models keyed `<providerId>/<modelId>`, then the model this bot already runs
   * on when the catalog did not list it (an edited bot whose keys were never
   * handed back, so the probe cannot see the paid catalog) — otherwise the saved
   * choice would vanish from the list and the step would read as unsatisfied.
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
    const models = [...catalog, ...custom];
    const pinned = this.pinnedModel();
    if (pinned === undefined) {
      return models;
    }
    const key = this.modelOptionKey(pinned);
    return models.some((candidate) => this.modelOptionKey(candidate) === key)
      ? models
      : [...models, pinned];
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

  /** Why Next is refused on Connect, in the reader's words; empty once it may pass. */
  protected readonly modelBlocker = computed(() => {
    if (this.model() !== undefined || this.catalogError() !== null) {
      return '';
    }
    if (!this.probeReady() && this.providers().length === 0) {
      return "Loading this engine's catalog…";
    }
    if (this.allModels().length === 0) {
      return 'This engine listed no models. Paste a key above or add a custom provider with at least one model — a bot must be given a model to run on.';
    }
    return 'Pick a model to continue.';
  });

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
    // appears in every roster push and is not this wizard's bot. An edit is
    // confirmed by any roster push after the save, since its name never changes.
    effect(() => {
      const roster = this.morse.bot.roster();
      const pending = this.pending();
      if (roster === null || pending === null) {
        return;
      }
      if (this.editing()) {
        if (roster === this.rosterAtSubmit()) {
          return;
        }
        untracked(() => {
          this.pending.set(null);
          this.close();
        });
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
        this.close();
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
            // Discovery's answer is a starting point, not a verdict: whatever it
            // found is filled in, and every field stays editable below because a
            // listing often says nothing (or the wrong thing) about a model.
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
            ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
            ...(model.input === undefined ? {} : { input: model.input }),
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
    // Arriving at Connect asks the catalog immediately: the model list is the
    // step's whole point, so it is already there when the step opens instead of
    // appearing only after walking past it and coming back.
    effect(() => {
      if (this.step() !== 'connect') {
        return;
      }
      untracked(() => this.probeCatalog());
    });
    // A catalog probe can fail too (a refused key, an unreachable engine). The
    // host says so as a notice; a new one while the answer is still missing is
    // that failure, said on the Model section instead of nowhere.
    effect(() => {
      const notice = this.morse.lastNotice();
      const requestId = this.probeRequestId();
      if (requestId === null || notice === undefined || notice === this.probeNotice) {
        return;
      }
      if (this.morse.bot.models()[requestId] !== undefined) {
        return;
      }
      untracked(() => this.catalogError.set(notice.text));
    });
    // Editing reuses this wizard, so the bot's own record fills it in. Asking is
    // idempotent: the answer arrives as `bot/config`, and the same effect settles
    // once it is held.
    effect(() => {
      const target = this.editTarget();
      if (target === null) {
        return;
      }
      const config = this.morse.bot.configs()[target];
      if (config === undefined) {
        untracked(() => this.morse.inspectBot(target));
        return;
      }
      untracked(() => this.fillFromConfig(config));
    });
    // A step counts as seen the moment it opens, so its tick is already able to
    // appear while the reader is standing on it — no Next required.
    effect(() => {
      const entry = this.step();
      untracked(() => {
        if (this.reached().has(entry)) {
          return;
        }
        this.reached.update((current) => new Set([...current, entry]));
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
        // Until the reader edits the handle, it follows the name they type.
        if (!this.usernameEdited() && !this.editing()) {
          this.username.set(usernameFrom(value));
        }
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

  /** The reader took the handle over: stop deriving it from the name. */
  protected setUsername(event: Event): void {
    this.usernameEdited.set(true);
    this.username.set((event.target as HTMLInputElement).value.trim().toLowerCase());
  }

  protected chooseEngine(kind: string): void {
    if (kind !== this.engineKind()) {
      this.engineKind.set(kind);
      this.credentials.set([]);
      this.providers.set([]);
      this.modelKey.set('');
      // Servers are engine-specific config (`mcp.json` vs `opencode.json`), so a
      // list collected for another engine would be written in the wrong shape.
      this.mcpServers.set([]);
      this.mcpLoaded.set(false);
      // A new engine offers different tools: start from its own defaults rather
      // than carrying names it does not have.
      this.tools.set([...(DEFAULT_TOOLS[kind] ?? [])]);
      this.toolsEdited.set(false);
    }
  }

  protected choosePreset(credential: string): void {
    const rows = this.credentials();
    if (rows.some((row) => row.provider === credential)) {
      this.credentials.update((current) => current.filter((row) => row.provider !== credential));
      this.refreshCatalog();
      return;
    }
    this.credentials.update((current) => [...current, { provider: credential, apiKey: '' }]);
    this.refreshCatalog();
  }

  /**
   * Re-probes once a key is committed (blur or Enter), not on every keystroke —
   * the catalog request spawns an engine process, so one per character would be
   * both slow and pointless.
   */
  protected refreshCatalog(): void {
    if (this.step() === 'connect') {
      this.probeCatalog();
    }
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

  /**
   * One model field the reader corrected: its context window or its output cap.
   * An empty box clears the field, which writes nothing and lets the engine apply
   * its own default — the honest answer when nobody knows the number.
   */
  protected setModelField(index: number, field: 'contextWindow' | 'maxTokens', event: Event): void {
    const raw = (event.target as HTMLInputElement).value.trim();
    const value = raw === '' ? undefined : Number(raw);
    const next = value === undefined || !Number.isFinite(value) || value <= 0 ? undefined : Math.floor(value);
    this.draftModels.update((rows) =>
      rows.map((row, at) => {
        if (at !== index) {
          return row;
        }
        const { [field]: _dropped, ...rest } = row;
        return next === undefined ? rest : { ...rest, [field]: next };
      }),
    );
  }

  /**
   * Whether this model takes images. A three-state toggle on purpose: unknown
   * (absent) means "the engine decides", which is different from a model that says
   * it takes text only — and a vision model behind a custom provider has to say
   * `image` explicitly, because pi's own default is text-only.
   */
  protected toggleModelImage(index: number): void {
    this.draftModels.update((rows) =>
      rows.map((row, at) => {
        if (at !== index) {
          return row;
        }
        const input = row.input ?? [];
        if (input.includes('image')) {
          return { ...row, input: input.filter((one) => one !== 'image') };
        }
        return { ...row, input: [...new Set<ModelInput>([...input, 'text', 'image'])] };
      }),
    );
  }

  /** A model row's image capability as the toggle shows it. */
  protected modelTakesImages(model: BotProviderModel): boolean {
    return model.input?.includes('image') === true;
  }

  /** The same field handlers for a provider read back from the engine's config. */
  protected setKnownModelField(
    providerId: string,
    modelId: string,
    field: 'contextWindow' | 'maxTokens',
    event: Event,
  ): void {
    const raw = (event.target as HTMLInputElement).value.trim();
    const parsed = raw === '' ? undefined : Number(raw);
    const next = parsed === undefined || !Number.isFinite(parsed) || parsed <= 0 ? undefined : Math.floor(parsed);
    this.engineProviders.update((rows) =>
      rows.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              models: provider.models.map((model) => {
                if (model.id !== modelId) {
                  return model;
                }
                const { [field]: _dropped, ...rest } = model;
                return next === undefined ? rest : { ...rest, [field]: next };
              }),
            }
          : provider,
      ),
    );
  }

  protected toggleKnownModelImage(providerId: string, modelId: string): void {
    this.engineProviders.update((rows) =>
      rows.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              models: provider.models.map((model) => {
                if (model.id !== modelId) {
                  return model;
                }
                const input = model.input ?? [];
                return input.includes('image')
                  ? { ...model, input: input.filter((one) => one !== 'image') }
                  : { ...model, input: [...new Set<ModelInput>([...input, 'text', 'image'])] };
              }),
            }
          : provider,
      ),
    );
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
    return this.isStepComplete(this.step());
  }

  /**
   * Asks the engine's catalog what the current keys unlock, under a fresh
   * request id. Called on arriving at Connect — the reader must never have to
   * walk past the step and come back to see the list — and again whenever the
   * keys change underneath it.
   */
  protected probeCatalog(force = false): void {
    const signature = JSON.stringify([
      this.engineKind(),
      this.collectedCredentials(),
      parseEnvVars(this.envVars()),
    ]);
    if (!force && signature === this.probeSignature()) {
      return;
    }
    const requestId = nextRequestId();
    this.probeRequestId.set(requestId);
    this.probeSignature.set(signature);
    this.probeNotice = this.morse.lastNotice();
    this.catalogError.set(null);
    this.morse.probeModels(
      this.engineKind(),
      parseEnvVars(this.envVars()),
      this.collectedCredentials(),
      requestId,
    );
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
    this.close();
  }

  /** Closing always forgets which bot was being edited, so the next open is clean. */
  private close(): void {
    this.morse.ui.wizardTarget.set(null);
    this.morse.ui.wizardOpen.set(false);
  }

  /**
   * Fills the form from the bot's own record. Every step counts as reached and
   * satisfied, so the rail reads as a checklist of what is already configured and
   * any step can be jumped to directly.
   */
  private fillFromConfig(config: BotConfig): void {
    this.username.set(config.username);
    this.name.set(config.name);
    this.description.set(config.description);
    this.avatar.set(config.avatar ?? '');
    this.engineKind.set(config.engineKind);
    // Keys are the engine's, never read back: the preset chips start blank, and
    // the catalog probe therefore answers with what needs no key.
    this.credentials.set([]);
    this.envVars.set(config.envVars.join(', '));
    this.persona.set(config.persona);
    this.agentsMd.set(config.agentsMd ?? '');
    this.subagents.set((config.subagents ?? []).map((row) => ({ ...row })));
    // A server list is read back whole, and `mcpLoaded` remembers whether the
    // config had one: an absent list is "do not touch the engine's file".
    this.mcpServers.set((config.mcpServers ?? []).map((server) => ({ ...server })));
    this.mcpLoaded.set(config.mcpServers !== undefined);
    this.engineProviders.set(
      (config.providers ?? []).map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model })),
      })),
    );
    this.thinking.set(config.thinkingLevel ?? '');
    this.tools.set([...(config.tools ?? DEFAULT_TOOLS[config.engineKind] ?? [])]);
    this.toolsEdited.set(config.tools !== undefined);
    this.pinnedModel.set(config.model);
    this.modelKey.set(config.model === undefined ? '' : this.modelOptionKey(config.model));
    this.reached.set(new Set(this.steps()));
  }

  protected canSubmit(): boolean {
    return this.step() === 'review' && this.pending() === null;
  }

  protected submit(): void {
    if (!this.canSubmit()) {
      return;
    }
    const target = this.editTarget();
    this.noticeAtSubmit.set(this.morse.lastNotice() ?? null);
    this.createError.set(null);
    if (target !== null) {
      this.rosterAtSubmit.set(this.morse.bot.roster());
      const credentials = this.collectedCredentials();
      const agentsMd = this.agentsMd().trim();
      const subagents = this.namedSubagents();
      const model = this.model();
      const thinking = this.thinking();
      this.morse.updateBot({
        username: target,
        name: this.name().trim(),
        description: this.description().trim(),
        ...(this.avatar().trim().length > 0 ? { avatar: this.avatar().trim() } : {}),
        persona: this.persona(),
        ...(this.toolsToSend() === undefined ? {} : { tools: this.toolsToSend() as string[] }),
        ...(model === undefined ? {} : { model }),
        ...(thinking === '' ? {} : { thinkingLevel: thinking }),
        envVars: parseEnvVars(this.envVars()),
        agentsMd,
        subagents,
        // Only a pasted key replaces the stored ones; an untouched form keeps them.
        ...(credentials.length === 0 ? {} : { credentials }),
        // Model capabilities the reader corrected, written back into the engine's
        // own provider config around the credential already there.
        ...(this.engineProviders().length === 0 ? {} : { providers: this.engineProviders() }),
        // A config that named servers is written back whole (even emptied); one
        // that named none leaves the engine's file alone.
        ...(this.mcpLoaded() || this.mcpServers().length > 0
          ? { mcpServers: this.mcpServers() }
          : {}),
      });
      this.pending.set(target);
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
      username: this.username(),
      name,
      description: this.description().trim(),
      ...(this.avatar().trim().length > 0 ? { avatar: this.avatar().trim() } : {}),
      engineKind: this.engineKind(),
      credentials: this.collectedCredentials(),
      envVars: parseEnvVars(this.envVars()),
      persona: this.persona(),
      ...(this.toolsToSend() === undefined ? {} : { tools: this.toolsToSend() as string[] }),
      ...(model === undefined ? {} : { model }),
      ...(thinking === '' ? {} : { thinkingLevel: thinking }),
      ...(agentsMd.length > 0 ? { agentsMd } : {}),
      ...(subagents.length > 0 ? { subagents } : {}),
      ...(providers.length > 0 ? { providers } : {}),
      ...(this.mcpLoaded() || this.mcpServers().length > 0
        ? { mcpServers: this.mcpServers() }
        : {}),
      requestId,
    };
    this.knownBotsAtSubmit.set(
      (this.morse.bot.roster()?.bots ?? []).map((bot) => bot.name.toLowerCase()),
    );
    this.createError.set(null);
    this.morse.createBot(input);
    this.morse.listBots();
    this.pending.set(name);
  }
}
