import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toObservable, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { PromptScope, PromptTemplateInfo } from '@morse/protocol';
import {
  parseCommandArgs,
  promptTemplateArgumentFields,
  substituteArgs,
  type PromptTemplateArgument,
} from '@morse/ui-runtime';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import { PromptTemplatesState } from '../../core/prompt-templates-state';
import { MorseService } from '../../core/morse.service';
import { ViewState } from '../../core/view-state';
import { renderPromptTemplate } from './render';

type TestMode = 'fields' | 'raw';

/** What the editor restores after a reload, so a refresh never eats a draft. */
interface PromptEditorDraft {
  name: string;
  description: string;
  hint: string;
  body: string;
  scope: PromptScope;
  originalName?: string;
  originalScope?: PromptScope;
  mode: TestMode;
  fieldValues: Record<string, string>;
  rawArgs: string;
}

const DRAFT_KEY = 'prompt-editor';

/**
 * The prompt-template editor: browse, write, and test the `.md` files pi turns
 * into `/commands`.
 *
 * pi's templates are more than a body: frontmatter names and describes them,
 * `argument-hint` declares the fields, and the body may reference `$1`,
 * `${1:-default}`, `$@`, `${@:2}` and `${@:2:3}`. The tester expands the body
 * against sample arguments with the same code the composer uses
 * (`ui-runtime/prompt-template`), so what the preview shows is exactly what the
 * agent would receive — defaults included.
 *
 * It lives in a tab (the browser host) or in its own VS Code editor panel — like
 * the MCP editor — never in a modal over the chat. `app.ts` mounts it lazily when
 * its tab comes forward; the host commands (`promptTemplates`,
 * `promptTemplateSave`, `promptTemplateDelete`) do the file I/O.
 */
@Component({
  selector: 'morse-prompt-editor',
  templateUrl: './prompt-editor.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--morse-bg);
      }
      .page {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }
      .head {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 12px 18px;
        border-bottom: 1px solid var(--morse-border);
      }
      .title {
        min-width: 0;
      }
      h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      .dirs {
        display: flex;
        flex-wrap: wrap;
        gap: 2px 16px;
        margin: 3px 0 0;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .dirs code {
        font-family: var(--morse-font-mono);
        font-size: 10.5px;
        overflow-wrap: anywhere;
      }
      .body {
        display: grid;
        grid-template-columns: minmax(200px, 268px) 1fr;
        flex: 1;
        min-height: 0;
      }
      .sidebar {
        display: flex;
        flex-direction: column;
        min-height: 0;
        border-right: 1px solid var(--morse-border);
      }
      .sidebar-head {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px;
        border-bottom: 1px solid var(--morse-border);
      }
      .new {
        width: 100%;
        padding: 6px 10px;
        text-align: center;
      }
      .filter {
        width: 100%;
        padding: 5px 8px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-input-bg, transparent);
        color: var(--morse-fg);
        font: inherit;
        font-size: 12px;
      }
      .filter:focus {
        outline: none;
        border-color: var(--morse-accent);
      }
      .list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        margin: 0;
        padding: 6px;
        list-style: none;
      }
      .list button {
        display: flex;
        flex-direction: column;
        gap: 3px;
        width: 100%;
        padding: 7px 9px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        text-align: left;
        cursor: pointer;
      }
      .list button:hover:not(:disabled) {
        background: var(--morse-hover);
      }
      .list button.active {
        background: var(--morse-active);
      }
      .row-name {
        font-family: var(--morse-font-mono);
        font-size: 12px;
      }
      .row-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        color: var(--morse-fg-muted);
        font-size: 10.5px;
      }
      .row-hint {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .badge {
        flex: none;
        padding: 0 6px;
        border-radius: 999px;
        background: var(--morse-badge-bg);
        color: var(--morse-badge-fg);
        font-size: 10px;
      }
      .badge.broken {
        background: color-mix(in srgb, var(--morse-error) 25%, var(--morse-badge-bg));
        color: var(--morse-error);
      }
      .empty {
        padding: 12px 8px;
        color: var(--morse-fg-muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .editor {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .editor-scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 16px 18px 20px;
      }
      .notice {
        display: flex;
        gap: 8px;
        margin: 0 0 10px;
        padding: 8px 11px;
        border-left: 3px solid var(--morse-warn);
        border-radius: var(--morse-radius-sm);
        background: color-mix(in srgb, var(--morse-warn) 9%, transparent);
        color: var(--morse-fg);
        font-size: 11.5px;
        line-height: 1.5;
      }
      .notice.muted {
        border-left-color: var(--morse-border);
        background: var(--morse-hover);
        color: var(--morse-fg-muted);
      }
      .notice code {
        font-family: var(--morse-font-mono);
      }
      .fields {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .row {
        display: flex;
        align-items: flex-end;
        gap: 12px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .grow {
        flex: 1;
        min-width: 0;
      }
      .scope-field {
        flex: none;
      }
      .field-label {
        color: var(--morse-fg-muted);
        font-size: 11px;
        font-weight: 600;
      }
      input,
      textarea {
        width: 100%;
        padding: 6px 9px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-input-bg, var(--morse-bg));
        color: var(--morse-fg);
        font-family: inherit;
        font-size: 12.5px;
        resize: vertical;
      }
      textarea.mono {
        font-family: var(--morse-font-mono);
        line-height: 1.55;
      }
      input:focus,
      textarea:focus {
        outline: none;
        border-color: var(--morse-accent);
      }
      .segmented {
        display: inline-flex;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        overflow: hidden;
      }
      .segmented button {
        min-width: 66px;
        padding: 5px 12px;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 11.5px;
        cursor: pointer;
      }
      .segmented button.active {
        background: var(--morse-accent);
        color: var(--morse-accent-fg);
      }
      .segmented button:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .test {
        margin-top: 18px;
        padding-top: 14px;
        border-top: 1px solid var(--morse-border);
      }
      .test-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
      }
      .test-head .field-label {
        font-size: 12px;
      }
      .test-head .grow {
        flex: 1;
      }
      .arg-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 10px;
      }
      .default-hint {
        color: var(--morse-fg-muted);
        font-size: 10.5px;
      }
      .preview-label {
        display: block;
        margin-top: 10px;
      }
      pre.preview {
        margin: 6px 0 0;
        max-height: 240px;
        overflow: auto;
        padding: 9px 11px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-code-bg, rgb(0 0 0 / 18%));
        color: var(--morse-fg);
        font-family: var(--morse-font-mono);
        font-size: 11.5px;
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .cheat {
        margin-top: 12px;
        font-size: 11px;
        color: var(--morse-fg-muted);
      }
      .cheat summary {
        cursor: pointer;
        font-weight: 600;
      }
      .cheat table {
        margin-top: 6px;
        border-collapse: collapse;
      }
      .cheat td {
        padding: 2px 12px 2px 0;
        vertical-align: top;
      }
      .cheat code {
        font-family: var(--morse-font-mono);
        color: var(--morse-fg);
      }
      .required {
        margin-left: 4px;
        color: var(--morse-warn);
        font-size: 10.5px;
        font-weight: 400;
      }
      footer {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 18px;
        border-top: 1px solid var(--morse-border);
        background: var(--morse-panel, var(--morse-bg));
      }
      .status-row {
        font-size: 11.5px;
        color: var(--morse-fg-muted);
        line-height: 1.5;
        overflow-wrap: anywhere;
      }
      .status-row.error {
        color: var(--morse-error);
      }
      .status-row.ok {
        color: var(--morse-success);
      }
      .actions-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .actions-row .grow {
        flex: 1;
      }
      button.danger {
        color: var(--morse-error);
        background: transparent;
        border-color: color-mix(in srgb, var(--morse-error) 40%, var(--morse-border));
      }
      button.danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--morse-error) 12%, transparent);
      }
      @media (max-width: 760px) {
        .body {
          grid-template-columns: 1fr;
        }
        .sidebar {
          max-height: 220px;
          border-right: 0;
          border-bottom: 1px solid var(--morse-border);
        }
      }
    `,
  ],
})
export class PromptEditor {
  private readonly store = inject(PromptTemplatesState);
  private readonly morse = inject(MorseService);
  private readonly viewState = inject(ViewState);
  private readonly card = viewChild<ElementRef<HTMLElement>>('card');

  protected readonly enabled = this.store.enabled;
  protected readonly templates = this.store.templates;
  protected readonly info = this.store.info;
  protected readonly loading = this.store.isLoading;
  /** A session is in front, so a project template has a directory to live in. */
  protected readonly hasProject = this.store.hasProject;

  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly hint = signal('');
  protected readonly body = signal('');
  protected readonly scope = signal<PromptScope>('global');
  protected readonly originalName = signal<string | undefined>(undefined);
  protected readonly originalScope = signal<PromptScope | undefined>(undefined);

  /** The sidebar filter: narrows the list to a name or description match. */
  protected readonly filter = signal('');
  protected readonly visibleTemplates = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    const all = this.templates();
    if (needle.length === 0) {
      return all;
    }
    return all.filter(
      (template) =>
        template.name.toLowerCase().includes(needle) ||
        (template.description ?? '').toLowerCase().includes(needle),
    );
  });

  protected readonly mode = signal<TestMode>('fields');
  protected readonly fieldValues = signal<Record<string, string>>({});
  protected readonly rawArgs = signal('');

  protected readonly saving = signal(false);
  protected readonly deleting = signal(false);
  protected readonly confirmingDelete = signal(false);
  /** The text as it was loaded or last saved, so `dirty` ignores file formatting. */
  private readonly savedRaw = signal<string | undefined>(undefined);
  protected readonly status = signal<{ kind: 'ok' | 'error' | 'muted'; text: string } | undefined>(
    undefined,
  );

  /**
   * The body and hint as the tester sees them: settled a beat after typing stops,
   * so parsing the placeholders does not run on every keystroke and the field
   * list does not flicker a half-typed `$` in and out. The rendered file and the
   * dirty check still read the signals directly — a save writes what was typed.
   */
  protected readonly settledBody = signal('');
  protected readonly settledHint = signal('');

  /** The fields the body currently references, labeled by the hint where it lines up. */
  protected readonly fields = computed(() =>
    promptTemplateArgumentFields(this.settledBody(), this.settledHint()),
  );

  /** The tester only appears once the settled body has something to preview. */
  protected readonly hasPreview = computed(() => this.settledBody().trim().length > 0);
  /** Whether the body references arguments, so the fields and their toggle are worth showing. */
  protected readonly hasFields = computed(() => this.fields().length > 0);

  /** The exact arguments the tester collected, in the mode it is showing. */
  private readonly testArgs = computed<string[]>(() => {
    if (this.mode() === 'raw') {
      return parseCommandArgs(this.rawArgs());
    }
    // Positional, not compacted: a body that skips `$2` still needs a hole there,
    // or `$3` would read the second input.
    const values = this.fieldValues();
    const args: string[] = [];
    for (const field of this.fields()) {
      if (field.index !== undefined) {
        args[field.index - 1] = (values[field.id] ?? '').trim();
      }
    }
    return args;
  });

  /** The prompt pi would expand to, using the same substitution the composer uses. */
  protected readonly preview = computed(() => substituteArgs(this.settledBody(), this.testArgs()));

  /** The file the editor would write, frontmatter and body. */
  protected readonly rendered = computed(() =>
    renderPromptTemplate({
      description: this.description(),
      argumentHint: this.hint(),
      body: this.body(),
    }),
  );

  protected readonly validName = computed(() =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(this.name().trim()),
  );

  protected readonly editingExisting = computed(() => this.originalName() !== undefined);

  /** The placeholder for the body field; a TS string, so its `${…}` never reads as ICU. */
  protected readonly bodyPlaceholder =
    'Review the staged changes. Focus on ${1:-correctness, security, and error handling}.';

  /** The substitution reference the editor prints, so the braces stay out of the template. */
  protected readonly cheatSheet: readonly { syntax: string; meaning: string }[] = [
    { syntax: '$1, $2 …', meaning: 'one positional argument' },
    { syntax: '${1:-fallback}', meaning: 'the argument, or a default when it is empty' },
    { syntax: '$@  /  $ARGUMENTS', meaning: 'every argument joined with spaces' },
    { syntax: '${@:-fallback}', meaning: 'every argument, or a default when there are none' },
    { syntax: '${@:2}', meaning: 'arguments from position 2 on' },
    { syntax: '${@:2:3}', meaning: 'three arguments starting at position 2' },
  ];

  /** A worked example of shell-like quoting, kept out of the template for the same reason. */
  protected readonly quoteExample = '/review "API compatibility"';

  protected readonly dirty = computed(() => {
    const saved = this.savedRaw();
    return saved === undefined ? this.hasDraft() : this.rendered() !== saved;
  });

  private hasDraft(): boolean {
    return (
      this.name().trim().length > 0 ||
      this.description().trim().length > 0 ||
      this.hint().trim().length > 0 ||
      this.body().trim().length > 0
    );
  }

  constructor() {
    // A reload (browser refresh, VS Code window reload) must not eat a
    // half-written template: hydrate the form first, then keep it current.
    const draft = this.viewState.read<PromptEditorDraft>(DRAFT_KEY);
    if (draft !== undefined) {
      if (typeof draft.name === 'string') this.name.set(draft.name);
      if (typeof draft.description === 'string') this.description.set(draft.description);
      if (typeof draft.hint === 'string') this.hint.set(draft.hint);
      if (typeof draft.body === 'string') this.body.set(draft.body);
      if (draft.scope === 'global' || draft.scope === 'project') this.scope.set(draft.scope);
      if (typeof draft.originalName === 'string') this.originalName.set(draft.originalName);
      if (draft.originalScope === 'global' || draft.originalScope === 'project') {
        this.originalScope.set(draft.originalScope);
      }
      if (draft.mode === 'raw' || draft.mode === 'fields') this.mode.set(draft.mode);
      if (isStringRecord(draft.fieldValues)) this.fieldValues.set(draft.fieldValues);
      if (typeof draft.rawArgs === 'string') this.rawArgs.set(draft.rawArgs);
    }
    // Seed from what was hydrated (or is empty), then let later typing settle.
    // Reading the signals after hydration avoids a blank tester on first paint.
    this.settledBody.set(this.body());
    this.settledHint.set(this.hint());
    toObservable(this.body)
      .pipe(debounceTime(200), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe((value) => this.settledBody.set(value));
    toObservable(this.hint)
      .pipe(debounceTime(200), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe((value) => this.settledHint.set(value));
    // The host may not have sent its capabilities yet when this mounts — a VS
    // Code panel boots the route before `host/ready`, so a one-shot check would
    // skip the load and leave the list empty. Wait for `enabled` to flip.
    effect(() => {
      if (!this.enabled()) {
        return;
      }
      untracked(() => {
        void this.store.refresh(true).then(() => {
          // With nothing loaded yet, open the first template so the editor is
          // never an empty form when the directory already has one.
          const first = this.templates()[0];
          if (first !== undefined && this.originalName() === undefined && !this.hasDraft()) {
            this.select(first);
          }
        });
      });
    });
    // Keep the list live: a template written by `vim`/`nano`, or saved from
    // another Morse surface, appears without reopening the editor.
    effect((onCleanup) => {
      if (!this.enabled()) {
        return;
      }
      const timer = setInterval(() => void this.store.refresh(false), 3_000);
      onCleanup(() => clearInterval(timer));
    });
    effect(() => {
      const draft: PromptEditorDraft = {
        name: this.name(),
        description: this.description(),
        hint: this.hint(),
        body: this.body(),
        scope: this.scope(),
        ...(this.originalName() !== undefined ? { originalName: this.originalName() } : {}),
        ...(this.originalScope() !== undefined ? { originalScope: this.originalScope() } : {}),
        mode: this.mode(),
        fieldValues: this.fieldValues(),
        rawArgs: this.rawArgs(),
      };
      this.viewState.write(DRAFT_KEY, draft);
    });
  }

  protected select(template: PromptTemplateInfo): void {
    this.name.set(template.name);
    this.description.set(template.description ?? '');
    this.hint.set(template.argumentHint ?? '');
    this.body.set(template.body);
    // A pick is not typing: show its fields and preview at once, not after the
    // debounce that exists for the reader's own keystrokes.
    this.settledHint.set(template.argumentHint ?? '');
    this.settledBody.set(template.body);
    this.scope.set(template.scope);
    this.originalName.set(template.name);
    this.originalScope.set(template.scope);
    this.fieldValues.set({});
    this.rawArgs.set('');
    this.savedRaw.set(this.rendered());
    this.status.set(template.error !== undefined ? { kind: 'error', text: template.error } : undefined);
    this.confirmingDelete.set(false);
  }

  protected newTemplate(scope: PromptScope): void {
    this.name.set('');
    this.description.set('');
    this.hint.set('');
    this.body.set('');
    this.settledHint.set('');
    this.settledBody.set('');
    this.scope.set(scope);
    this.originalName.set(undefined);
    this.originalScope.set(undefined);
    this.fieldValues.set({});
    this.rawArgs.set('');
    this.savedRaw.set(undefined);
    this.status.set(undefined);
    this.confirmingDelete.set(false);
    setTimeout(() => this.card()?.nativeElement.querySelector<HTMLElement>('#prompt-name')?.focus(), 0);
  }

  /** A brand-new template: project scope when a project is in front, else user. */
  protected newTemplateHere(): void {
    this.newTemplate(this.hasProject() ? 'project' : 'global');
  }

  protected setFilter(value: string): void {
    this.filter.set(value);
  }

  protected setName(value: string): void {
    this.name.set(value);
    this.status.set(undefined);
  }
  protected setDescription(value: string): void {
    this.description.set(value);
    this.status.set(undefined);
  }
  protected setHint(value: string): void {
    this.hint.set(value);
    this.status.set(undefined);
  }
  protected setBody(value: string): void {
    this.body.set(value);
    this.status.set(undefined);
  }
  protected setScope(value: string): void {
    this.scope.set(value === 'project' ? 'project' : 'global');
    this.status.set(undefined);
  }
  protected setMode(value: TestMode): void {
    this.mode.set(value);
  }
  protected setRawArgs(value: string): void {
    this.rawArgs.set(value);
  }
  protected setFieldValue(id: string, value: string): void {
    this.fieldValues.update((current) => ({ ...current, [id]: value }));
  }

  protected fieldValue(id: string): string {
    return this.fieldValues()[id] ?? '';
  }

  protected defaultHint(field: PromptTemplateArgument): string | undefined {
    return field.default !== undefined ? `default: ${field.default}` : undefined;
  }

  protected async save(): Promise<void> {
    if (this.saving() || this.deleting()) {
      return;
    }
    const name = this.name().trim();
    if (!this.validName()) {
      this.status.set({
        kind: 'error',
        text: 'Give the template a name (letters, digits, "_", "-", "."; no path).',
      });
      return;
    }
    if (this.body().trim().length === 0) {
      this.status.set({ kind: 'error', text: 'The template body is empty.' });
      return;
    }
    this.saving.set(true);
    const result = await this.store.save({
      name,
      scope: this.scope(),
      raw: this.rendered(),
      ...(this.originalName() !== undefined ? { originalName: this.originalName() } : {}),
      ...(this.originalScope() !== undefined ? { originalScope: this.originalScope() } : {}),
    });
    this.saving.set(false);
    if (result.ok) {
      this.originalName.set(name);
      this.originalScope.set(this.scope());
      this.savedRaw.set(this.rendered());
      this.status.set({ kind: 'ok', text: `Saved /${name}${result.path ? ` → ${result.path}` : ''}` });
      // A rename leaves the old row behind in the list until the refresh lands;
      // reloading keeps the sidebar honest.
      await this.store.refresh(true);
    } else {
      this.status.set({ kind: 'error', text: result.message ?? 'The host did not save the template.' });
    }
  }

  protected requestDelete(): void {
    if (!this.editingExisting()) {
      this.newTemplate(this.scope());
      return;
    }
    this.confirmingDelete.set(true);
  }

  protected cancelDelete(): void {
    this.confirmingDelete.set(false);
  }

  protected async confirmDelete(): Promise<void> {
    const name = this.originalName();
    const scope = this.originalScope();
    if (name === undefined || scope === undefined || this.deleting()) {
      return;
    }
    this.deleting.set(true);
    const result = await this.store.remove(name, scope);
    this.deleting.set(false);
    this.confirmingDelete.set(false);
    if (result.ok) {
      this.status.set({ kind: 'muted', text: `Deleted /${name}.` });
      this.newTemplate(scope);
    } else {
      this.status.set({ kind: 'error', text: result.message ?? 'The host did not delete the template.' });
    }
  }

  /** Copies the expanded prompt, so it can be pasted into any chat. */
  protected copyPreview(): void {
    this.morse.hostCommand('copyToClipboard', { text: this.preview() });
    this.status.set({ kind: 'ok', text: 'Preview copied.' });
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string')
  );
}
