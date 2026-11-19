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
import {
  addedFileDiff,
  parseUnifiedDiff,
  pinRangeLabel,
  statusByPath,
} from '@morse/ui-runtime';
import { AttachmentStore } from '../../state/attachments';
import { DisplayPrefs, type DiffView } from '../../state/display-prefs';
import { WorkspaceFilesStore } from '../../state/workspace-files.store';
import { WorkspaceTabs, type FileTab } from '../../state/workspace-tabs';
import { CODE_EDITOR_LOADER, type CodeEditorLoader } from '../../ui/code-editor/code-editor-loader';
import { editorPins, type EditorPin } from '../../ui/code-editor/pins';
import type { PinRequest } from '../../ui/code-editor/pin-selection';

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

/**
 * The inputs this feature drives, by name. Written down so a rename in the editor is a
 * compile error here rather than an input that silently never arrives.
 */
interface EditorInputs {
  readonly mode: DiffView;
  readonly diff: string | undefined;
  readonly text: string;
  readonly path: string;
  readonly line: number | undefined;
  readonly pins: readonly EditorPin[];
}

/** The outputs and inputs the feature drives on the mounted editor. */
type MountedEditor = ComponentRef<unknown> & {
  instance: EditorOutputs;
  setInput<K extends keyof EditorInputs>(name: K, value: EditorInputs[K]): void;
};

/**
 * A file opened from the Explorer: its text, or its changes — unified or split.
 *
 * The surface itself is `morse-code-editor`, the same component either way: a diff is
 * one of its documents, not a second renderer. What is left here is the file's own
 * chrome (path, commit, mode switch, stats, pins) and the store wiring — the one place
 * that gets a component with no inputs bound to it.
 *
 * The editor is CodeMirror and it is large, so it is loaded as its own chunk and
 * mounted through `CODE_EDITOR_LOADER` — the same seam specs replace with a fake,
 * because an `EditorView` cannot be mounted in jsdom.
 */
@Component({
  selector: 'morse-file-preview',
  templateUrl: './file-preview.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './file-preview.css',
})
export class FilePreview {
  readonly tab = input.required<FileTab>();

  private readonly tabs = inject(WorkspaceTabs);
  private readonly attachments = inject(AttachmentStore);
  private readonly display = inject(DisplayPrefs);
  private readonly workspaceStore = inject(WorkspaceFilesStore);
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

  /** The diff to hand the editor: the host's, or the whole content of an untracked file. */
  protected readonly diffText = computed(() => {
    const tab = this.tab();
    if (tab.diff !== undefined && tab.diff.trim().length > 0) {
      return tab.diff;
    }
    if (this.changed() === 'U' && tab.content !== undefined && !tab.binary) {
      return addedFileDiff(tab.content);
    }
    return tab.diff ?? '';
  });

  /** Read for the header's counts and the "nothing changed" verdict, not to draw. */
  protected readonly parsed = computed(() => parseUnifiedDiff(this.diffText()));

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
  /** The `L14-23` label the header's pin button and the editor share. */
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

  constructor() {
    // Load the editor only while something is actually shown: the chunk is large,
    // and `@defer` would put its runtime in the initial bundle instead. A diff is the
    // same component, so it needs the chunk too.
    effect(() => {
      if (this.tab().binary === true) {
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
      const mode = this.mode();
      const diff = this.diffText();
      untracked(() => {
        if (editor === undefined) {
          return;
        }
        editor.setInput('mode', mode);
        editor.setInput('diff', diff);
        editor.setInput('text', tab.content ?? '');
        editor.setInput('path', tab.path);
        editor.setInput('line', tab.line);
        editor.setInput('pins', pins);
      });
    });
    // A different file starts with no selection offered: it described the file that
    // was in front.
    effect(() => {
      this.tab();
      untracked(() => this.pendingPin.set(null));
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

  /** A range came back from the editor — a dragged one, or a clicked change block. */
  private pinSelection(request: PinRequest): void {
    this.attachments.pin({ path: this.tab().path, ...request });
    this.attachments.say(
      'info',
      `Pinned ${this.tab().title} ${pinRangeLabel(request)} to this message.`,
    );
  }

  /** Switches the preview between the file and the two diff layouts. */
  protected setMode(view: DiffView): void {
    this.display.setDiffView(view);
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
