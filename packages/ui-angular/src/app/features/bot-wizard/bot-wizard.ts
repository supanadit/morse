import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { BotCreateInput, ModelOption, ThinkingLevel } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { Dialog } from '../../ui/dialog/dialog';

/** The wizard's steps, in the order the spec pins them. */
type Step =
  'identity' | 'engine' | 'credentials' | 'model' | 'persona' | 'agentsMd' | 'subagents' | 'review';

/** One provider credential the reader pasted: the bot's own, never the global one. */
interface CredentialRow {
  provider: string;
  apiKey: string;
}

/** One OpenCode subagent the reader defined: a name and its own system prompt. */
interface SubagentRow {
  name: string;
  prompt: string;
}

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
  credentials: 'Credentials',
  model: 'Model',
  persona: 'Persona',
  agentsMd: 'AGENTS.md',
  subagents: 'Subagents',
  review: 'Review',
};

/** A wizard-local request id for the model probe; the host echoes it whole. */
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
 * The wizard that creates one isolated bot.
 *
 * The order is the point: identity, engine, credentials, then the model. A bot's
 * model catalog is read with *the bot's own* credentials, so the credentials
 * step must exist before the probe — and the model step stays disabled until the
 * host answers under this wizard's `requestId`. The subagent editor appears only
 * for OpenCode, the one engine with named subagents; that is the single engine
 * check in this feature, as the spec pins.
 */
@Component({
  selector: 'morse-bot-wizard',
  templateUrl: './bot-wizard.html',
  imports: [Dialog],
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
  protected readonly credentials = signal<CredentialRow[]>([]);
  protected readonly envVars = signal('');
  protected readonly persona = signal('');
  protected readonly agentsMd = signal('');
  protected readonly subagents = signal<SubagentRow[]>([]);
  /** The model pick, keyed `provider/id`; empty until the reader chooses. */
  protected readonly modelKey = signal('');
  protected readonly thinking = signal<ThinkingLevel>('off');
  /** The probe this wizard is waiting on, and the models it answered with. */
  private readonly requestId = signal<string | null>(null);
  /** The bot being created, while the roster has not named it yet. */
  protected readonly pending = signal<string | null>(null);

  protected readonly engines = this.morse.engines;
  protected readonly thinkingLevels = THINKING_LEVELS;
  protected readonly labels = STEP_LABELS;

  /**
   * The steps this engine needs. Subagents are an OpenCode feature, so the step
   * is not drawn for pi at all — a skipped step, not a disabled one.
   */
  protected readonly steps = computed<Step[]>(() => [
    'identity',
    'engine',
    'credentials',
    'model',
    'persona',
    'agentsMd',
    ...(this.engineKind() === 'opencode' ? (['subagents'] as const) : []),
    'review',
  ]);

  /** The models the probe answered with, for this wizard's own request. */
  protected readonly models = computed<ModelOption[]>(() => {
    const requestId = this.requestId();
    return requestId === null ? [] : (this.morse.bot.models()[requestId] ?? []);
  });
  /**
   * False until `bot/models` for *this* wizard arrives. Another wizard's answer
   * must not unlock this step: its credentials and its engine are not these.
   */
  protected readonly modelsReady = computed(() => {
    const requestId = this.requestId();
    return requestId !== null && this.morse.bot.models()[requestId] !== undefined;
  });
  /** The probe answered, but with nothing to pick: a dead end, said as one. */
  protected readonly modelsEmpty = computed(() => this.modelsReady() && this.models().length === 0);
  protected readonly model = computed<ModelOption | undefined>(() =>
    this.models().find((model) => modelKey(model) === this.modelKey()),
  );
  /**
   * The subagent rows the submit will actually send: named rows only, trimmed.
   * Both the review step and `bot/create` read this, so what the reader approves
   * is byte for byte what the host writes into the bot's engine config.
   */
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
    // The wizard becomes what the host names — a pushed roster that lists this
    // bot means the create landed, so the dialog closes on that push.
    effect(() => {
      const roster = this.morse.bot.roster();
      const pending = this.pending();
      if (roster === null || pending === null) {
        return;
      }
      const created = roster.bots.some((bot) => bot.name.toLowerCase() === pending.toLowerCase());
      if (!created) {
        return;
      }
      untracked(() => {
        this.pending.set(null);
        this.morse.ui.wizardOpen.set(false);
      });
    });
  }

  protected setText(
    target: 'name' | 'description' | 'avatar' | 'persona' | 'agentsMd' | 'envVars',
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
    }
  }

  protected chooseEngine(kind: string): void {
    this.engineKind.set(kind);
  }

  protected addCredential(): void {
    this.credentials.update((rows) => [...rows, { provider: '', apiKey: '' }]);
  }

  protected removeCredential(index: number): void {
    this.credentials.update((rows) => rows.filter((_, at) => at !== index));
  }

  protected setCredential(index: number, field: 'provider' | 'apiKey', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.credentials.update((rows) =>
      rows.map((row, at) => (at === index ? { ...row, [field]: value } : row)),
    );
  }

  protected pickModel(event: Event): void {
    this.modelKey.set((event.target as HTMLSelectElement).value);
  }

  protected pickThinking(event: Event): void {
    this.thinking.set((event.target as HTMLSelectElement).value as ThinkingLevel);
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

  /** Whether the step in front has what it needs to hand over. */
  protected canAdvance(): boolean {
    switch (this.step()) {
      case 'identity':
        return this.name().trim().length > 0;
      case 'engine':
        return this.engines().some((engine) => engine.kind === this.engineKind());
      case 'credentials':
        return true;
      case 'model':
        return this.modelsReady() && this.model() !== undefined;
      case 'persona':
      case 'agentsMd':
        return true;
      case 'subagents':
        return this.subagents().every((row) => row.name.trim().length > 0);
      case 'review':
        return false;
    }
  }

  /**
   * The next step, and the one thing that must happen on the way: leaving the
   * credentials step probes the model catalog — under this wizard's request id,
   * with the environment this bot's engine will inherit.
   */
  protected next(): void {
    if (!this.canAdvance()) {
      return;
    }
    const steps = this.steps();
    const following = steps[steps.indexOf(this.step()) + 1];
    if (following === undefined) {
      return;
    }
    if (this.step() === 'credentials') {
      const requestId = nextRequestId();
      this.requestId.set(requestId);
      this.modelKey.set('');
      this.morse.probeModels(this.engineKind(), parseEnvVars(this.envVars()), requestId);
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

  /** Whether the review step can create the bot, and nothing is still in flight. */
  protected canSubmit(): boolean {
    return this.step() === 'review' && this.pending() === null;
  }

  /**
   * Creates the bot from the collected answers.
   *
   * The subagent rows travel as their own field, not folded into AGENTS.md: the
   * host hands them to an engine that stores named subagents natively (OpenCode's
   * own config), so the workspace document stays exactly what the reader wrote.
   * The review step shows both, so nothing is sent unseen.
   */
  protected submit(): void {
    if (!this.canSubmit()) {
      return;
    }
    const requestId = this.requestId();
    if (requestId === null) {
      return;
    }
    const name = this.name().trim();
    const agentsMd = this.agentsMd().trim();
    const subagents = this.namedSubagents();
    const model = this.model();
    const input: BotCreateInput & { requestId: string } = {
      name,
      description: this.description().trim(),
      ...(this.avatar().trim().length > 0 ? { avatar: this.avatar().trim() } : {}),
      engineKind: this.engineKind(),
      credentials: this.credentials()
        .filter((row) => row.provider.trim().length > 0)
        .map((row) => ({ provider: row.provider.trim(), apiKey: row.apiKey })),
      envVars: parseEnvVars(this.envVars()),
      persona: this.persona(),
      ...(model === undefined ? {} : { model }),
      thinkingLevel: this.thinking(),
      ...(agentsMd.length > 0 ? { agentsMd } : {}),
      ...(subagents.length > 0 ? { subagents } : {}),
      requestId,
    };
    this.morse.createBot(input);
    this.morse.listBots();
    this.pending.set(name);
  }
}

/** A model's stable key in the chooser, unique across providers. */
function modelKey(model: ModelOption): string {
  return `${model.provider}/${model.id}`;
}
