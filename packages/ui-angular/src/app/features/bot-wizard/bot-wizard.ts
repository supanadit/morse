import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
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
  ModelOption,
  ProviderInfo,
  ProviderModel,
  ProviderStatus,
  ThinkingLevel,
} from '@morse/protocol';
import { asProviderStatus } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { BotFace } from '../../ui/bot-face/bot-face';
import { moodForBot } from '../../ui/bot-face/bot-mood';
import { ModelInputs } from '../model-picker/model-inputs';
import { BRAIN_PATHS } from '../thinking-picker/thinking-brain';
import { LEVEL_COLORS, ModelsTable } from '../providers/models-table';
import { BotMcpStep, parseEnvText } from './bot-mcp-step';
import {
  DEFAULT_TOOLS,
  ENGINE_TOOLS,
  PROVIDER_APIS,
  THINKING_LEVELS,
  USERNAME_PATTERN,
  nextRequestId,
  parseEnvVars,
  usernameFrom,
} from './bot-wizard-data';

/** One OpenCode subagent the reader defined: a name and its own system prompt. */
interface SubagentRow {
  name: string;
  prompt: string;
}

/** One bot-local custom provider, isolated to this bot. Same UX as Settings. */
interface LocalProvider {
  id: string;
  label: string;
  api: BotProviderApi;
  baseUrl: string;
  /** `'stored'` when a key is pasted; `'env'` when the reader named a variable. */
  credentialKind: 'stored' | 'env';
  apiKey: string;
  envName: string;
  models: ProviderModel[];
}


/**
 * One bot's page: it creates a new bot and edits an existing one, and it is the
 * same page both ways — a face, a name, the line it helps with, then rows for
 * how it runs.
 *
 * The rows are the design. A beginner answers two fields and one row (the model,
 * which is open on the engine's own catalog and needs a key only for a vendor
 * that asks for one); everything an expert wants — keys and custom providers,
 * instructions, tools, MCP servers, AGENTS.md, environment, subagents — is one
 * click away in a row rather than a step in a sequence. Editing is the same
 * page with nothing locked except the name and the engine, which the bot's
 * directory already answers.
 */
@Component({
  selector: 'morse-bot-wizard',
  templateUrl: './bot-wizard.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BotFace, BotMcpStep, ModelsTable, ModelInputs],
  styleUrl: './bot-wizard.css',
})
export class BotWizard {
  private readonly morse = inject(MorseService);
  private readonly tabs = inject(WorkspaceTabs);
  /**
   * The tab this editor lives in. Supplied when the shell mounts one editor per
   * bot tab; a bare `<morse-bot-wizard>` falls back to the service's own signal.
   */
  readonly tabId = input<string | undefined>(undefined);
  /** The bot this form edits, or `null` for a new one. */
  readonly target = input<string | null | undefined>(undefined);

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
  /** Catalog provider keys: `{provider, apiKey}` rows, isolated to this bot. */
  protected readonly credentials = signal<{ provider: string; apiKey: string }[]>([]);
  /**
   * Snapshot this machine's global engine configuration into this bot on
   * submit: stored keys and custom providers, copied host-side so the secrets
   * never travel. The bot wins on conflict and stays isolated afterwards.
   */
  protected readonly useGlobalConfig = signal(false);
  /**
   * The engine's provider catalog, read live from Settings' own source
   * (`providerStatus`): the reader picks a model from it, and pastes the key
   * beside it — the key stays isolated to this bot, never read from the host.
   */
  protected readonly catalog = signal<ProviderStatus | undefined>(undefined);
  protected readonly catalogLoading = signal(false);
  /** Why the provider catalog could not be read, said on the section. */
  protected readonly catalogError = signal<string | null>(null);
  /**
   * Models the engine reported for catalog providers that list none, keyed by
   * provider id. A builtin's listing is not a sign-in: OpenCode's catalog names
   * every model its server knows, with or without a key, so a probe with the
   * keys typed so far (possibly none) fills what `providerStatus` leaves empty.
   */
  protected readonly probedModels = signal<Record<string, ModelOption[]>>({});
  /** True while a catalog-provider probe is in flight. */
  protected readonly catalogProbing = signal(false);
  /** The probe request waiting for its `bot/models` answer, if any. */
  private readonly probeRequestId = signal<string | null>(null);
  /** Which provider the in-flight probe asks about. */
  private readonly probeProvider = signal('');
  /** The notice held when the in-flight probe started, so only a new one fails it. */
  private readonly probeNotice = signal<unknown>(undefined);
  /** What the filed probes asked, so a repeat answers from the record. */
  private readonly probedPrint = signal<Record<string, string>>({});
  /** Which provider's models the detail shows: a global id or a local one. */
  protected readonly pickedProvider = signal('');
  /** The provider search box, filtering the cards. */
  protected readonly providerQuery = signal('');
  /** Bot-local custom providers, isolated to this bot. Same editor as Settings. */
  protected readonly localProviders = signal<LocalProvider[]>([]);
  /** The local-provider editor, while it is open; a null target means a new one. */
  protected readonly editorOpen = signal(false);
  protected readonly editorTarget = signal<string | null>(null);
  protected readonly editorId = signal('');
  protected readonly editorLabel = signal('');
  protected readonly editorApi = signal<BotProviderApi>('openai-completions');
  protected readonly editorBaseUrl = signal('');
  protected readonly editorKeyKind = signal<'stored' | 'env'>('stored');
  protected readonly editorApiKey = signal('');
  protected readonly editorEnvName = signal('');
  protected readonly editorModels = signal<ProviderModel[]>([]);
  /** True while a discovery request for the editor is in flight. */
  protected readonly editorProbing = signal(false);
  /** The discovery failure, said on the editor instead of a toast. */
  protected readonly editorError = signal<string | null>(null);

  protected readonly envVars = signal('');
  /** Values set only for this bot, one `KEY=value` per line. */
  protected readonly envText = signal('');
  /** Whether the loaded config had its own values, so clearing them is a real save. */
  private readonly envLoaded = signal(false);
  /**
   * The built-in tools this bot may use, in its engine's own names. Empty means
   * none — a chat-only bot — and that is also what keeps a provider that emulates
   * tools by telling the model to "reply in JSON only" from doing it.
   */
  protected readonly tools = signal<string[]>([...(DEFAULT_TOOLS['pi'] ?? [])]);
  /**
   * Whether the reader changed the tool selection. Until they do, no `tools` is
   * sent at all and the bot's settings stay byte-for-byte what a default pi
   * install has: pi's own `defaultTools` (`read`, `bash`, `edit`, `write`) is
   * resolved by pi itself, not pinned by Morse.
   */
  private readonly toolsEdited = signal(false);
  protected readonly persona = signal('');
  /** Whether the reader has written instructions of their own. */
  private readonly personaEdited = signal(false);
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
  /** The discovery in flight on the editor, keyed by its request id. */
  private readonly editorRequestId = signal<string | null>(null);
  /** The bot being created, while the roster has not named it yet. */
  protected readonly pending = signal<string | null>(null);
  protected readonly createError = signal<string | null>(null);
  private readonly knownBotsAtSubmit = signal<readonly string[]>([]);
  /** The roster as it stood at submit, so an edit knows when its save landed. */
  private readonly rosterAtSubmit = signal<{ bots: unknown[] } | null>(null);
  private readonly noticeAtSubmit = signal<{ level: string; text: string; at: number } | null>(null);
  /** The model search box, filtering the picked provider's list. */
  protected readonly modelFilter = signal('');

  protected readonly engines = this.morse.engines;
  protected readonly providerApis = PROVIDER_APIS;
  /** The thinking picker's brain, for the model list's badges. */
  protected readonly brainPaths = BRAIN_PATHS;
  /** Brain colour per thinking level, the composer's own palette. */
  protected readonly levelColors = LEVEL_COLORS;
  /** The faces a reader may pick instead of the one their handle draws. */
  protected readonly faceChoices = Array.from({ length: 11 }, (_, index) => `face:${index + 2}`);

  private moodTimer?: ReturnType<typeof setTimeout>;

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

  /**
   * The bot being edited, or `null` while creating a new one. A tab carries its
   * own target (several forms can be open at once); the service's signal keeps a
   * bare wizard working too.
   */
  protected readonly editTarget = computed(() => {
    const fromTab = this.target();
    return fromTab === undefined ? this.morse.ui.wizardTarget() : fromTab;
  });
  protected readonly editing = computed(() => this.editTarget() !== null);

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

  /**
   * The tools to send: nothing when the reader left pi's default alone, because
   * pi resolves its own set. OpenCode's checklist is authoritative even when
   * untouched: its `permissions` ruleset is what allows a tool, and an absent
   * one would deny every call.
   */
  private toolsToSend(): string[] | undefined {
    if (this.toolsEdited()) {
      return [...this.tools()];
    }
    return this.engineKind() === 'opencode' ? [...(DEFAULT_TOOLS['opencode'] ?? [])] : undefined;
  }

  /**
   * The providers the picker shows: the engine's public catalog plus this
   * bot's local custom providers. A local id shadows the global one it
   * replaces, so an edited endpoint reads as one card. Global custom
   * endpoints stay hidden until "Use global configuration" is checked —
   * unchecked means isolated: not even a private endpoint's name leaks in.
   */
  protected readonly pickerProviders = computed(() => {
    const global = this.catalog()?.providers ?? [];
    const localIds = new Set(this.localProviders().map((provider) => provider.id));
    // Isolated keys only: a "Connected" badge from the host's own store would
    // lie here — the bot never reads it. A card reads as keyed when this bot
    // holds a key for it.
    const keyed = new Set(
      this.credentials()
        .filter((row) => row.provider.trim().length > 0 && row.apiKey.trim().length > 0)
        .map((row) => row.provider.trim()),
    );
    interface PickerCard {
      id: string;
      label: string;
      hint: string;
      models: number;
      connected: boolean;
      /** True when the badge comes from the global snapshot, not a pasted key. */
      viaGlobal: boolean;
      local: boolean;
      custom: boolean;
    }
    // Checked "Use global configuration" snapshots the host's keys and custom
    // endpoints on submit, so the cards preview that live: global customs
    // appear, and a globally connected provider reads as connected.
    // Unchecked, only this bot's own pasted keys and its own customs count —
    // the host's store and its private endpoints stay out of the list.
    const snapshot = this.useGlobalConfig();
    const cards: PickerCard[] = global
      .filter((provider) => !localIds.has(provider.id) && (snapshot || provider.kind !== 'custom'))
      .map((provider) => {
        const keyedHere = keyed.has(provider.id);
        const viaGlobal = !keyedHere && snapshot && provider.connected;
        // Probed models count too: a builtin lists none in the catalog, so
        // without this its card — and the auto-pick — would read as unusable.
        const probed = (this.probedModels()[provider.id] ?? []).length;
        return {
          id: provider.id,
          label: provider.name,
          hint: provider.kind === 'custom'
            ? `${(provider.models ?? []).length} models · shared endpoint`
            : provider.description,
          models: (provider.models ?? []).length + probed,
          connected: keyedHere || viaGlobal,
          viaGlobal,
          local: false,
          custom: provider.kind === 'custom',
        };
      });
    for (const provider of this.localProviders()) {
      cards.push({
        id: provider.id,
        label: provider.label,
        hint: `${provider.models.length} models · this bot`,
        models: provider.models.length,
        connected: false,
        viaGlobal: false,
        local: true,
        custom: true,
      });
    }
    const query = this.providerQuery().trim().toLowerCase();
    const shown =
      query.length === 0
        ? cards
        : cards.filter((card) =>
            [card.label, card.id, card.hint].some((value) =>
              value.toLowerCase().includes(query),
            ),
          );
    // A provider with models is what the reader can pick right now; the rest
    // are keys that would add some. Ties fall back to a stable order.
    return [...shown].sort(
      (left, right) =>
        Number(right.models > 0) - Number(left.models > 0) ||
        left.label.localeCompare(right.label),
    );
  });

  /**
   * The name a provider's key travels under in the environment — the placeholder
   * in its field, so a reader who already exports it recognises the field.
   */
  protected envNameFor(provider: string): string {
    return `${provider.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}_API_KEY`;
  }

  /** Clicking a card shows that provider's models in the detail below it. */
  protected pickProvider(provider: string): void {
    this.pickedProvider.set(provider);
  }

  /** Which provider's models the detail draws. */
  protected readonly pickedProviderId = computed(() => {
    const cards = this.pickerProviders();
    const chosen = this.pickedProvider();
    if (cards.some((card) => card.id === chosen)) {
      return chosen;
    }
    const found = cards.find((card) => card.models > 0) ?? cards[0];
    if (found !== undefined) {
      return found.id;
    }
    // No cards at all (an empty catalog): keep showing the saved model's
    // provider, so an edit never loses its pick.
    const key = this.modelKey();
    return key.includes('/') ? key.slice(0, key.indexOf('/')) : '';
  });

  /** The picked provider's catalog entry, when it is a global one. */
  protected readonly pickedGlobal = computed(() =>
    this.catalog()?.providers.find((one) => one.id === this.pickedProviderId()),
  );

  /** The picked provider's local entry, when it belongs to this bot. */
  protected readonly pickedLocal = computed(() =>
    this.localProviders().find((one) => one.id === this.pickedProviderId()),
  );

  /** That provider's models, narrowed by the search field. */
  protected readonly pickedModels = computed(() => {
    const id = this.pickedProviderId();
    const filter = this.modelFilter().trim().toLowerCase();
    return this.allModels().filter(
      (model) =>
        model.provider === id &&
        (filter.length === 0 ||
          model.id.toLowerCase().includes(filter) ||
          model.name.toLowerCase().includes(filter)),
    );
  });

  /** Full model entries of the picked provider, for the capability badges. */
  protected readonly pickedModelDetails = computed(() => {
    const id = this.pickedProviderId();
    const global = this.catalog()?.providers.find((one) => one.id === id)?.models ?? [];
    const local = this.localProviders().find((one) => one.id === id)?.models ?? [];
    const details = new Map<string, ProviderModel>();
    for (const model of global) {
      details.set(model.id, model);
    }
    for (const model of local) {
      details.set(model.id, model);
    }
    return details;
  });

  /** The models each source offers, one flat searchable list. */
  protected readonly pinnedModel = signal<ModelOption | undefined>(undefined);

  /**
   * Everything the picker can offer: the engine catalog's models plus each
   * bot-local provider's, then the model this bot already runs on when neither
   * lists it (an edited bot whose keys were never handed back) — otherwise the
   * saved choice would vanish from the list.
   */
  protected readonly allModels = computed<ModelOption[]>(() => {
    const from = (provider: string, models: readonly ProviderModel[]): ModelOption[] =>
      models.map((model) => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        ...(model.input === undefined ? {} : { input: model.input }),
      }));
    const global = (this.catalog()?.providers ?? []).flatMap((provider) =>
      from(provider.id, provider.models ?? []),
    );
    const probed = Object.entries(this.probedModels()).flatMap(([provider, models]) =>
      from(provider, models),
    );
    const local = this.localProviders().flatMap((provider) => from(provider.id, provider.models));
    const seen = new Set<string>();
    const models = [...global, ...probed, ...local].filter((model) => {
      const key = this.modelOptionKey(model);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    const pinned = this.pinnedModel();
    if (pinned === undefined) {
      return models;
    }
    const key = this.modelOptionKey(pinned);
    return models.some((candidate) => this.modelOptionKey(candidate) === key)
      ? models
      : [...models, pinned];
  });

  protected readonly model = computed<ModelOption | undefined>(() =>
    this.allModels().find((candidate) => this.modelOptionKey(candidate) === this.modelKey()),
  );

  /**
   * The thinking levels the picked model actually offers: its own declared
   * set when the catalog (or the local editor) knows it, the full engine
   * vocabulary when nobody said. A custom endpoint's models carry the levels
   * the reader gave them, so they narrow this too.
   */
  protected readonly thinkingOptions = computed<ThinkingLevel[]>(() => {
    const model = this.model();
    const detail = model === undefined ? undefined : this.pickedModelDetails().get(model.id);
    const levels = detail?.thinkingLevels;
    if (levels !== undefined && levels.length > 0) {
      return [...levels];
    }
    const thinking = detail?.thinking;
    if (thinking !== undefined) {
      const offered = THINKING_LEVELS.filter(
        (level) => thinking[level] !== undefined && thinking[level] !== null,
      );
      if (offered.length > 0) {
        return offered;
      }
    }
    return [...THINKING_LEVELS];
  });

  /** Why Create holds, in the reader's words; empty once it may pass. */
  protected readonly modelBlocker = computed(() => {
    if (this.model() !== undefined) {
      return '';
    }
    if (this.catalogLoading() || this.catalogProbing()) {
      return "Loading this engine's providers…";
    }
    if (this.catalogError() !== null) {
      return '';
    }
    if (this.allModels().length === 0) {
      return 'This engine listed no models. Add a provider below — a bot must be given a model to run on.';
    }
    return 'Pick a model to continue.';
  });

  protected readonly collectedCredentials = computed(() =>
    this.credentials()
      .filter((row) => row.provider.trim().length > 0 && row.apiKey.trim().length > 0)
      .map((row) => ({ provider: row.provider.trim(), apiKey: row.apiKey.trim() })),
  );

  /** The bot-local providers, as the create will send them (keys included). */
  protected readonly collectedProviders = computed<BotProviderInput[]>(() =>
    this.localProviders()
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

  /**
   * The bot-local providers, as an edit sends them: model fields only, around
   * the key the engine already stores. Keys are never read back, so an edit
   * carries no credential — a correction never costs the reader their key.
   */
  protected readonly editedProviders = computed<BotProviderConfig[]>(() =>
    this.localProviders()
      .filter((draft) => draft.id.trim().length > 0 && draft.models.length > 0)
      .map((draft) => ({
        id: draft.id.trim(),
        label: draft.label.trim() || draft.id.trim(),
        api: draft.api,
        ...(draft.baseUrl.trim().length > 0 ? { baseUrl: draft.baseUrl.trim() } : {}),
        models: draft.models.map((model) => ({ ...model })),
      })),
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
    // A discovery answer for the editor's request fills the editor's models.
    effect(() => {
      const requestId = this.editorRequestId();
      if (requestId === null) {
        return;
      }
      const answer = this.morse.bot.models()[requestId];
      if (answer === undefined) {
        return;
      }
      untracked(() => {
        this.editorRequestId.set(null);
        this.editorProbing.set(false);
        this.editorModels.set(
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
          this.editorError.set('The endpoint listed no models.');
        }
      });
    });
    // A discovery can also fail (refused key, unreachable endpoint). The host
    // says so as a notice; a new notice while a discovery is in flight is that
    // failure, shown on the editor.
    effect(() => {
      const notice = this.morse.lastNotice();
      const waiting = this.editorProbing();
      if (!waiting || notice === undefined) {
        return;
      }
      untracked(() => {
        this.editorRequestId.set(null);
        this.editorProbing.set(false);
        this.editorError.set(notice.text);
      });
    });
    // A catalog provider that lists no models is asked of the engine itself:
    // the same probe a botless create would run, with the keys typed so far
    // (possibly none — a listing is not a sign-in). Typing a key changes what
    // the probe asks, so it refires; an answer already filed for the same
    // question is reused instead.
    effect(() => {
      const engine = this.engineKind();
      const picked = this.pickedProviderId();
      if (engine.length === 0 || picked.length === 0 || this.probeRequestId() !== null) {
        return;
      }
      if (this.localProviders().some((one) => one.id === picked)) {
        return;
      }
      const entry = this.catalog()?.providers.find((one) => one.id === picked);
      if (entry === undefined || (entry.models ?? []).length > 0) {
        return;
      }
      const fingerprint = [engine, picked, JSON.stringify(this.collectedCredentials())].join('\n');
      if (this.probedPrint()[picked] === fingerprint) {
        return;
      }
      const requestId = nextRequestId();
      untracked(() => {
        this.probeProvider.set(picked);
        this.probeRequestId.set(requestId);
        this.probeNotice.set(this.morse.lastNotice());
        this.catalogProbing.set(true);
        this.morse.probeModels(
          engine,
          parseEnvVars(this.envVars()),
          this.collectedCredentials(),
          requestId,
        );
      });
    });
    // A catalog probe's answer fills that provider's models; a failed probe
    // stops the spinner and leaves the empty list said as it was.
    effect(() => {
      const requestId = this.probeRequestId();
      if (requestId === null) {
        return;
      }
      const answer = this.morse.bot.models()[requestId];
      if (answer === undefined) {
        return;
      }
      untracked(() => {
        const provider = this.probeProvider();
        const fingerprint = [this.engineKind(), provider, JSON.stringify(this.collectedCredentials())].join('\n');
        this.probedModels.update((held) => ({ ...held, [provider]: answer }));
        this.probedPrint.update((held) => ({ ...held, [provider]: fingerprint }));
        this.probeRequestId.set(null);
        this.probeProvider.set('');
        this.catalogProbing.set(false);
      });
    });
    effect(() => {
      const notice = this.morse.lastNotice();
      if (!this.catalogProbing() || notice === undefined || notice === this.probeNotice()) {
        return;
      }
      untracked(() => {
        this.probeRequestId.set(null);
        this.probeProvider.set('');
        this.catalogProbing.set(false);
      });
    });
    // The providers are the page's first question, so the engine's catalog is
    // read as soon as there is an engine to ask about.
    effect(() => {
      this.engineKind();
      untracked(() => void this.loadCatalog());
    });
    // An engine's providers can change in Settings while this editor is open;
    // re-read so the picker never offers a stale list.
    this.morse.onProvidersChanged((event) => {
      if (event.engine.length === 0 || event.engine === this.engineKind()) {
        void this.loadCatalog();
      }
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
    // A new bot opens on an engine rather than on a question: the engine is a
    // detail for most readers, and its catalog is what fills the model row.
    effect(() => {
      const engines = this.engines();
      if (this.editing() || this.engineKind().length > 0 || engines.length === 0) {
        return;
      }
      untracked(() => this.chooseEngine(engines[0]!.kind));
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
      | 'envText'
      | 'modelFilter'
      | 'providerQuery',
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
        this.seedPersona();
        return;
      case 'description':
        this.description.set(value);
        this.seedPersona();
        return;
      case 'avatar':
        this.avatar.set(value);
        return;
      case 'persona':
        this.personaEdited.set(true);
        this.persona.set(value);
        return;
      case 'agentsMd':
        this.agentsMd.set(value);
        return;
      case 'envVars':
        this.envVars.set(value);
        return;
      case 'envText':
        this.envText.set(value);
        return;
      case 'modelFilter':
        this.modelFilter.set(value);
        return;
      case 'providerQuery':
        this.providerQuery.set(value);
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
      this.useGlobalConfig.set(false);
      this.localProviders.set([]);
      this.modelKey.set('');
      // The catalog belongs to another engine, so the picker goes back to
      // whichever provider it can actually list models for.
      this.pickedProvider.set('');
      this.probedModels.set({});
      this.probedPrint.set({});
      this.probeRequestId.set(null);
      this.probeProvider.set('');
      this.catalogProbing.set(false);
      this.closeEditor();
      // Servers are engine-specific config (`mcp.json` vs `opencode.json`), so a
      // list collected for another engine would be written in the wrong shape.
      this.mcpServers.set([]);
      this.mcpLoaded.set(false);
      // A new engine offers different tools: start from its own defaults rather
      // than carrying names it does not have.
      this.tools.set([...(DEFAULT_TOOLS[kind] ?? [])]);
      this.toolsEdited.set(false);
      // The providers belong to the engine, and the picker sits right below
      // the choice: read at once rather than on the next visit.
      void this.loadCatalog();
    }
  }

  /**
   * Reads the engine's provider catalog — the same source Settings shows — so
   * the picker offers every provider the engine knows, with their models.
   */
  protected async loadCatalog(): Promise<void> {
    if (this.engineKind().length === 0) {
      return;
    }
    const engine = this.engineKind();
    this.catalogLoading.set(true);
    this.catalogError.set(null);
    // A reload answers for this engine only: drop filed probes and cancel the
    // in-flight one, whose late answer no longer names this catalog.
    this.probedModels.set({});
    this.probedPrint.set({});
    this.probeRequestId.set(null);
    this.probeProvider.set('');
    this.catalogProbing.set(false);
    try {
      const answer = await this.morse.requestHostCommand('providerStatus', { engine });
      if (this.engineKind() !== engine) {
        return; // The reader switched engines while the host answered.
      }
      const status = asProviderStatus(answer);
      if (status === undefined) {
        this.catalogError.set('Could not read this engine’s providers.');
        return;
      }
      this.catalog.set(status);
      const issues = status.issues ?? [];
      if (issues.length > 0) {
        this.catalogError.set(issues.map((one) => one.message).join('\n'));
      }
    } catch (error: unknown) {
      this.catalogError.set(error instanceof Error ? error.message : 'Could not load providers.');
    } finally {
      this.catalogLoading.set(false);
    }
  }

  protected setGlobalConfig(event: Event): void {
    this.useGlobalConfig.set((event.target as HTMLInputElement).checked);
  }

  /** What is typed in one provider's key field, so a re-render keeps it. */
  protected providerKey(credential: string): string {
    return this.credentials().find((row) => row.provider === credential)?.apiKey ?? '';
  }

  /**
   * The key typed for a global provider. It is committed on blur and stored
   * isolated to this bot — the host's own credential store is never read.
   */
  protected setProviderKey(credential: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    const held = this.credentials();
    this.credentials.set(
      held.some((row) => row.provider === credential)
        ? held.map((row) => (row.provider === credential ? { ...row, apiKey: value } : row))
        : [...held, { provider: credential, apiKey: value }],
    );
  }

  /** Opens the local-provider editor for a new endpoint of this bot. */
  protected openAddLocal(): void {
    this.editorTarget.set(null);
    this.editorId.set('');
    this.editorLabel.set('');
    this.editorApi.set('openai-completions');
    this.editorBaseUrl.set('');
    this.editorKeyKind.set('stored');
    this.editorApiKey.set('');
    this.editorEnvName.set('');
    this.editorModels.set([]);
    this.editorError.set(null);
    this.editorProbing.set(false);
    this.editorRequestId.set(null);
    this.editorOpen.set(true);
  }

  /** Opens the local-provider editor for one this bot already holds. */
  protected openEditLocal(provider: LocalProvider): void {
    this.editorTarget.set(provider.id);
    this.editorId.set(provider.id);
    this.editorLabel.set(provider.label);
    this.editorApi.set(provider.api);
    this.editorBaseUrl.set(provider.baseUrl);
    this.editorKeyKind.set(provider.credentialKind);
    this.editorApiKey.set(provider.apiKey);
    this.editorEnvName.set(provider.envName);
    this.editorModels.set(provider.models.map((model) => ({ ...model })));
    this.editorError.set(null);
    this.editorProbing.set(false);
    this.editorRequestId.set(null);
    this.editorOpen.set(true);
  }

  /** Copies a shared endpoint into this bot, so its models stay editable here. */
  protected copyGlobalCustom(provider: ProviderInfo): void {
    if (!this.localProviders().some((one) => one.id === provider.id)) {
      this.localProviders.update((rows) => [
        ...rows,
        {
          id: provider.id,
          label: provider.name,
          api: (provider.api ?? 'openai-completions') as BotProviderApi,
          baseUrl: provider.baseURL ?? '',
          credentialKind: 'stored',
          apiKey: '',
          envName: '',
          models: (provider.models ?? []).map((model) => ({ ...model })),
        },
      ]);
    }
    const local = this.localProviders().find((one) => one.id === provider.id);
    if (local !== undefined) {
      this.openEditLocal(local);
    }
  }

  protected closeEditor(): void {
    this.editorOpen.set(false);
    this.editorTarget.set(null);
  }

  protected setEditor(
    target: 'id' | 'label' | 'baseUrl' | 'apiKey' | 'envName',
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement).value;
    switch (target) {
      case 'id':
        this.editorId.set(value);
        return;
      case 'label':
        this.editorLabel.set(value);
        return;
      case 'baseUrl':
        this.editorBaseUrl.set(value);
        return;
      case 'apiKey':
        this.editorApiKey.set(value);
        return;
      case 'envName':
        this.editorEnvName.set(value);
        return;
    }
  }

  protected setEditorApi(event: Event): void {
    this.editorApi.set((event.target as HTMLSelectElement).value as BotProviderApi);
  }

  protected setEditorKeyKind(kind: 'stored' | 'env'): void {
    this.editorKeyKind.set(kind);
  }

  /** Asks the endpoint what it serves; the effect above files the answer. */
  protected discoverEditor(): void {
    const baseUrl = this.editorBaseUrl().trim();
    if (baseUrl.length === 0 || this.editorRequestId() !== null) {
      return;
    }
    const requestId = nextRequestId();
    this.editorRequestId.set(requestId);
    this.editorProbing.set(true);
    this.editorError.set(null);
    void this.morse.discoverModels(
      baseUrl,
      this.editorKeyKind() === 'stored'
        ? { kind: 'stored', apiKey: this.editorApiKey() }
        : { kind: 'env', name: this.editorEnvName().trim() },
      requestId,
    );
  }

  /** The editor's validity: an id, a URL and at least one model. */
  protected readonly editorValid = computed(
    () =>
      this.editorId().trim().length > 0 &&
      /^https?:\/\//.test(this.editorBaseUrl().trim()) &&
      this.editorModels().some((row) => row.id.trim().length > 0),
  );

  protected saveEditor(): void {
    const id = this.editorId().trim();
    if (id.length === 0 || !this.editorValid()) {
      return;
    }
    const target = this.editorTarget();
    if (target === null && this.localProviders().some((row) => row.id === id)) {
      this.editorError.set(`A provider named "${id}" is already in this bot.`);
      return;
    }
    const entry: LocalProvider = {
      id,
      label: this.editorLabel().trim() || id,
      api: this.editorApi(),
      baseUrl: this.editorBaseUrl().trim(),
      credentialKind: this.editorKeyKind(),
      apiKey: this.editorApiKey(),
      envName: this.editorEnvName().trim(),
      models: this.editorModels()
        .filter((model) => model.id.trim().length > 0)
        .map((model) => ({ ...model })),
    };
    if (target === null) {
      this.localProviders.update((rows) => [...rows, entry]);
    } else {
      this.localProviders.update((rows) => rows.map((row) => (row.id === target ? entry : row)));
    }
    this.closeEditor();
    this.pickedProvider.set(id);
  }

  protected removeLocal(id: string): void {
    this.localProviders.update((rows) => rows.filter((row) => row.id !== id));
    if (this.pickedProvider() === id) {
      this.pickedProvider.set('');
    }
  }

  protected pickModel(key: string): void {
    const providerId = key.slice(0, key.indexOf('/'));
    // A shared endpoint has no place in the bot until it is copied in: picking
    // one clones it into this bot (without its key), so the save always runs.
    const global = this.catalog()?.providers.find((one) => one.id === providerId);
    if (
      global !== undefined &&
      global.kind === 'custom' &&
      !this.localProviders().some((one) => one.id === providerId)
    ) {
      this.localProviders.update((rows) => [
        ...rows,
        {
          id: global.id,
          label: global.name,
          api: (global.api ?? 'openai-completions') as BotProviderApi,
          baseUrl: global.baseURL ?? '',
          credentialKind: 'stored',
          apiKey: '',
          envName: '',
          models: (global.models ?? []).map((model) => ({ ...model })),
        },
      ]);
    }
    this.modelKey.set(key);
    // The detail follows the choice, so reopening the page shows its provider.
    this.pickedProvider.set(providerId);
    // A level the new model does not offer falls back to the engine default.
    if (this.thinking() !== '' && !this.thinkingOptions().includes(this.thinking() as ThinkingLevel)) {
      this.thinking.set('');
    }
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

  protected cancel(): void {
    this.close();
  }

  /**
   * Closing forgets the edit target so the next open is clean, and closes only
   * this editor tab — other drafts must survive this one being saved or cancelled.
   */
  private close(): void {
    const id = this.tabId();
    if (id !== undefined) {
      this.tabs.close(id);
    } else {
      this.morse.ui.wizardOpen.set(false);
    }
    this.morse.ui.wizardTarget.set(null);
  }

  /**
   * Fills the form from the bot's own record: every section is on the page, so
   * there is nothing to unlock and nothing to walk through.
   */
  private fillFromConfig(config: BotConfig): void {
    this.username.set(config.username);
    this.name.set(config.name);
    this.description.set(config.description);
    this.avatar.set(config.avatar ?? '');
    this.engineKind.set(config.engineKind);
    // Keys are the engine's, never read back: the fields start blank.
    this.credentials.set([]);
    this.envVars.set(config.envVars.join(', '));
    this.envText.set(
      Object.entries(config.env ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    this.envLoaded.set(config.env !== undefined);
    this.persona.set(config.persona);
    this.personaEdited.set(true);
    this.agentsMd.set(config.agentsMd ?? '');
    this.subagents.set((config.subagents ?? []).map((row) => ({ ...row })));
    // A server list is read back whole, and `mcpLoaded` remembers whether the
    // config had one: an absent list is "do not touch the engine's file".
    this.mcpServers.set((config.mcpServers ?? []).map((server) => ({ ...server })));
    this.mcpLoaded.set(config.mcpServers !== undefined);
    // An edit's own providers become this bot's local list: the same editor as
    // a create, without the credential the engine already stores.
    this.localProviders.set(
      (config.providers ?? []).map((provider) => ({
        id: provider.id,
        label: provider.label,
        api: provider.api ?? 'openai-completions',
        baseUrl: provider.baseUrl ?? '',
        credentialKind: 'stored' as const,
        apiKey: '',
        envName: '',
        models: provider.models.map((model) => ({ ...model })),
      })),
    );
    this.thinking.set(config.thinkingLevel ?? '');
    this.tools.set([...(config.tools ?? DEFAULT_TOOLS[config.engineKind] ?? [])]);
    this.toolsEdited.set(config.tools !== undefined);
    this.pinnedModel.set(config.model);
    this.modelKey.set(config.model === undefined ? '' : this.modelOptionKey(config.model));
    this.pickedProvider.set(config.model === undefined ? '' : config.model.provider);
    // An edit is one page: read the engine's providers here, or the model list
    // would hold nothing but the model already saved.
    void this.loadCatalog();
  }

  protected canSubmit(): boolean {
    if (this.pending() !== null) {
      return false;
    }
    // A bot needs who it is and what it runs on. An edit keeps its model even
    // when the catalog cannot list it, so only a new bot has to pick one.
    const needsModel = !this.editing();
    return (
      this.name().trim().length > 0 &&
      this.usernameError().length === 0 &&
      this.persona().trim().length > 0 &&
      (!needsModel || this.model() !== undefined)
    );
  }

  /** The section's answer: the chosen model, or the one the engine falls back to. */
  protected readonly modelLabel = computed(() => {
    const model = this.model();
    if (model === undefined) {
      return 'Choose a model';
    }
    return `${model.name} · ${this.thinking() === '' ? 'engine default' : this.thinking()}`;
  });

  /** Whether the avatar is an image rather than a face or an emoji. */
  protected readonly avatarIsImage = computed(() => /^(https?:|data:)/.test(this.avatar().trim()));

  /** The preview's mood: picking a face makes it happy for a moment. */
  protected readonly avatarMood = signal<'idle' | 'excited'>('idle');

  /** The mood the preview would wear once this bot runs, from what was typed. */
  protected readonly previewMood = computed(() =>
    this.avatarMood() === 'excited'
      ? 'excited'
      : moodForBot({ description: `${this.name()} ${this.description()}` }),
  );

  protected pickAvatar(face: string): void {
    this.avatar.set(this.avatar().trim() === face ? '' : face);
    this.avatarMood.set('excited');
    clearTimeout(this.moodTimer);
    this.moodTimer = setTimeout(() => this.avatarMood.set('idle'), 900);
  }

  /**
   * Writes a first system prompt from what the reader already typed, so the
   * required field is a starting point rather than a blank page.
   */
  protected useStarterPersona(): void {
    this.personaEdited.set(true);
    this.persona.set(this.starterPersona());
  }

  /**
   * The instructions a bot gets until its reader writes their own: its name and
   * its one-line purpose, in the voice every bot of this app speaks in. A form
   * that opens on a blank required textarea is a form that stops a beginner.
   */
  private seedPersona(): void {
    if (this.personaEdited()) {
      return;
    }
    this.persona.set(this.starterPersona());
  }

  /** The instructions a bot gets for free: its name, its purpose, its voice. */
  private starterPersona(): string {
    const name = this.name().trim() || 'this bot';
    const doing = this.description().trim();
    return [
      `You are ${name}.`,
      doing.length > 0 ? `${doing}.` : '',
      '',
      'Answer in your own voice: short unless the question needs length, plain unless it needs',
      'jargon. Say what you did, and say when you are unsure rather than guessing.',
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  }

  protected submit(): void {
    if (!this.canSubmit()) {
      return;
    }
    const target = this.editTarget();
    this.noticeAtSubmit.set(this.morse.lastNotice() ?? null);
    this.createError.set(null);
    const parsedEnv = parseEnvText(this.envText());
    if (parsedEnv.error !== undefined) {
      this.createError.set(parsedEnv.error);
      return;
    }
    const extraEnv =
      Object.keys(parsedEnv.values).length === 0 && !this.envLoaded()
        ? undefined
        : parsedEnv.values;
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
        ...(extraEnv === undefined ? {} : { env: extraEnv }),
        agentsMd,
        subagents,
        // Only a pasted key replaces the stored ones; an untouched form keeps them.
        ...(credentials.length === 0 ? {} : { credentials }),
        // A checked box snapshots the machine's global config into this bot.
        ...(this.useGlobalConfig() ? { useGlobalConfig: true } : {}),
        // Model fields the reader corrected, written back into the bot's own
        // provider config around the credential already there.
        ...(this.editedProviders().length === 0 ? {} : { providers: this.editedProviders() }),
        // A config that named servers is written back whole (even emptied); one
        // that named none leaves the engine's file alone.
        ...(this.mcpLoaded() || this.mcpServers().length > 0
          ? { mcpServers: this.mcpServers() }
          : {}),
      });
      this.pending.set(target);
      return;
    }
    const requestId = nextRequestId();
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
      // A checked box snapshots the machine's global config into this bot.
      ...(this.useGlobalConfig() ? { useGlobalConfig: true } : {}),
      envVars: parseEnvVars(this.envVars()),
      ...(extraEnv === undefined ? {} : { env: extraEnv }),
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
