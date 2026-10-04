import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { ModelOption, PromptMode, ThinkingLevel } from '@morse/protocol';
import { promptTemplateForm, readPromptTemplate } from '@morse/ui-runtime';
import { AttachmentStore, type PendingImage, type PendingPin } from '../../core/attachments';
import { MorseService } from '../../core/morse.service';
import { ShellState } from '../../core/shell-state';
import { ShortcutService } from '../../core/shortcuts';
import { Uploader } from '../../core/uploads';
import { WorkspaceFiles } from '../../core/workspace-files';
import { WorkspaceTabs } from '../../core/workspace-tabs';
import { PopoverFit } from '../../core/popover-fit.directive';
import { EnterDirective } from '../../shared/enter.directive';
import { FilePicker, rankFiles } from '../file-picker/file-picker';
import { CommandPicker, rankPalette, type PaletteItem } from '../command-picker/command-picker';
import {
  PromptTemplateDialog,
  type PromptTemplateRequest,
} from '../prompt-template-dialog/prompt-template-dialog';
import { ModelPicker } from '../model-picker/model-picker';
import { ThinkingPicker } from '../thinking-picker/thinking-picker';
import { UsageIndicator } from '../usage/usage-indicator';

@Component({
  selector: 'morse-chat-composer',
  templateUrl: './chat-composer.html',
  imports: [
    EnterDirective,
    FilePicker,
    UsageIndicator,
    CommandPicker,
    ModelPicker,
    ThinkingPicker,
    PromptTemplateDialog,
    PopoverFit,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
        position: relative;
        padding: 10px;
      }
      .box {
        position: relative;
        container-type: inline-size;
        max-width: 780px;
        margin: 0 auto;
        border: 1px solid var(--morse-input-border);
        border-radius: var(--morse-radius-lg);
        background: var(--morse-input-bg);
        padding: 8px;
        transition: border-color 120ms ease;
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 2px 4px;
      }
      .toolbar .hint {
        font-size: 11.5px;
        color: var(--morse-fg-muted);
      }
      .icon {
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
      }
      .icon:hover:not(:disabled) {
        background: var(--morse-hover);
      }
      .icon:disabled {
        opacity: 0.4;
        cursor: default;
      }
      .icon.send {
        background: var(--morse-accent);
        border-color: var(--morse-accent);
        color: #fff;
        font-size: 15px;
      }
      .icon.stop {
        color: var(--morse-error);
        border-color: var(--morse-error);
      }
      .working {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 0 4px;
        font-size: 11.5px;
        color: var(--morse-fg-muted);
        white-space: nowrap;
      }
      .working .spinner {
        width: 11px;
        height: 11px;
        border-radius: 50%;
        border: 1.5px solid var(--morse-border);
        border-top-color: var(--morse-accent);
        animation: spin 0.8s linear infinite;
      }
      .working .dots {
        display: inline-flex;
        gap: 2px;
      }
      .working .dots i {
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background: currentColor;
        animation: dot 1.2s ease-in-out infinite;
      }
      .working .dots i:nth-child(2) {
        animation-delay: 0.15s;
      }
      .working .dots i:nth-child(3) {
        animation-delay: 0.3s;
      }
      .picker-host,
      .palette-host {
        position: absolute;
        left: 0;
        right: 0;
        bottom: calc(100% + 4px);
        z-index: 20;
      }
      .attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 0 2px 6px;
        padding: 0;
        list-style: none;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 220px;
        padding: 3px 4px 3px 3px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        background: var(--morse-hover);
        font-size: 11.5px;
      }
      .chip img {
        width: 22px;
        height: 22px;
        object-fit: cover;
        border-radius: var(--morse-radius-sm);
      }
      .chip-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        /*
         * All chips trim from the left, so a truncated path keeps its tail:
         * "…/vscode/selection-preview.ts" instead of a directory prefix that
         * no longer distinguishes anything. Workspace-relative paths are LTR,
         * so the bidi flip of this classic breadcrumb trick is safe.
         */
        direction: rtl;
        text-align: left;
      }
      .pin-icon {
        font-size: 12px;
        color: var(--morse-accent);
        line-height: 1;
      }
      .chip-lines {
        padding: 1px 5px;
        border-radius: var(--morse-radius-sm);
        background: var(--morse-hover);
        color: var(--morse-fg-muted);
        font-size: 10.5px;
        font-family: var(--morse-font-mono);
        white-space: nowrap;
      }
      .chip-remove {
        padding: 0 5px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        line-height: 1.4;
        cursor: pointer;
      }
      .chip-remove:hover {
        color: var(--morse-fg);
        background: var(--morse-active);
      }
      /*
       * The live selection chip is a preview, not a pin: no surface (a
       * filled chip would swallow the numbers' inset pill and read as one big
       * highlight), just a dashed accent outline meaning "still following the
       * editor". One visual layer, one alignment — nothing floats above it.
       */
      .chip.live {
        background: transparent;
        border: 1px dashed color-mix(in srgb, var(--morse-accent) 55%, transparent);
      }
      /*
       * A real <button>, so it is keyboard-reachable — and reset hard, at base
       * and in every state, because VS Code's injected vscode-default layer
       * paints buttons with the theme's accent background otherwise.
       */
      button.chip-body {
        display: inline-flex;
        align-items: center;
        align-self: stretch;
        gap: 6px;
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        border: 0;
        padding: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        line-height: inherit;
        text-align: left;
        cursor: pointer;
      }
      button.chip-body:hover,
      button.chip-body:active {
        background: color-mix(in srgb, var(--morse-accent) 12%, transparent);
      }
      button.chip-body:focus-visible {
        outline: 1px solid var(--morse-focus);
        outline-offset: -1px;
      }
      /*
       * The live numbers have an accent tint and no inset background, so they
       * sit on the same layer as the name — on locked chips the inset pill
       * stays, which is where it belongs.
       */
      .chip.live .chip-lines {
        padding: 0;
        background: transparent;
        color: color-mix(in srgb, var(--morse-accent) 70%, var(--morse-fg));
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes dot {
        0%,
        60%,
        100% {
          opacity: 0.25;
        }
        30% {
          opacity: 1;
        }
      }
      .box:focus-within {
        border-color: var(--morse-focus);
      }
      textarea {
        width: 100%;
        border: 0;
        background: transparent;
        resize: none;
        min-height: 44px;
        max-height: 220px;
        padding: 4px 6px;
        line-height: 1.5;
      }
      textarea:focus-visible {
        outline: none;
      }
      /*
       * The footer is a fixed scaffold: a shrinkable metrics group on the left
       * and a rigid action group on the right. Where the row breaks is decided
       * by the container width (see the @container rules at the end), never by
       * the width of a model name or a live token counter — that is what used
       * to rewrap the row mid-run and make the controls jump lines.
       */
      .controls {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: nowrap;
        margin-top: 6px;
      }
      .controls-metrics {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1 1 auto;
        flex-wrap: nowrap;
      }
      .controls-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
        margin-left: auto;
        white-space: nowrap;
      }
      /*
       * Row 1 is status only: live throughput on the left, run progress and the
       * context indicator on the right. Row 2 stays pure controls (dropdowns +
       * send/steer), so the buttons never move around while the numbers tick.
       */
      .status-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        margin-top: 6px;
      }
      .status-live,
      .status-end {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .status-live {
        flex: 0 1 auto;
      }
      .status-end {
        flex: 0 0 auto;
      }
      /*
       * The model trigger replaces a native <select>, whose flat list hid which
       * provider a model belongs to. It opens the grouped, searchable picker.
       */
      .model-button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: 0 1 auto;
        min-width: 0;
        max-width: 240px;
        padding: 4px 8px;
        border: 1px solid var(--morse-input-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-input-bg);
        color: var(--morse-input-fg);
        font-size: 12px;
        cursor: pointer;
      }
      .model-button:hover:not(:disabled) {
        border-color: var(--morse-fg-muted);
      }
      .model-button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .model-button .provider {
        flex: none;
        max-width: 90px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 1px 5px;
        border-radius: var(--morse-radius-sm);
        background: var(--morse-hover);
        color: var(--morse-fg-muted);
        font-size: 9.5px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .model-button .label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .model-button .caret {
        flex: none;
        color: var(--morse-fg-muted);
        font-size: 10px;
      }
      .model-picker-host {
        position: absolute;
        left: 0;
        bottom: calc(100% + 4px);
        z-index: 20;
        width: min(360px, 100%);
      }
      .hint {
        font-size: 11px;
        white-space: nowrap;
      }
      .throughput {
        color: var(--morse-accent);
        font-family: var(--morse-font-mono);
        font-variant-numeric: tabular-nums;
      }
      /*
       * Responsive but deterministic: each breakpoint is pinned to the box
       * width so the same width always gives the same layout. Status metrics
       * live on their own row now, so they are only dropped when the box is
       * genuinely too narrow — a ~580px composer has room for the live rate.
       */
      @container (max-width: 380px) {
        .usage-host {
          display: none;
        }
      }
      @container (max-width: 460px) {
        .controls {
          flex-wrap: wrap;
        }
        .controls-actions {
          flex: 1 1 100%;
          justify-content: flex-end;
        }
      }
      @container (max-width: 360px) {
        .thinking-host {
          display: none;
        }
      }
    `,
  ],
})
export class ChatComposer {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly shortcuts = inject(ShortcutService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly attachments = inject(AttachmentStore);
  private readonly workspace = inject(WorkspaceFiles);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly uploads = inject(Uploader);
  private readonly promptInput = viewChild<ElementRef<HTMLTextAreaElement>>('promptInput');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  protected readonly text = signal('');
  protected readonly connected = computed(() => this.morse.connection() === 'ready');
  protected readonly agentReady = this.morse.agentReady;
  protected readonly agentStarting = this.morse.agentStarting;
  protected readonly agentError = this.morse.agentError;
  protected readonly streaming = computed(() => this.morse.state().streaming);
  /**
   * Sending works as soon as the handshake is done. Without a session
   * (`autoOpen: false`) the host lazily opens one on the first prompt, so
   * "agent not ready yet" must not block the composer. Only a spawn failure
   * does: that is when the banner offers Retry instead.
   */
  protected readonly canSend = computed(
    () => this.connected() && !this.agentStarting() && this.agentError() === undefined,
  );
  protected readonly canAttachSelection = computed(
    () => this.morse.capabilities()?.editorContext === true,
  );
  protected readonly thinkingLevel = computed(() => this.morse.state().thinkingLevel);
  protected readonly models = this.morse.availableModels;
  protected readonly levels = this.morse.availableThinkingLevels;
  protected readonly modelKey = computed(() => {
    const model = this.morse.state().model;
    return model ? `${model.provider}/${model.id}` : '';
  });
  protected readonly usageState = this.morse.state;
  protected readonly showUsage = computed(() => {
    const state = this.morse.state();
    return state.usage !== undefined || state.contextUsage !== undefined;
  });
  /**
   * The composer's status strip, above the dropdowns. It only takes a row when
   * it has something to say: live throughput / run progress while working, or
   * the context indicator once usage is known.
   */
  protected readonly showStatusRow = computed(
    () => this.running() || this.showUsage(),
  );
  /**
   * Estimated output tokens generated so far in the current run: assistant prose
   * plus the thinking it streamed. Counting only the visible answer is what made
   * the rate look far too slow on a reasoning model.
   */
  protected readonly streamedTokens = computed(() =>
    Math.round(Math.max(0, outputChars(this.morse.items()) - this.baseline()) / 4),
  );
  /** Live streaming throughput, sampled over a short rolling window. */
  protected readonly tokensPerSecond = signal<number | undefined>(undefined);
  /** Output characters already present when the run started. */
  private readonly baseline = signal(0);
  private readonly throughput: { at: number; chars: number }[] = [];

  /** Live run indicator: "Working * 3s". */
  /** Files waiting to ride with the next prompt. */
  protected readonly images = this.attachments.images;
  /** Selections/files pinned to the next prompt; they are already locked. */
  protected readonly pins = this.attachments.pins;

  /**
   * Clicking a pinned chip re-opens its file in the browser preview, where the
   * highlighted range can be dragged to edit it. VS Code has no preview — its
   * own editor is already where a selection came from.
   */
  protected openPinPreview(pin: PendingPin): void {
    if (this.morse.capabilities()?.filePreview) {
      this.tabs.openMentionFile(pin.path);
    }
  }

  /**
   * The editor selection the host reports live: it is unlocked until the user
   * clicks it, which pins it. A payload without lines means the selection is
   * gone, and the chip goes with it.
   */
  protected readonly livePreview = this.attachments.livePreview;
  /** Entry animation offset for the locked chips that come after the live one. */
  protected readonly chipOffset = computed(() => (this.livePreview() ? 1 : 0));
  /** What clicking the live chip does, spelled out in its tooltip. */
  protected readonly lockLiveLabel = computed(() => {
    const live = this.livePreview();
    return live
      ? `Lock this selection — it stops following the editor; a new selection makes a new chip.`
      : '';
  });
  /** The file picker: the way to attach files in a host without drag and drop. */
  protected readonly pickerOpen = signal(false);
  protected readonly workspaceFiles = this.workspace.files;
  protected readonly loadingFiles = this.workspace.busy;
  /** Set when the picker was opened by typing `@`, so the pick lands inline. */
  private readonly mentionMode = signal(false);
  protected readonly pickerFilter = signal('');
  /** Ranked rows for the open mention picker; the composer owns the keyboard. */
  protected readonly pickerMatches = computed(() =>
    rankFiles(this.workspaceFiles(), this.pickerFilter()),
  );
  protected readonly mentionActive = signal(0);
  protected readonly canPickFiles = this.workspace.available;
  /** The host can take a file the browser read and store it on its own disk. */
  protected readonly canUpload = this.uploads.available;
  /**
   * The slash palette: Morse built-ins merged with pi's `get_commands` list.
   * `paletteFilter` mirrors the text typed after `/`.
   */
  protected readonly paletteOpen = signal(false);
  protected readonly paletteFilter = signal('');
  protected readonly paletteActive = signal(0);
  /**
   * The argument form for a prompt template, when the palette picked one that
   * declares arguments. Undefined means no form is open.
   */
  protected readonly templateRequest = signal<PromptTemplateRequest | undefined>(undefined);
  protected readonly availableCommands = this.morse.availableCommands;
  /** Rows for the open palette, already ranked; the composer owns the keyboard. */
  protected readonly paletteItems = computed<PaletteItem[]>(() => {
    const commands: PaletteItem[] = [
      ...BUILTIN_COMMANDS.map((command) => ({
        id: `builtin:${command.name}`,
        label: `/${command.name}`,
        description: command.description,
        badge: 'built-in',
        icon: '›',
      })),
      ...this.availableCommands().map((command) => ({
        id: `command:${command.name}`,
        label: `/${command.name}`,
        description: command.description,
        badge: command.source,
        icon: '⁄',
      })),
    ];
    return rankPalette(commands, this.paletteFilter());
  });

  /** The model chooser popover; `/model` and the footer trigger share it. */
  protected readonly modelPickerOpen = signal(false);
  protected readonly currentModel = this.morse.model;
  /**
   * The provider of the active model. Two providers can expose a model with the
   * same display name, so the footer shows where it came from — otherwise the
   * user has no way to tell which provider a pick landed on.
   */
  protected readonly currentProvider = computed(() => this.morse.model()?.provider ?? '');
  /** Full `provider · name` label for the trigger's tooltip. */
  protected readonly modelLabel = computed(() => {
    const model = this.morse.model();
    return model ? `${model.provider} · ${model.name}` : 'no model';
  });
  protected readonly canAddFiles = computed(
    () => this.canPickFiles() || this.canUpload() || this.canAttachSelection(),
  );

  /** What the `+` button will do, so its tooltip tells the truth. */
  protected readonly addFilesLabel = computed(() =>
    this.canPickFiles()
      ? 'Add files to the prompt'
      : this.canUpload()
        ? 'Upload files to the prompt'
        : 'Attach the active editor selection',
  );

  protected readonly running = computed(
    () => this.morse.state().streaming || this.morse.state().busy,
  );
  protected readonly elapsed = computed(() => {
    this.tick();
    const start = this.startedAt();
    const ms = start === null ? 0 : Date.now() - start;
    // Stay quiet for the first second; "0ms" would only flicker.
    return ms < 1000 ? '' : formatDuration(ms);
  });

  private readonly startedAt = signal<number | null>(null);
  private readonly tick = signal(0);

  constructor() {
    // The model chooser is this component's state, so this is where its shortcut
    // is bound. Nothing to choose means nothing to open, and the help dialog
    // says so instead of offering a key that does nothing.
    const unbind = this.shortcuts.bind(
      'model.pick',
      () => this.toggleModelPicker(),
      () => this.models().length > 0,
    );
    this.destroyRef.onDestroy(unbind);

    // A dropped file becomes an `@mention` in the text, so the user can still
    // edit what is about to be sent instead of it being sent behind their back.
    effect(() => {
      const mentions = this.attachments.mentions();
      if (mentions.length === 0) {
        return;
      }
      const added = this.attachments.takeMentions();
      const block = added.map((path) => (path.startsWith('@') ? path : `@${path}`)).join('\n');
      this.text.update((value) => (value.trim().length === 0 ? block : `${value.trimEnd()}\n${block}`));
      const input = this.promptInput()?.nativeElement;
      input?.focus();
    });

    // Selections the host pinned itself (the title-bar attach command) land in
    // the same strip an in-composer pin would, so there is one flow, not two.
    this.morse.onContextSelection((pin) => {
      this.attachments.pin(pin);
      this.attachments.say('info', 'Selection pinned to this message.');
    });

    // Live selection previews arrive continuously while the user drags; the
    // store deduplicates field-by-field, so identical updates never re-render.
    this.morse.onContextSelectionLive((preview) => this.attachments.setLivePreview(preview));

    // A fork hands the forked prompt back: the text lands in the editor and its
    // attachments in the strip, so the user continues the new branch without
    // retyping what they branched from.
    this.morse.onComposerSeed((seed) => {
      this.text.set(seed.text);
      this.syncInputValue();
      this.attachments.seed(seed.images ?? [], seed.pins ?? []);
    });

    effect((onCleanup) => {
      if (!this.running()) {
        this.startedAt.set(null);
        this.tokensPerSecond.set(undefined);
        this.throughput.length = 0;
        return;
      }
      this.startedAt.update((value) => value ?? Date.now());
      // Count growth from this point on. Reading `items()` untracked keeps this
      // effect tied to the run state, and a baseline makes the figure survive a
      // new assistant message mid-turn instead of resetting to zero.
      this.baseline.set(untracked(() => outputChars(this.morse.items())));
      const handle = setInterval(() => {
        this.tick.update((value) => value + 1);
        this.sampleThroughput();
      }, 500);
      onCleanup(() => clearInterval(handle));
    });
  }

  protected onInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.text.set(target.value);
    this.refreshMentionQuery(target.value, target.selectionStart);
    this.refreshPaletteQuery(target.value, target.selectionStart);
  }

  protected onKeydown(event: KeyboardEvent): void {
    // While the slash palette is open it owns the navigation keys. Enter runs the
    // highlighted row, Tab inserts it, and Escape puts the token back the way it
    // was — the caret itself never leaves the prompt.
    if (this.paletteOpen()) {
      const items = this.paletteItems();
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          this.onPaletteClose();
          return;
        case 'ArrowDown':
          event.preventDefault();
          this.paletteActive.update((index) => Math.min(index + 1, Math.max(0, items.length - 1)));
          return;
        case 'ArrowUp':
          event.preventDefault();
          this.paletteActive.update((index) => Math.max(0, index - 1));
          return;
        case 'Tab': {
          const chosen = items[this.paletteActive()];
          event.preventDefault();
          if (chosen) {
            this.activatePalette(chosen.id, 'insert');
          }
          return;
        }
        case 'Enter': {
          if (event.isComposing) {
            return;
          }
          const chosen = items[this.paletteActive()];
          if (chosen) {
            event.preventDefault();
            this.activatePalette(chosen.id, event.shiftKey ? 'insert' : 'run');
            return;
          }
          // No match: fall through so Enter still sends whatever was typed.
          break;
        }
        default:
          return;
      }
    }
    // While the mention picker is open it consumes the navigation keys, but the
    // caret stays in the prompt — so `@query` is typed here, not in the popup.
    if (this.pickerOpen()) {
      const items = this.pickerMatches();
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          this.onPickerClose();
          return;
        case 'ArrowDown':
          event.preventDefault();
          this.mentionActive.update((index) => Math.min(index + 1, Math.max(0, items.length - 1)));
          return;
        case 'ArrowUp':
          event.preventDefault();
          this.mentionActive.update((index) => Math.max(0, index - 1));
          return;
        case 'Tab':
        case 'Enter': {
          const chosen = items[this.mentionActive()];
          if (chosen) {
            event.preventDefault();
            this.onPickFile(chosen);
            return;
          }
          // No match: Enter still sends, Tab stays inert.
          if (event.key === 'Tab') {
            event.preventDefault();
          }
          return;
        }
        default:
          return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.sendWith(this.streaming() ? 'steer' : 'new');
    }
  }

  protected sendWith(mode: PromptMode): void {
    const value = this.text().trim();
    // `/compact <instructions>` is the same destructive action as the bare built-in,
    // only with the user's words attached — it must not slip past the confirmation by
    // riding along as a prompt.
    const instructions = compactInstructions(value);
    if (instructions !== undefined) {
      this.text.set('');
      this.shell.requestCompact(instructions);
      return;
    }
    // A bare built-in (`/new`, `/compact`, `/settings`, `/model`) is an action,
    // not a prompt pi can run — the TUI keeps those commands out of the wire.
    const builtin = builtinName(value);
    if (builtin) {
      this.text.set('');
      this.runBuiltin(builtin);
      return;
    }
    const images = this.attachments.images();
    const pins = this.attachments.pins();
    if (value.length === 0 && images.length === 0 && pins.length === 0) {
      this.promptInput()?.nativeElement.focus();
      return;
    }
    // The prompt carries the user's words; images and pins go as attachments —
    // the agent gets an `@path` mention for a pin, never a copied blob. The
    // live preview is a preview only: unlocking it was never done, so a
    // selection that was shown but not locked does not ride along.
    this.morse.prompt(value, mode, this.attachments.takeImages(), this.attachments.takePins());
    this.attachments.setLivePreview(null);
    this.text.set('');
  }

  /** The live chip is a preview until clicked: locking pins its final numbers. */
  protected lockLive(): void {
    this.attachments.lockLivePreview();
    this.attachments.say('info', 'Selection locked to this message.');
  }

  /** Dismisses the unlocked preview; the next selection brings a new chip. */
  protected dismissLive(): void {
    this.attachments.setLivePreview(null);
  }

  /** Pasted screenshots are the fastest way in, so treat them like a drop. */
  protected onPaste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    void this.attachments.accept(files).then((report) => {
      if (report.attached > 0) {
        this.attachments.say(
          'info',
          `${report.attached} pasted image${report.attached === 1 ? '' : 's'} attached`,
        );
      }
    });
  }

  protected removeImage(id: string): void {
    this.attachments.remove(id);
  }

  protected removePin(id: string): void {
    this.attachments.removePin(id);
  }

  protected preview(image: PendingImage): string {
    return `data:${image.mimeType};base64,${image.data}`;
  }

  protected abort(): void {
    this.morse.abort();
  }

  /**
   * Pins the active editor selection as an attachment chip. The host only
   * reports; the chip rides with the next message as a `@path:start-end`
   * mention, exactly like a picked file would.
   */
  /**
   * The ⧉ shortcut and the live chip do the same thing — lock the current
   * selection — so when the host already streams the live preview there is no
   * round trip: locking what is on screen is instant. Only hosts without live
   * selection take the snapshot path.
   */
  protected attachSelection(): void {
    if (this.livePreview()) {
      this.lockLive();
      return;
    }
    void this.requestSelectionSnapshot().then((snapshot) => {
      if (!snapshot || snapshot.selection === undefined) {
        this.attachments.say('warn', 'Select some text in the editor first.');
        return;
      }
      const selection = snapshot.selection;
      this.attachments.pin({
        path: snapshot.path ?? '',
        startLine: selection.startLine,
        endLine: selection.endLine,
      });
      this.attachments.say('info', 'Selection pinned to this message.');
    });
  }

  /**
   * `+` does the host-appropriate thing: a workspace host opens the `@mention`
   * picker inline, a browser host opens the OS file dialog (a browser cannot hand
   * out a path, so the host stores the file and answers with a mention), and a
   * host with neither falls back to pinning the editor selection.
   */
  protected onAddFiles(): void {
    if (this.canPickFiles()) {
      this.openMentionPicker();
      return;
    }
    if (this.canUpload()) {
      this.fileInput()?.nativeElement.click();
      return;
    }
    this.attachSelection();
  }

  /**
   * Appends `@` and opens the picker, so filtering happens in the same box the
   * message is typed in.
   */
  private openMentionPicker(): void {
    if (this.pickerOpen()) {
      this.onPickerClose();
      return;
    }
    const value = this.text();
    const separator = value.length > 0 && !/\s$/.test(value) ? ' ' : '';
    this.text.set(`${value}${separator}@`);
    const input = this.promptInput()?.nativeElement;
    if (input) {
      // Angular updates `[value]` on the next change detection; the caret has to
      // move now, so the DOM value is set here too.
      const next = this.text();
      input.value = next;
      input.focus();
      input.setSelectionRange(next.length, next.length);
    }
    this.mentionMode.set(true);
    this.pickerFilter.set('');
    this.mentionActive.set(0);
    this.pickerOpen.set(true);
    this.workspace.ensureLoaded();
  }

  /** Native file dialog result: images ride as attachments, the rest is uploaded. */
  protected onFilesChosen(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    const files = Array.from(input?.files ?? []);
    if (input) {
      // Clear it so choosing the same file twice fires `change` again.
      input.value = '';
    }
    if (files.length === 0) {
      return;
    }
    void this.importFiles(
      files.filter((file) => file.type.startsWith('image/')),
      files.filter((file) => !file.type.startsWith('image/')),
    );
  }

  private async importFiles(images: File[], others: File[]): Promise<void> {
    const report = await this.attachments.accept(images);
    const uploaded =
      others.length > 0 ? await this.uploads.upload(others) : { added: [], failed: [] };
    this.attachments.addMentions(uploaded.added.map((file) => file.path));

    const parts: string[] = [];
    if (report.attached > 0) {
      parts.push(`${report.attached} image${report.attached === 1 ? '' : 's'} attached`);
    }
    if (uploaded.added.length > 0) {
      parts.push(`${uploaded.added.length} file${uploaded.added.length === 1 ? '' : 's'} uploaded`);
    }
    const failed = [...report.skipped, ...uploaded.failed];
    if (failed.length > 0) {
      parts.push(`could not attach ${failed.join(', ')}`);
    }
    if (parts.length > 0) {
      const nothingWorked = report.attached === 0 && uploaded.added.length === 0;
      this.attachments.say(nothingWorked ? 'warn' : 'info', parts.join(' · '));
    }
  }

  /**
   * Typing `@` opens the same picker, filtered by what follows it — the hint in
   * the toolbar promises this, so it has to work.
   */
  private refreshMentionQuery(value: string, caret: number | null): void {
    if (!this.canPickFiles()) {
      return;
    }
    const before = value.slice(0, caret ?? value.length);
    const match = /(?:^|\s)@([\w./-]*)$/.exec(before);
    if (!match) {
      if (this.mentionMode()) {
        this.pickerOpen.set(false);
        this.mentionMode.set(false);
      }
      return;
    }
    // The query changed, so the highlight starts over at the top hit.
    if (match[1] !== this.pickerFilter()) {
      this.mentionActive.set(0);
    }
    this.mentionMode.set(true);
    this.pickerFilter.set(match[1] ?? '');
    this.pickerOpen.set(true);
    this.workspace.ensureLoaded();
  }

  /**
   * Typing `/` at the start of a line opens the command palette, filtered by the
   * token that follows — the toolbar hint promises it. Built-ins and pi's own
   * commands share one list; Enter runs, Tab inserts.
   */
  private refreshPaletteQuery(value: string, caret: number | null): void {
    const before = value.slice(0, caret ?? value.length);
    const match = /(?:^|\n)\s*\/([\w:-]*)$/.exec(before);
    if (!match) {
      if (this.paletteOpen()) {
        this.paletteOpen.set(false);
      }
      return;
    }
    if (match[1] !== this.paletteFilter()) {
      this.paletteActive.set(0);
    }
    this.paletteFilter.set(match[1] ?? '');
    if (!this.paletteOpen()) {
      // pi caches prompt templates at spawn, so ask the host to re-read them the
      // moment the palette opens: a template added or edited since then is there
      // by the time the reader finishes typing.
      this.morse.refreshCommands();
    }
    this.paletteOpen.set(true);
  }

  /** Runs (`run`) or inserts (`insert`) the highlighted palette row. */
  protected activatePalette(id: string, intent: 'run' | 'insert'): void {
    if (id.startsWith('builtin:')) {
      const name = id.slice('builtin:'.length);
      if (name === 'model') {
        this.stripSlashToken();
        this.closePalette();
        this.openModelPicker();
        return;
      }
      this.stripSlashToken();
      this.closePalette();
      this.runBuiltin(name);
      return;
    }
    if (id.startsWith('command:')) {
      const name = id.slice('command:'.length);
      if (intent === 'run') {
        const command = this.availableCommands().find((candidate) => candidate.name === name);
        if (command?.template !== undefined) {
          const form = promptTemplateForm(command.template);
          if (form !== undefined) {
            // The template declares arguments: a bare `/name` would leave them
            // empty, so collect them — and any extra — in the form first.
            this.stripSlashToken();
            this.text.set('');
            this.closePalette();
            this.openTemplate({ name, description: command.description, form });
            return;
          }
          // No arguments to collect. Expand here as well instead of handing pi
          // `/name`: a template added after spawn is not in pi's cache, and an
          // edited body must reach the agent without a pi reload.
          this.stripSlashToken();
          this.text.set('');
          this.closePalette();
          this.sendTemplate(readPromptTemplate(command.template).body);
          return;
        }
        // No body to expand (the file could not be read): pi expands skills and
        // templates server-side, so the bare `/name` is the whole prompt; pending
        // attachments belong to the user's next one.
        this.stripSlashToken();
        this.text.set('');
        this.closePalette();
        this.morse.prompt(`/${name}`, this.streaming() ? 'steer' : 'new');
        return;
      }
      this.replaceSlashToken(`/${name} `);
      this.closePalette();
    }
  }

  /** Opens the argument form for a prompt template; the dialog owns the fields. */
  private openTemplate(request: PromptTemplateRequest): void {
    this.templateRequest.set(request);
    this.shell.setPromptTemplateOpen(true);
  }

  private closeTemplate(): void {
    this.templateRequest.set(undefined);
    this.shell.setPromptTemplateOpen(false);
    this.promptInput()?.nativeElement.focus();
  }

  /**
   * Sends a prompt template's expanded text with whatever was already attached.
   * Unlike `sendWith`, a body that starts with `/compact` is not mistaken for a
   * built-in — the text is the whole prompt, whatever it begins with.
   */
  private sendTemplate(text: string): void {
    this.morse.prompt(
      text,
      this.streaming() ? 'steer' : 'new',
      this.attachments.takeImages(),
      this.attachments.takePins(),
    );
    this.attachments.setLivePreview(null);
  }

  protected onTemplateSubmit(text: string): void {
    this.templateRequest.set(undefined);
    this.shell.setPromptTemplateOpen(false);
    this.sendTemplate(text);
  }

  /** Closing returns the keyboard to the prompt. */
  protected onPaletteClose(): void {
    this.closePalette();
  }

  private closePalette(): void {
    this.paletteOpen.set(false);
    this.paletteFilter.set('');
    this.paletteActive.set(0);
    this.promptInput()?.nativeElement.focus();
  }

  /** Opens the model chooser; `/model` and the footer trigger share it. */
  private openModelPicker(): void {
    this.modelPickerOpen.set(true);
  }

  protected toggleModelPicker(): void {
    this.modelPickerOpen.update((open) => !open);
  }

  protected onModelPick(model: ModelOption): void {
    this.morse.setModel(model.provider, model.id);
    this.closeModelPicker();
  }

  /** Closing returns the keyboard to the prompt, like the other popovers. */
  protected closeModelPicker(): void {
    this.modelPickerOpen.set(false);
    this.promptInput()?.nativeElement.focus();
  }

  /** The built-ins pi keeps in its TUI, wired to Morse's native actions. */
  private runBuiltin(name: string): void {
    switch (name) {
      case 'new':
        this.tabs.startDraft(this.morse.workspace().cwd);
        break;
      case 'compact':
        // Asked for, not done: `/compact` opens the same confirmation as the
        // header button, because a typo in the prompt should not summarize a
        // conversation on its own.
        this.shell.requestCompact();
        break;
      case 'settings':
        this.morse.hostCommand('openSettings');
        break;
      case 'model':
        this.openModelPicker();
        break;
      case 'about':
        this.shell.openAbout();
        break;
      case 'keys':
        this.shell.openShortcuts();
        break;
    }
  }

  /** Removes the trailing `/command` token the palette opened on. */
  private stripSlashToken(): void {
    this.text.update((value) => value.replace(/(?:^|\n)(\s*)\/[\w:-]*$/, '$1'));
    this.syncInputValue();
  }

  private replaceSlashToken(replacement: string): void {
    this.text.update((value) => value.replace(/(?:^|\n)(\s*)\/[\w:-]*$/, `$1${replacement}`));
    this.syncInputValue();
  }

  private syncInputValue(): void {
    const input = this.promptInput()?.nativeElement;
    if (!input) {
      return;
    }
    const next = this.text();
    input.value = next;
    input.focus();
    input.setSelectionRange(next.length, next.length);
  }

  /** Forced refresh: the host may have indexed nothing the first time. */
  protected reloadFiles(): void {
    this.workspace.ensureLoaded(true);
  }

  /** Reads the editor snapshot; `undefined` when the host cannot report it. */
  private async requestSelectionSnapshot() {
    return this.morse.requestHostCommand('getEditorContext') as Promise<
      | {
          path?: string;
          languageId?: string;
          selection?: { startLine: number; endLine: number; text: string };
          openEditors: string[];
        }
      | undefined
    >;
  }

  /**
   * A pin's range label: `L13-17` for a range, `L13` for a single line. A
   * single-line pin has no `endLine`, which must not read as "L13-".
   */
  protected pinRange(pin: Pick<PendingPin, 'startLine' | 'endLine'>): string {
    if (pin.startLine === undefined) {
      return '';
    }
    return pin.endLine !== undefined && pin.endLine !== pin.startLine
      ? `L${pin.startLine}-${pin.endLine}`
      : `L${pin.startLine}`;
  }

  /** Closing the picker returns the keyboard to the prompt. */
  protected onPickerClose(): void {
    this.pickerOpen.set(false);
    this.mentionMode.set(false);
    this.promptInput()?.nativeElement.focus();
  }

  /**
   * A picked file becomes an `@mention`, like a dropped one. A picked directory
   * is pi's own drill-down: `@docs/` stays in the prompt and the picker stays
   * open, now filtered to that folder, so Enter then walks the tree.
   */
  protected onPickFile(path: string): void {
    const directory = path.endsWith('/');
    if (this.mentionMode()) {
      // Replace the `@query` the user typed instead of appending a second mention.
      // A directory keeps its trailing `/` and gets no space, so it stays a prefix.
      this.text.update((value) => value.replace(/@[\w./-]*$/, `@${path}${directory ? '' : ' '}`));
    } else if (!directory) {
      this.attachments.addMentions([path]);
      this.attachments.say('info', `Pinned ${path} to this message.`);
    }
    // On the browser host, picking a file also opens it so the user can drag a
    // line range into the prompt; it lands in the mention row. VS Code has no
    // preview and opens its own editor.
    if (!directory && this.morse.capabilities()?.filePreview) {
      this.tabs.openMentionFile(path);
    }
    if (directory) {
      // Stay open on the folder we just entered; typing keeps narrowing it.
      this.mentionMode.set(true);
      this.pickerFilter.set(path);
      this.mentionActive.set(0);
      this.pickerOpen.set(true);
      this.workspace.ensureLoaded();
    } else {
      this.mentionMode.set(false);
      this.pickerOpen.set(false);
    }
    this.syncInputValue();
  }

  protected onThinkingPick(level: ThinkingLevel): void {
    this.morse.setThinkingLevel(level);
  }

  /**
   * Samples total output characters every 500ms and reports the rate over a
   * ~2s window. A monotonic counter (never "characters of the streaming
   * message") means a new assistant message mid-turn cannot make the rate
   * collapse to zero, and thinking counts as output because that is what the
   * provider is actually generating.
   */
  private sampleThroughput(): void {
    const chars = outputChars(this.morse.items());
    const now = Date.now();
    this.throughput.push({ at: now, chars });
    while (this.throughput.length > 2 && now - this.throughput[0].at > 2_000) {
      this.throughput.shift();
    }
    const first = this.throughput[0];
    if (!first) {
      return;
    }
    const elapsed = now - first.at;
    if (elapsed < 500) {
      return;
    }
    const tokens = (chars - first.chars) / 4;
    // A stalled stream decays to zero instead of freezing the last figure.
    this.tokensPerSecond.set(Math.max(0, Math.round((tokens / elapsed) * 10_000) / 10));
  }
}

/**
 * Built-ins pi only serves in its TUI. They are not in `get_commands` (pi would
 * not execute them over RPC), so the composer offers them itself and maps each
 * to the matching native action.
 */
const BUILTIN_COMMANDS = [
  { name: 'model', description: 'Select a model' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Compact the current context (asks first)' },
  { name: 'settings', description: 'Open Morse settings' },
  { name: 'about', description: 'Credits and licences' },
  { name: 'keys', description: 'Keyboard shortcuts' },
] as const;

/** A prompt that is exactly one built-in command, e.g. `/compact`. */
export function builtinName(value: string): string | undefined {
  const match = /^\/([\w-]+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  return BUILTIN_COMMANDS.some((command) => command.name === match[1]) ? match[1] : undefined;
}

/**
 * `/compact <instructions>`: the command plus what to keep. The instructions are
 * forwarded to pi, so the user's words are not lost — only the *execution* waits
 * for the confirmation dialog, which is the same gate the bare command uses.
 */
export function compactInstructions(value: string): string | undefined {
  const match = /^\/compact\s+([\s\S]+)$/.exec(value);
  return match?.[1]?.trim() || undefined;
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/**
 * Output characters the agent has produced so far: assistant prose plus the
 * thinking it streamed. Both are generated tokens, so the rate must count both —
 * a reasoning model spends most of its output on thinking. Counting the whole
 * transcript (not just the item that is currently streaming) keeps the figure
 * monotonic while a turn moves from one assistant message to the next.
 */
export function outputChars(
  items: readonly { kind: string; text?: string; thinking?: string }[],
): number {
  let total = 0;
  for (const item of items) {
    if (item.kind === 'assistant') {
      total += (item.text ?? '').length + (item.thinking ?? '').length;
    }
  }
  return total;
}
