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
import type { CommandOption, ModelOption, PromptMode, ThinkingLevel } from '@morse/protocol';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import {
  parseCommandArgs,
  promptTemplateForm,
  readPromptTemplate,
  substituteArgs,
} from '@morse/ui-runtime';
import { AttachmentStore, type PendingImage, type PendingPin } from '../../state/attachments';
import { ComposerDrafts } from '../../state/composer-drafts';
import { MorseService } from '../../host/morse.service';
import { QueuedPrompts, type QueuedPrompt } from '../../state/queued-prompts';
import { ShellState } from '../../state/shell-state';
import { ShortcutService } from '../../services/shortcut.service';
import { Uploader } from '../../services/uploads';
import { WorkspaceFiles } from '../../services/workspace-files.service';
import { WorkspaceFilesStore } from '../../state/workspace-files.store';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { pinNoteHint } from '@morse/ui-runtime';
import { PopoverFit } from '../../ui/popover-fit.directive';
import { EnterDirective } from '../../ui/enter.directive';
import { FilePicker, rankFiles } from '../file-picker/file-picker';
import { CommandPicker, rankPalette, type PaletteItem } from '../command-picker/command-picker';
import {
  PromptTemplateDialog,
  type PromptTemplateRequest,
} from '../prompt-template-dialog/prompt-template-dialog';
import { ModelPicker } from '../model-picker/model-picker';
import { ModelInputs } from '../model-picker/model-inputs';
import { NoteHoverDirective } from '../../ui/pin-annotation/note-hover.directive';
import { PinAnnotation, type AnnotationTarget } from '../../ui/pin-annotation/pin-annotation';
import type { PopoverAnchor } from '@morse/ui-runtime';
import { ThinkingPicker } from '../thinking-picker/thinking-picker';
import { UsageIndicator } from '../usage/usage-indicator';

@Component({
  selector: 'morse-chat-composer',
  templateUrl: './composer.html',
  imports: [
    EnterDirective,
    FilePicker,
    UsageIndicator,
    CommandPicker,
    ModelPicker,
    ModelInputs,
    ThinkingPicker,
    PromptTemplateDialog,
    PinAnnotation,
    NoteHoverDirective,
    PopoverFit,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './composer.css',
})
export class ChatComposer {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly shortcuts = inject(ShortcutService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly attachments = inject(AttachmentStore);
  private readonly drafts = inject(ComposerDrafts);
  private readonly queue = inject(QueuedPrompts);
  private readonly workspace = inject(WorkspaceFiles);
  private readonly workspaceStore = inject(WorkspaceFilesStore);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly uploads = inject(Uploader);
  private readonly promptInput = viewChild<ElementRef<HTMLTextAreaElement>>('promptInput');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly thinkingPicker = viewChild(ThinkingPicker);

  protected readonly text = this.drafts.text;
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
   *
   * Where the host has a tab strip (the browser host), `App` does not mount the
   * composer at all until a session tab is in front, so this only decides the
   * lazy start on a host with no tabs (VS Code).
   */
  protected readonly canSend = computed(
    () => this.connected() && !this.agentStarting() && this.agentError() === undefined,
  );
  /**
   * A send must wait for a model pick's thinking levels to land. The host orders
   * a prompt behind the switch, but letting Enter through here reads as "sent with
   * Max" while the picker is still re-reading — so the button is disabled and
   * Enter is a no-op until the pick settles. Typing stays enabled: only the send
   * is held.
   */
  protected readonly settingsSettled = computed(() => !this.loadingThinkingLevels());
  protected readonly canAttachSelection = computed(
    () => this.morse.capabilities()?.editorContext === true,
  );
  protected readonly thinkingLevel = computed(() => this.morse.state().thinkingLevel);
  protected readonly models = this.morse.availableModels;
  protected readonly levels = this.morse.availableThinkingLevels;
  /** True while the host re-reads the picked model's levels (see the picker). */
  protected readonly loadingThinkingLevels = this.morse.loadingThinkingLevels;
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
   * Follow-ups waiting their turn for the tab in front. The store keeps every
   * session's queue; this is only the one the composer is editing, so a tab
   * never shows another session's messages.
   */
  protected readonly queuedMessages = computed(() =>
    this.queue.forOwner(this.tabs.composerKey()),
  );

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
   * The pin whose annotation the popover editor is open for, and where its ✎ sits
   * on screen — the card is anchored there rather than in a fixed spot.
   */
  protected readonly annotationPin = signal<PendingPin | undefined>(undefined);
  protected readonly annotationAnchor = signal<PopoverAnchor | undefined>(undefined);

  /** What the editor's header names, derived from the pin being edited. */
  protected readonly annotationTarget = computed<AnnotationTarget | undefined>(() => {
    const pin = this.annotationPin();
    return pin === undefined
      ? undefined
      : { path: pin.path, range: this.pinRange(pin) || undefined };
  });

  /** The markdown the editor opens with (the pin's own note, if it has one). */
  protected readonly annotationNote = computed(() => this.annotationPin()?.note ?? '');

  /** The ✎ was pressed: open the editor anchored to it. */
  protected openAnnotation(pin: PendingPin, event: Event): void {
    const element = event.currentTarget;
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const rect = element.getBoundingClientRect();
    this.annotationAnchor.set({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    });
    this.annotationPin.set(pin);
  }

  /** The editor saved: the markdown (an empty one clears) goes onto the pin. */
  protected onAnnotationSave(note: string): void {
    const pin = this.annotationPin();
    if (pin !== undefined) {
      this.attachments.setPinNote(pin.id, note);
    }
    this.closeAnnotation();
  }

  protected closeAnnotation(): void {
    this.annotationPin.set(undefined);
    this.annotationAnchor.set(undefined);
  }

  /** The annotation hint on a chip: the first line, kept short. */
  protected readonly noteHint = pinNoteHint;

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
    if (!live) {
      return '';
    }
    return live.startLine === undefined
      ? `Add ${live.path} to this message — it is the file in front of the editor.`
      : `Lock this selection — it stops following the editor; a new selection makes a new chip.`;
  });
  /** The file picker: the way to attach files in a host without drag and drop. */
  protected readonly pickerOpen = signal(false);
  protected readonly workspaceFiles = this.workspaceStore.files;
  protected readonly loadingFiles = this.workspaceStore.busy;
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
    // Morse's own rows are registered first and win on a name collision:
    // `/settings`, `/model`, `/new`, `/compact` route to Morse's UI and pi now
    // lists same-name builtins in its catalog (sourced from the installed pi),
    // so one palette row per name keeps the picker honest.
    const items = new Map<string, PaletteItem>();
    for (const command of BUILTIN_COMMANDS) {
      items.set(command.name, {
        id: `builtin:${command.name}`,
        label: `/${command.name}`,
        description: command.description,
        badge: 'built-in',
        icon: '›',
      });
    }
    for (const command of this.availableCommands()) {
      if (items.has(command.name)) {
        continue;
      }
      items.set(command.name, {
        id: `command:${command.name}`,
        label: `/${command.name}`,
        description: command.description,
        badge: command.source === 'builtin' ? 'pi built-in' : command.source,
        icon: '⁄',
      });
    }
    return rankPalette([...items.values()], this.paletteFilter());
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
      this.drafts.updateText((value) => (value.trim().length === 0 ? block : `${value.trimEnd()}\n${block}`));
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
      this.drafts.setText(seed.text);
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
    this.drafts.setText(target.value);
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
            this.onPickFile(chosen, event.shiftKey);
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
      // A model pick's thinking levels are still being read: the send would be
      // held by the host anyway, and looking like it left with the previous
      // model's level is the confusion. Do nothing until the pick settles.
      if (!this.settingsSettled()) {
        return;
      }
      this.sendWith(this.streaming() ? 'steer' : 'new');
    }
  }

  /** The Send button: the same hold Enter takes while a model pick settles. */
  protected onSendClick(): void {
    if (!this.settingsSettled()) {
      return;
    }
    this.sendWith('new');
  }

  protected sendWith(mode: PromptMode): void {
    let value = this.drafts.text().trim();
    this.unroutedPiBuiltin.set(undefined);
    // `/compact <instructions>` is the same destructive action as the bare built-in,
    // only with the user's words attached — it must not slip past the confirmation by
    // riding along as a prompt.
    const instructions = compactInstructions(value);
    if (instructions !== undefined) {
      this.drafts.setText('');
      this.shell.requestCompact(instructions, this.tabs.composerKey());
      return;
    }
    // A bare built-in (`/new`, `/compact`, `/settings`, `/model`) is an action,
    // not a prompt pi can run — the TUI keeps those commands out of the wire.
    const builtin = builtinName(value);
    if (builtin) {
      this.drafts.setText('');
      this.runBuiltin(builtin);
      return;
    }
    // A `/name` (or `/name <arg>`) naming a pi builtin: routed — model and
    // thinking through the same services the footer uses — or, for ones Morse
    // does not route yet, the notice chip. pi's RPC would run a bare `/name` as
    // literal prompt text, so none of it reaches the wire.
    const typedSlash = /^\/([\w:-]+)(?:[ \t]+(.*))?$/.exec(value);
    if (typedSlash !== null) {
      const [typedName, typedArgument] = [typedSlash[1] ?? '', typedSlash[2]?.trim() || undefined];
      const piBuiltin = this.availableCommands().find(
        (candidate) => candidate.source === 'builtin' && candidate.name === typedName,
      );
      if (piBuiltin) {
        this.drafts.setText('');
        this.runPiBuiltin(piBuiltin, typedArgument);
        return;
      }
    }
    // A `/template` draft is expanded before it leaves the composer, so the agent
    // and the transcript get the body, never the bare token. The palette already
    // does this for its rows; Enter has to do it too when the palette was not open
    // (a stale command list, a restored draft, a pasted command).
    const expanded = this.expandTemplateDraft(value);
    if (expanded === 'form') {
      return;
    }
    if (expanded !== undefined) {
      value = expanded;
    }
    const images = this.attachments.takeImages();
    const pins = this.attachments.takePins();
    if (value.length === 0 && images.length === 0 && pins.length === 0) {
      this.promptInput()?.nativeElement.focus();
      return;
    }
    // The prompt carries the user's words; images and pins go as attachments —
    // the agent gets an `@path` mention for a pin, never a copied blob. The
    // live preview is a preview only: unlocking it was never done, so a
    // selection that was shown but not locked does not ride along.
    if (mode === 'followUp' && this.running()) {
      // A follow-up is queued, not sent: the reader gets to see, edit or drop it
      // before it runs, instead of it disappearing into pi's invisible queue.
      this.queue.enqueue({ text: value, images, pins }, this.tabs.composerKey());
    } else {
      // While idle (`followUp` won the race with the run ending) a queued kind
      // makes no sense: pi should start a fresh turn.
      this.morse.prompt(value, mode === 'followUp' ? 'new' : mode, images, pins);
    }
    this.attachments.setLivePreview(null);
    this.drafts.setText('');
  }

  /** Puts a queued follow-up back in the composer, attachments and all. */
  protected editQueued(item: QueuedPrompt): void {
    this.queue.remove(item.id);
    this.drafts.setText(item.text);
    this.syncInputValue();
    this.attachments.seed(item.images, item.pins);
    this.promptInput()?.nativeElement.focus();
  }

  /** Runs a queued follow-up now: steering it when a run is in flight. */
  protected sendQueued(item: QueuedPrompt): void {
    this.queue.remove(item.id);
    this.morse.prompt(
      item.text,
      this.running() ? 'steer' : 'new',
      item.images,
      item.pins,
    );
  }

  protected removeQueued(item: QueuedPrompt): void {
    this.queue.remove(item.id);
  }

  /**
   * A CDK drop on the queue: the dragged follow-up takes the slot the placeholder
   * is on. CDK never mutates the data, so `currentIndex` still indexes the list as
   * it was when the drag started — the row sitting there is where it landed.
   */
  protected onQueueDrop(event: CdkDragDrop<readonly QueuedPrompt[]>): void {
    const dragged = event.item.data as QueuedPrompt | undefined;
    const target = event.container.data[event.currentIndex];
    if (dragged !== undefined && target !== undefined) {
      this.queue.move(dragged.id, target.id);
    }
  }

  /** The live chip is a preview until clicked: locking pins its final numbers. */
  protected lockLive(): void {
    const live = this.livePreview();
    this.attachments.lockLivePreview();
    this.attachments.say(
      'info',
      live?.startLine === undefined
        ? 'File added to this message.'
        : 'Selection locked to this message.',
    );
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
    // A removed chip must not leave its annotation editor behind pointing at a
    // pin that no longer exists.
    if (this.annotationPin()?.id === id) {
      this.closeAnnotation();
    }
    this.attachments.removePin(id);
  }

  protected preview(image: PendingImage): string {
    return `data:${image.mimeType};base64,${image.data}`;
  }

  /**
   * Stop is destructive — it drops the turn in flight — so it asks first. The button
   * sits beside Steer and Follow up, and a stray press used to end the run outright;
   * the dialog puts Cancel under the cursor instead. Steering and follow-ups stay
   * ungated: they queue, and a queued message can be cancelled.
   */
  protected abort(): void {
    this.shell.requestStop();
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
    const value = this.drafts.text();
    const separator = value.length > 0 && !/\s$/.test(value) ? ' ' : '';
    this.drafts.setText(`${value}${separator}@`);
    const input = this.promptInput()?.nativeElement;
    if (input) {
      // Angular updates `[value]` on the next change detection; the caret has to
      // move now, so the DOM value is set here too.
      const next = this.drafts.text();
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
    // A stale notice for an earlier pick should not outlive the reader going
    // back to the palette.
    this.unroutedPiBuiltin.set(undefined);
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
        if (command?.source === 'builtin') {
          this.stripSlashToken();
          this.closePalette();
          this.runPiBuiltin(command);
          return;
        }
        if (command?.template !== undefined) {
          const form = promptTemplateForm(command.template);
          if (form !== undefined) {
            // The template declares arguments: a bare `/name` would leave them
            // empty, so collect them — and any extra — in the form first.
            this.stripSlashToken();
            this.drafts.setText('');
            this.closePalette();
            this.openTemplate({ name, description: command.description, form });
            return;
          }
          // No arguments to collect. Expand here as well instead of handing pi
          // `/name`: a template added after spawn is not in pi's cache, and an
          // edited body must reach the agent without a pi reload.
          this.stripSlashToken();
          this.drafts.setText('');
          this.closePalette();
          this.sendTemplate(readPromptTemplate(command.template).body);
          return;
        }
        // No body to expand (the file could not be read): pi expands skills and
        // templates server-side, so the bare `/name` is the whole prompt; pending
        // attachments belong to the user's next one.
        this.stripSlashToken();
        this.drafts.setText('');
        this.closePalette();
        this.morse.prompt(`/${name}`, this.streaming() ? 'steer' : 'new');
        return;
      }
      this.replaceSlashToken(`/${name} `);
      this.closePalette();
    }
  }

  /**
   * The expanded body of a `/command` draft that names a prompt template, or
   * `'form'` when the template declares arguments and none were typed (the form
   * opens instead), or `undefined` when the draft is not a template invocation.
   *
   * Built-ins are handled before this; a skill or extension command has no body
   * Morse can read, so it stays a bare `/name` — pi expands those itself.
   */
  private expandTemplateDraft(value: string): string | 'form' | undefined {
    const match = /^\/([\w:-]+)(?:[ \t]+(.*))?$/.exec(value);
    if (match === null) {
      return undefined;
    }
    const name = match[1] ?? '';
    const args = (match[2] ?? '').trim();
    const command = this.availableCommands().find(
      (candidate) => candidate.name === name && candidate.source === 'prompt',
    );
    if (command?.template === undefined) {
      return undefined;
    }
    const form = promptTemplateForm(command.template);
    if (form !== undefined && args.length === 0) {
      // The template declares arguments and a bare `/name` would leave them
      // empty, so collect them — and any extra — in the form first.
      this.drafts.setText('');
      this.syncInputValue();
      this.openTemplate({ name, description: command.description, form });
      return 'form';
    }
    const body = readPromptTemplate(command.template).body;
    return args.length > 0 ? substituteArgs(body, parseCommandArgs(args)) : body;
  }

  /** Opens the argument form for a prompt template; the dialog owns the fields. */
  private openTemplate(request: PromptTemplateRequest): void {
    this.templateRequest.set(request);
    this.shell.setPromptTemplateOpen(true);
  }

  /** Template-bound (`(cancelled)` on the template dialog); protected for that. */
  protected closeTemplate(): void {
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
    // Two dropdowns must never overlap: the chooser opening over the thinking
    // panel dismisses it, whether it was opened by click or by its shortcut.
    this.thinkingPicker()?.close();
    // pi caches its configured models while the session is warm, so opening the
    // picker asks for a fresh catalog: a model added to `models.json` shows up
    // here without restarting the host or the session.
    this.morse.refreshModels();
    this.modelPickerOpen.set(true);
  }

  /**
   * The model trigger's pointerdown is kept from reaching the document so the
   * chooser's own outside-press listener does not close it before the click
   * toggles it. Closing the sibling thinking panel then happens in
   * `openModelPicker`, so the keyboard path gets it too.
   */
  protected onModelTriggerPointerdown(event: Event): void {
    event.stopPropagation();
  }

  protected toggleModelPicker(): void {
    if (this.modelPickerOpen()) {
      this.modelPickerOpen.set(false);
      return;
    }
    this.openModelPicker();
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
        // conversation on its own. The key pins it to the conversation in front.
        this.shell.requestCompact(undefined, this.tabs.composerKey());
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

  /**
   * pi builtins the catalog carries (sourced from the installed pi) but whose
   * execution lives in pi's own TUI process: the RPC protocol exposes no way to
   * run them (`get_commands` deliberately carries only extensions, prompt
   * templates and skills). Morse routes the ones that map to an existing Morse
   * surface — model and thinking go through the same services the footer uses,
   * with pi's argument shapes — and says so out loud for the rest instead of
   * sending a bare `/name` that would reach pi as prompt text.
   */
  private runPiBuiltin(command: CommandOption, argument?: string): void {
    const arg = argument?.trim();
    switch (command.name) {
      case 'model':
        if (arg === undefined) {
          this.openModelPicker();
          return;
        }
        this.setModelArgument(arg);
        return;
      case 'thinking': {
        if (arg === undefined) {
          // The picker is always rendered in this composer, so a bare
          // `/thinking` points at the live control instead of opening nothing.
          this.setNotice(command, undefined, [
            'The thinking picker in the composer footer is always live —',
            'or type the level: `/thinking low`, `/thinking high`, and so on.',
          ]);
          return;
        }
        const level = this.levels().find(
          (candidate: string) => candidate.toLowerCase() === arg.toLowerCase(),
        ) as ThinkingLevel | undefined;
        if (level === undefined) {
          this.setNotice(command, arg, [
            'is not a thinking level this model offers — available here:',
            `${this.levels().join(', ')}.`,
          ]);
          return;
        }
        this.morse.setThinkingLevel(level);
        return;
      }
      case 'new':
        this.tabs.startDraft(this.morse.workspace().cwd);
        return;
      case 'compact':
        // The same confirmation as the header button: `/compact` must not
        // summarize a conversation on its own.
        this.shell.requestCompact(undefined, this.tabs.composerKey());
        return;
      case 'settings':
        this.morse.hostCommand('openSettings');
        return;
      case 'hotkeys':
        // pi's TUI hotkeys sheet covers the same reader need as Morse's panel;
        // what this app binds is what this reader is actually working with.
        this.shell.openShortcuts();
        return;
      case 'quit':
        // Desktop shells and script-opened windows honor this; a normal
        // browser tab does not, and the notice is the honest fallback.
        window.close();
        if (!window.closed) {
          this.setNotice(command, arg);
        }
        return;
      default:
        this.setNotice(command, arg);
    }
  }

  /** `/model <provider>/<id>` with the same validation the picker applies. */
  private setModelArgument(arg: string): void {
    const sep = arg.indexOf('/');
    const provider = sep === -1 ? undefined : arg.slice(0, sep);
    const id = sep === -1 ? undefined : arg.slice(sep + 1);
    const match =
      provider !== undefined &&
      id !== undefined &&
      this.models().find((model) => model.provider === provider && model.id === id);
    if (!match) {
      this.setNotice(
        { name: 'model' },
        arg,
        [
          'The model was not set:',
          'expect `/model provider/id` from the available-model list, or run bare `/model` for the picker.',
        ],
      );
      return;
    }
    this.morse.setModel(match.provider, match.id);
  }

  /**
   * The pi builtin the reader last picked that needs an explanation, shown as a
   * chip above the input so nothing fails silently: either a command Morse does
   * not route (the default sentence) or an argument that did not validate. Both
   * are one cleared-by-send message, never wire traffic.
   */
  protected readonly unroutedPiBuiltin = signal<
    { name: string; hint?: string; text: string } | undefined
  >(undefined);

  protected dismissUnrouted(): void {
    this.unroutedPiBuiltin.set(undefined);
  }

  /**
   * `parts` composes the message; without it the chip says the command is
   * un-routed here. A hint rides after the command name.
   */
  private setNotice(
    command: { name: string; argumentHint?: string },
    argument: string | undefined,
    parts?: string[],
  ): void {
    const hint = command.argumentHint ? ` ${command.argumentHint}` : undefined;
    this.unroutedPiBuiltin.set({
      name: command.name,
      hint: argument ? ` ${argument}` : hint,
      text:
        parts?.join(' ') ??
        "is one of pi's TUI commands, tracked from the installed pi. Morse does not route it here, so nothing was sent.",
    });
  }

  /** Removes the trailing `/command` token the palette opened on. */
  private stripSlashToken(): void {
    this.drafts.updateText((value) => value.replace(/(?:^|\n)(\s*)\/[\w:-]*$/, '$1'));
    this.syncInputValue();
  }

  private replaceSlashToken(replacement: string): void {
    this.drafts.updateText((value) => value.replace(/(?:^|\n)(\s*)\/[\w:-]*$/, `$1${replacement}`));
    this.syncInputValue();
  }

  private syncInputValue(): void {
    const input = this.promptInput()?.nativeElement;
    if (!input) {
      return;
    }
    const next = this.drafts.text();
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
   *
   * Opening the file preview is a separate intent (`quote`): a plain mention is
   * just a reference in the text, while quoting opens the file so a line range
   * can be dragged into the prompt. Enter mentions, Shift+Enter (or the row's
   * `⧉`) quotes.
   */
  protected onPickFile(path: string, quote = false): void {
    const directory = path.endsWith('/');
    if (this.mentionMode()) {
      // Replace the `@query` the user typed instead of appending a second mention.
      // A directory keeps its trailing `/` and gets no space, so it stays a prefix.
      this.drafts.updateText((value) => value.replace(/@[\w./-]*$/, `@${path}${directory ? '' : ' '}`));
    } else if (!directory) {
      this.attachments.addMentions([path]);
      this.attachments.say('info', `Pinned ${path} to this message.`);
    }
    // Only a quote pick opens the file: a plain mention must not steal the view
    // from the conversation. On VS Code the preview never exists anyway — the
    // editor is already the user's.
    if (quote && !directory && this.morse.capabilities()?.filePreview) {
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

  /** The picker's second target: mention the file and open it to quote lines. */
  protected onQuoteFile(path: string): void {
    this.onPickFile(path, true);
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
