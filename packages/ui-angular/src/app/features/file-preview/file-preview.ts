import {
  ChangeDetectionStrategy,
  Component,
  ComponentRef,
  ViewContainerRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  type OutputEmitterRef,
  type Type,
} from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import {
  addedFileDiff,
  highlightCode,
  parseUnifiedDiff,
  pinRangeLabel,
  splitRows,
  statusByPath,
  unifiedRows,
  type DiffRow,
  type SplitRow,
  type UnifiedRow,
} from '@morse/ui-runtime';
import type { PopoverAnchor } from '@morse/ui-runtime';
import { AttachmentStore } from '../../state/attachments';
import { DisplayPrefs, type DiffView } from '../../state/display-prefs';
import { WorkspaceFilesStore } from '../../state/workspace-files.store';
import { WorkspaceTabs, type FileTab } from '../../state/workspace-tabs';
import { PinActions } from '../../ui/pin-annotation/pin-actions';
import { PinAnnotation, type AnnotationTarget } from '../../ui/pin-annotation/pin-annotation';
import { CODE_EDITOR_LOADER, type CodeEditorLoader } from '../../ui/code-editor/code-editor-loader';
import { editorPins, type EditorPin } from '../../ui/code-editor/pins';
import type { PinRequest } from '../../ui/code-editor/pin-selection';

/**
 * What the annotation editor needs from whatever carries a note: the pin's id,
 * the note itself, and the range for its header.
 */
interface AnnotationPinRef {
  id: string;
  note?: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
}

/** The editor's outputs, seen from the feature that mounts it lazily. */
interface EditorOutputs {
  readonly pinRequested: OutputEmitterRef<PinRequest>;
  readonly noteEdited: OutputEmitterRef<{ id: string; note: string }>;
  readonly unpinned: OutputEmitterRef<{ id: string }>;
  /** The selection a pin could be made from, or `null`. */
  readonly selectionChanged: OutputEmitterRef<PinRequest | null>;
  /** Collapse the selection once its pin exists. */
  clearSelection(): void;
}

/** The outputs and inputs the feature drives on the mounted editor. */
type MountedEditor = ComponentRef<unknown> & { instance: EditorOutputs };

/** A diff row's label, through the one shared formatter (`L14-23`). */
function rangeText(range: { start: number; end: number } | undefined): string {
  if (range === undefined) {
    return '';
  }
  return pinRangeLabel({ startLine: range.start, endLine: range.end });
}

/**
 * A file opened from the Explorer: its diff (unified or split), or its text in a
 * read-only CodeMirror editor, with each pinned range tinted where it sits and its
 * note on that band's own chip.
 *
 * The editor is CodeMirror and it is large, so it is loaded as its own chunk and
 * mounted through `CODE_EDITOR_LOADER` — the same seam specs replace with a fake,
 * because an `EditorView` cannot be mounted in jsdom.
 */
@Component({
  selector: 'morse-file-preview',
  templateUrl: './file-preview.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PinAnnotation, PinActions],
  styleUrl: './file-preview.css',
})
export class FilePreview {
  readonly tab = input.required<FileTab>();

  private readonly tabs = inject(WorkspaceTabs);
  private readonly attachments = inject(AttachmentStore);
  private readonly display = inject(DisplayPrefs);
  private readonly workspaceStore = inject(WorkspaceFilesStore);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly loader = inject<CodeEditorLoader>(CODE_EDITOR_LOADER);

  protected readonly language = computed(() => this.tab().language ?? 'text');
  protected readonly size = computed(() => formatBytes(this.tab().size ?? 0));

  /** The file's git status letter, when the working tree reports one. */
  protected readonly changed = computed(() =>
    statusByPath(this.workspaceStore.status()).get(this.tab().path),
  );

  /**
   * Whether there is a diff to show. A working-tree file only has one when it
   * changed; a commit tab always has one, even if the working tree is clean.
   */
  protected readonly diffable = computed(
    () => this.changed() !== undefined || this.tab().commitHash !== undefined,
  );

  /**
   * File / unified / split. A commit tab never offers the File view: the content
   * on disk is not the commit's content, so the diff is the only honest picture.
   */
  protected readonly mode = computed<DiffView>(() => {
    if (!this.diffable()) {
      return 'file';
    }
    if (this.tab().commitHash !== undefined) {
      return this.display.diffView() === 'split' ? 'split' : 'unified';
    }
    return this.display.diffView();
  });

  /** The diff to parse: the host's, or the whole content of an untracked file. */
  private readonly diffText = computed(() => {
    const tab = this.tab();
    if (tab.diff !== undefined && tab.diff.trim().length > 0) {
      return tab.diff;
    }
    if (this.changed() === 'U' && tab.content !== undefined && !tab.binary) {
      return addedFileDiff(tab.content);
    }
    return tab.diff ?? '';
  });

  protected readonly parsed = computed(() => parseUnifiedDiff(this.diffText()));
  protected readonly unified = computed<UnifiedRow[]>(() => unifiedRows(this.parsed()));
  protected readonly split = computed<SplitRow[]>(() => splitRows(this.parsed()));

  /**
   * The diff rows with their syntax colouring. Highlighted line by line: a diff
   * is a slice of a file, so a multi-line construct can read imperfectly, but the
   * alternative — no colour at all — loses far more.
   */
  protected readonly unifiedView = computed(() => {
    const language = this.language();
    return this.unified().map((row) => ({
      ...row,
      html:
        row.kind === 'hunk'
          ? ''
          : this.sanitizer.bypassSecurityTrustHtml(highlightCode(row.text, language).html),
    }));
  });

  protected readonly splitView = computed(() => {
    const language = this.language();
    const line = (row: DiffRow | undefined) =>
      row === undefined
        ? undefined
        : {
            ...row,
            html: this.sanitizer.bypassSecurityTrustHtml(highlightCode(row.text, language).html),
          };
    return this.split().map((pair) => ({
      hunk: pair.hunk,
      left: line(pair.left),
      right: line(pair.right),
    }));
  });

  protected readonly diffStats = computed(() => {
    const parsed = this.parsed();
    return `+${parsed.additions} −${parsed.deletions}`;
  });

  /** This file's pins, which the editor draws and the header counts. */
  protected readonly pins = computed(() => editorPins(this.attachments.pins(), this.tab().path));
  protected readonly pinnedCount = computed(() => this.pins().length);
  /**
   * The selection the editor is offering to pin. It shows up in the header rather
   * than as a pill over the code, so the lines it is about stay readable.
   */
  protected readonly pendingPin = signal<PinRequest | null>(null);
  /** The `L14-23` label the header's pin button and the diff rows share. */
  protected readonly pinRangeLabel = pinRangeLabel;
  /** Where the header's pin chip last sent the reader, so the next click moves on. */
  private readonly revealedPinLine = signal(0);

  /** The header's pin button: pin what the editor has selected, then drop the paint. */
  protected pinPending(): void {
    const pending = this.pendingPin();
    if (pending === null) {
      return;
    }
    this.pendingPin.set(null);
    this.pinSelection(pending);
    // The tint is the record of those lines now: a drag left painted over them only
    // looks like an unfinished edit.
    this.mounted()?.instance.clearSelection();
  }

  /** The header's pin chip: reveals the next pinned range in this file, wrapping. */
  protected revealNextPin(): void {
    const pins = this.pins();
    if (pins.length === 0) {
      return;
    }
    const after = this.revealedPinLine();
    const next = pins.find((pin) => pin.startLine > after) ?? pins[0]!;
    this.revealedPinLine.set(next.startLine);
    this.tabs.revealLine(this.tab().id, next.startLine);
  }

  /**
   * The row each pin's Notes/Cancel pair belongs to: the bottom of its band.
   *
   * Matching the anchor alone is not enough. Every row of a deletion block maps
   * to the same new-file line, so a pin ending there would paint a pair on
   * every deleted row; the last changed row on that line is the one corner the
   * pair belongs on.
   */
  protected readonly unifiedPairRows = computed(() => {
    const rows = this.unified();
    const out = new Map<number, EditorPin>();
    for (const pin of this.pins()) {
      const end = pin.endLine ?? pin.startLine;
      let last = -1;
      let lastChange = -1;
      rows.forEach((row, i) => {
        if (row.kind === 'hunk' || row.newAnchor !== end) {
          return;
        }
        last = i;
        if (row.kind === 'add' || row.kind === 'del') {
          lastChange = i;
        }
      });
      const index = lastChange >= 0 ? lastChange : last;
      if (index >= 0) {
        out.set(index, pin);
      }
    }
    return out;
  });

  /** The split view's version: the pair rides the side the band ends on. */
  protected readonly splitPairRows = computed(() => {
    const rows = this.split();
    const left = new Map<number, EditorPin>();
    const right = new Map<number, EditorPin>();
    for (const pin of this.pins()) {
      const end = pin.endLine ?? pin.startLine;
      let rightAdd = -1;
      let leftDel = -1;
      let rightLast = -1;
      let leftLast = -1;
      rows.forEach((pair, i) => {
        const next = pair.right;
        if (next !== undefined && next.newAnchor === end) {
          rightLast = i;
          if (next.kind === 'add') {
            rightAdd = i;
          }
        }
        const old = pair.left;
        if (old !== undefined && old.newAnchor === end) {
          leftLast = i;
          if (old.kind === 'del') {
            leftDel = i;
          }
        }
      });
      // An addition (or a context line) ends on the new side; a deletion that
      // leaves no added row behind ends on the old side, where it is drawn.
      if (rightAdd >= 0) {
        right.set(rightAdd, pin);
      } else if (leftDel >= 0) {
        left.set(leftDel, pin);
      } else if (rightLast >= 0) {
        right.set(rightLast, pin);
      } else if (leftLast >= 0) {
        left.set(leftLast, pin);
      }
    }
    return { left, right };
  });

  // --- the editor -----------------------------------------------------------

  /** The lazily-loaded editor class, and whether loading it failed. */
  protected readonly editorClass = signal<Type<unknown> | null>(null);
  protected readonly editorFailed = signal(false);
  private readonly mounted = signal<MountedEditor | undefined>(undefined);

  /**
   * The host element itself, because `ngComponentOutlet` cannot bind outputs and
   * the editor reports its pins through three of them.
   */
  private readonly editorHost = viewChild('editorHost', {
    read: ViewContainerRef,
  });

  // --- the range annotations ------------------------------------------------

  /**
   * The pin whose annotation editor is open, and where the ✎ that opened it sits
   * on screen — the card is anchored there, wherever the trigger happened to be.
   */
  protected readonly annotationPin = signal<AnnotationPinRef | undefined>(undefined);
  protected readonly annotationAnchor = signal<PopoverAnchor | undefined>(undefined);

  /** What the editor's header names: this file, and the range being annotated. */
  protected readonly annotationTarget = computed<AnnotationTarget | undefined>(() => {
    const pin = this.annotationPin();
    return pin === undefined ? undefined : { path: this.tab().path, range: this.rangeOf(pin) };
  });

  /** The markdown the editor opens with (the pin's own note, if it has one). */
  protected readonly annotationNote = computed(() => this.annotationPin()?.note ?? '');

  constructor() {
    // Load the editor only while a file is actually shown: the chunk is large,
    // and `@defer` would put its runtime in the initial bundle instead.
    effect(() => {
      if (this.mode() !== 'file' || this.tab().binary === true) {
        return;
      }
      untracked(() => this.loadEditor());
    });
    // Mount once the class and the host element both exist; the cleanup destroys
    // the component and drops its output subscriptions.
    effect((onCleanup) => {
      const editorClass = this.editorClass();
      const container = this.editorHost();
      if (editorClass === null || container === undefined) {
        return;
      }
      untracked(() => {
        container.clear();
        const ref = container.createComponent(editorClass) as MountedEditor;
        const subscriptions = [
          ref.instance.pinRequested.subscribe((request) => this.pinSelection(request)),
          ref.instance.noteEdited.subscribe(({ id, note }) =>
            this.attachments.setPinNote(id, note.trim().length === 0 ? undefined : note),
          ),
          ref.instance.unpinned.subscribe(({ id }) => this.attachments.removePin(id)),
          ref.instance.selectionChanged.subscribe((request) => this.pendingPin.set(request)),
        ];
        this.mounted.set(ref);
        onCleanup(() => {
          for (const subscription of subscriptions) {
            subscription.unsubscribe();
          }
          ref.destroy();
          this.mounted.set(undefined);
        });
      });
    });
    // Push the file's state into the mounted editor.
    effect(() => {
      const editor = this.mounted();
      const tab = this.tab();
      const pins = this.pins();
      untracked(() => {
        if (editor === undefined) {
          return;
        }
        editor.setInput('text', tab.content ?? '');
        editor.setInput('path', tab.path);
        editor.setInput('line', tab.line);
        editor.setInput('pins', pins);
      });
    });
    // A different file starts with no annotation editor open: it described the
    // file that was in front.
    effect(() => {
      this.tab();
      untracked(() => {
        this.annotationPin.set(undefined);
        this.annotationAnchor.set(undefined);
        this.pendingPin.set(null);
      });
    });
    // A diff view pulls the file's diff the first time it is shown.
    effect(() => {
      if (this.mode() === 'file') {
        return;
      }
      const id = this.tab().id;
      untracked(() => this.tabs.loadDiff(id));
    });
  }

  /** Load the editor chunk, once; a rejection leaves the plain-text fallback. */
  protected loadEditor(): void {
    if (this.editorClass() !== null) {
      return;
    }
    this.editorFailed.set(false);
    void this.loader().then(
      (editorClass) => this.editorClass.set(editorClass),
      () => this.editorFailed.set(true),
    );
  }

  /** A range came back from the editor: pin it to the next prompt. */
  private pinSelection(request: PinRequest): void {
    this.attachments.pin({ path: this.tab().path, ...request });
    this.attachments.say(
      'info',
      `Pinned ${this.tab().title} ${pinRangeLabel(request)} to this message.`,
    );
  }

  // --- diff interactions ----------------------------------------------------

  /** Switches the preview between the file and the two diff layouts. */
  protected setMode(view: DiffView): void {
    this.display.setDiffView(view);
  }

  protected diffSign(row: UnifiedRow | DiffRow | undefined): string {
    if (row === undefined) {
      return '';
    }
    switch (row.kind) {
      case 'add':
        return '+';
      case 'del':
        return '−';
      case 'context':
        return ' ';
      default:
        return '';
    }
  }

  /** Whether the pins already cover the new-file line a diff row sits on. */
  protected isChangePinned(anchor: number | undefined): boolean {
    if (anchor === undefined) {
      return false;
    }
    const path = this.tab().path;
    return this.attachments
      .pins()
      .some(
        (pin) =>
          pin.path === path &&
          pin.startLine !== undefined &&
          anchor >= pin.startLine &&
          anchor <= (pin.endLine ?? pin.startLine),
      );
  }

  /**
   * Clicking a change block pins its new-file range to the next prompt — the
   * diff view's stand-in for dragging line numbers. A block a pin already
   * covers is left alone: like the file preview's band, the highlight is not a
   * control, and the pair's Cancel is the way to unpin.
   */
  protected pinChange(row: UnifiedRow | DiffRow | undefined): void {
    const change = row !== undefined && row.kind !== 'hunk' ? row.change : undefined;
    if (change === undefined) {
      return;
    }
    const path = this.tab().path;
    const covering = this.attachments
      .pins()
      .find(
        (pin) =>
          pin.path === path &&
          pin.startLine !== undefined &&
          pin.startLine <= change.start &&
          (pin.endLine ?? pin.startLine) >= change.end,
      );
    if (covering !== undefined) {
      return;
    }
    this.attachments.pin({
      path,
      startLine: change.start,
      endLine: change.end > change.start ? change.end : undefined,
    });
    this.attachments.say(
      'info',
      `Pinned ${this.tab().title} ${rangeText(change)} to this message.`,
    );
  }

  /** The ✎ on a diff row: open the annotation editor anchored to that button. */
  protected openAnnotation(pin: AnnotationPinRef, button: HTMLElement): void {
    const rect = button.getBoundingClientRect();
    this.annotationAnchor.set({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    });
    this.annotationPin.set(pin);
  }

  /** The pair's Cancel: unpin the range the row stands for. */
  protected unpinPin(pin: AnnotationPinRef): void {
    this.attachments.removePin(pin.id);
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

  /** The `L30-31` label the editor's header shows (absent for a whole-file pin). */
  private rangeOf(pin: AnnotationPinRef): string | undefined {
    const label = pinRangeLabel(pin);
    return label.length === 0 ? undefined : label;
  }

  protected reload(): void {
    this.tabs.reload(this.tab().id);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

