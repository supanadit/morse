import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  asProviderDiscover,
  asProviderLogin,
  asProviderMutation,
  asProviderStatus,
  type ProviderInfo,
  type ProviderModel,
  type ProviderStatus,
} from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { PanelState } from '../../state/panel-state';
import { TerminalStore } from '../../state/terminal-store';
import { ModelsTable } from './models-table';

type Step = 'grid' | 'detail' | 'custom';

const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];

/**
 * Provider management in Settings. Morse holds no catalog: the engine reports
 * its providers, owns sign-in through its own TUI in the GUI terminal, and
 * lists models for custom endpoints. Custom endpoints also have full per-model
 * editing — context, output, modalities and thinking levels — and discovery.
 */
@Component({
  selector: 'morse-providers-panel',
  imports: [FormsModule, ModelsTable],
  templateUrl: './providers-panel.html',
  styleUrl: './providers-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProvidersPanel {
  private readonly morse = inject(MorseService);
  private readonly store = inject(TerminalStore);
  private readonly panel = inject(PanelState);

  protected readonly engines = this.morse.engines;
  protected readonly engine = signal('');
  protected readonly status = signal<ProviderStatus | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly discovering = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly step = signal<Step>('grid');
  protected readonly editing = signal<ProviderInfo | undefined>(undefined);
  protected readonly selected = signal<ProviderInfo | undefined>(undefined);

  protected readonly formId = signal('');
  protected readonly formName = signal('');
  protected readonly formBaseURL = signal('');
  protected readonly formApi = signal('openai-completions');
  protected readonly formKey = signal('');
  /** The custom endpoint's models, as plain engine data for the shared table. */
  protected readonly customModels = signal<ProviderModel[]>([{ id: '' }]);

  protected readonly apis = APIS;

  private readonly matches = computed(() => {
    const text = this.query().trim().toLowerCase();
    const all = this.status()?.providers ?? [];
    return text.length === 0
      ? all
      : all.filter((one) => [one.name, one.id, one.description].some((value) =>
          value.toLowerCase().includes(text),
        ));
  });
  protected readonly builtins = computed(() => this.matches().filter((one) => one.kind !== 'custom'));
  protected readonly custom = computed(() => this.matches().filter((one) => one.kind === 'custom'));
  protected readonly connectedCount = computed(() => this.builtins().filter((one) => one.connected).length);

  /** Older hosts did not report auth methods; assume a pasted key worked there. */
  protected readonly hasKey = computed(() => this.selected()?.auth?.key !== false);
  protected readonly canConnect = computed(() =>
    !this.busy() &&
    this.selected() !== undefined &&
    this.hasKey() &&
    this.formKey().trim().length > 0,
  );
  protected readonly canSave = computed(() =>
    !this.busy() &&
    /^[a-z0-9][a-z0-9-_]*$/.test(this.formId().trim()) &&
    /^https?:\/\//.test(this.formBaseURL().trim()) &&
    this.customModels().some((row) => row.id.trim().length > 0),
  );

  constructor() {
    this.engine.set(this.morse.engine() ?? this.engines()[0]?.kind ?? 'pi');
    void this.refresh();
    this.morse.onTerminalExit((event) => {
      if (event.terminalId.startsWith('provider-')) {
        void this.refresh();
        this.morse.refreshModels();
      }
    });
    this.morse.onProvidersChanged((event) => {
      // The message names the engine whose files changed; only re-read that
      // grid. A stale detail would otherwise keep showing "Connected".
      if (event.engine.length === 0 || event.engine === this.engine()) {
        void this.refresh();
      }
      this.morse.refreshModels();
    });
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const engine = this.engine();
      const answer = await this.morse.requestHostCommand('providerStatus', { engine });
      if (this.engine() !== engine) {
        return; // The reader switched engines while the host answered.
      }
      this.status.set(asProviderStatus(answer) ?? { engine, providers: [], issues: [] });
      // A detail page holds a copy of the old provider; replace it with the
      // freshly read one so disconnect/connect shows up immediately on Back.
      const current = this.selected();
      if (current !== undefined) {
        const fresh = this.status()!.providers.find((one) => one.id === current.id);
        this.selected.set(fresh === undefined ? undefined : fresh);
      }
      const issues = this.status()?.issues ?? [];
      if (issues.length > 0) {
        this.error.set(issues.map((one) => one.message).join('\n'));
      }
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not load providers.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async switchEngine(engine: string): Promise<void> {
    this.engine.set(engine);
    this.status.set(undefined); // Do not show the previous engine's list as this one's.
    this.step.set('grid');
    this.selected.set(undefined);
    this.notice.set(null);
    await this.refresh();
    this.morse.refreshModels();
  }

  /**
   * Open a provider card. A custom endpoint has its own config in the engine —
   * base URL, API key and a full model list — so it goes to the editor, where
   * models can be discovered, added, removed and tuned. Built-ins just take a
   * key or the engine's TUI.
   */
  protected open(provider: ProviderInfo): void {
    if (provider.kind === 'custom') {
      this.editCustom(provider);
      return;
    }
    this.selected.set(provider);
    this.formKey.set('');
    this.error.set(null);
    this.notice.set(null);
    this.step.set('detail');
  }

  /** Sign in through the engine's own TUI, opened as a terminal in this GUI. */
  protected async signIn(provider: ProviderInfo): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const answer = await this.morse.requestHostCommand('providerLogin', {
        engine: this.engine(),
        providerId: provider.id,
      });
      const login = asProviderLogin(answer);
      if (!login.ok || login.terminalId === undefined) {
        this.error.set(login.message ?? `Could not open the ${provider.name} sign-in.`);
        return;
      }
      const pane = this.store.openForTerminal(login.terminalId, `Sign in: ${provider.name}`);
      this.panel.toggle('terminal');
      this.store.focus(pane.id);
      this.notice.set(`Finish signing in to ${provider.name} in the terminal below.`);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : `Could not open the ${provider.name} sign-in.`);
    } finally {
      this.busy.set(false);
    }
  }

  /** Save the pasted key straight into the selected engine's credential store. */
  protected async saveKey(): Promise<void> {
    const provider = this.selected();
    if (provider === undefined || !this.hasKey() || this.formKey().trim().length === 0) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const answer = await this.morse.requestHostCommand('providerConnect', {
        engine: this.engine(),
        providerId: provider.id,
        name: provider.name,
        key: this.formKey().trim(),
      });
      const result = asProviderMutation(answer);
      if (!result.ok) {
        this.error.set(result.message ?? 'Could not connect this provider.');
        return;
      }
      this.notice.set(result.message ?? `Connected ${provider.name}.`);
      this.formKey.set('');
      await this.refresh();
      this.morse.refreshModels();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not connect this provider.');
    } finally {
      this.busy.set(false);
    }
  }

  protected addCustom(): void {
    this.error.set(null);
    this.notice.set(null);
    this.editing.set(undefined);
    this.formId.set('');
    this.formName.set('');
    this.formBaseURL.set('');
    this.formApi.set('openai-completions');
    this.formKey.set('');
    this.customModels.set([{ id: '' }]);
    this.step.set('custom');
  }

  protected editCustom(provider: ProviderInfo): void {
    this.error.set(null);
    this.notice.set(null);
    this.editing.set(provider);
    this.formId.set(provider.id);
    this.formName.set(provider.name);
    this.formBaseURL.set(provider.baseURL ?? '');
    this.formApi.set(provider.api ?? 'openai-completions');
    this.formKey.set('');
    this.customModels.set((provider.models ?? []).map((model) => ({ ...model })));
    if (this.customModels().length === 0) {
      this.customModels.set([{ id: '' }]);
    }
    this.step.set('custom');
  }

  protected back(): void {
    this.step.set('grid');
    this.selected.set(undefined);
    this.editing.set(undefined);
    this.error.set(null);
    this.notice.set(null);
  }

  /** Ask the endpoint for its models and fill the editor with what it reports. */
  protected async discover(): Promise<void> {
    this.discovering.set(true);
    this.error.set(null);
    try {
      const answer = await this.morse.requestHostCommand('providerDiscover', {
        engine: this.engine(),
        baseURL: this.formBaseURL().trim(),
        ...(this.formKey().trim().length > 0 ? { key: this.formKey().trim() } : {}),
        api: this.formApi(),
      });
      const result = asProviderDiscover(answer);
      if (!result.ok) {
        this.error.set(result.message ?? 'The endpoint did not list its models.');
        return;
      }
      const found = result.models ?? [];
      if (found.length === 0) {
        this.error.set('The endpoint listed no models.');
        return;
      }
      this.customModels.set(found);
      this.notice.set(`Found ${found.length} models. Check each one’s limits and capabilities below.`);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Discovery failed.');
    } finally {
      this.discovering.set(false);
    }
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const models = this.customModels().filter((row) => row.id.trim().length > 0);
      const answer = await this.morse.requestHostCommand('providerConnect', {
        engine: this.engine(),
        providerId: this.formId().trim(),
        ...(this.formName().trim().length > 0 ? { name: this.formName().trim() } : {}),
        baseURL: this.formBaseURL().trim(),
        api: this.formApi(),
        models,
        ...(this.formKey().trim().length > 0 ? { key: this.formKey().trim() } : {}),
      });
      const result = asProviderMutation(answer);
      if (!result.ok) {
        this.error.set(result.message ?? 'Could not save this provider.');
        return;
      }
      this.notice.set(result.message ?? `Saved ${this.formName().trim() || this.formId().trim()}.`);
      this.step.set('grid');
      this.editing.set(undefined);
      await this.refresh();
      this.morse.refreshModels();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not save this provider.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async disconnect(provider: ProviderInfo): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const answer = await this.morse.requestHostCommand('providerDisconnect', {
        engine: this.engine(),
        providerId: provider.id,
      });
      const result = asProviderMutation(answer);
      if (!result.ok) {
        this.error.set(result.message ?? 'Could not disconnect this provider.');
        return;
      }
      this.notice.set(result.message ?? `Disconnected ${provider.name}.`);
      await this.refresh();
      this.morse.refreshModels();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not disconnect this provider.');
    } finally {
      this.busy.set(false);
    }
  }
}
