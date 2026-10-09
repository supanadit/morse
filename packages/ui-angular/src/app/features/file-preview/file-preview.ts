import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import type { LspDiagnostics, LspLocation, LspReferences, LspSeverity } from '@morse/protocol';
import { AnimationService } from '../../ui/animation.service';
import { AttachmentStore, type PendingPin } from '../../state/attachments';
import { DisplayPrefs, type DiffView } from '../../state/display-prefs';
import {
  addedFileDiff,
  domRangeFor,
  identifierAt,
  offsetAt,
  parseUnifiedDiff,
  pinNoteHint,
  pointAt,
  sourceOffsetIn,
  splitRows,
  statusByPath,
  unifiedRows,
  type DiffRow,
  type SourcePoint,
  type SplitRow,
  type UnifiedRow,
} from '@morse/ui-runtime';
import { highlightCode } from '@morse/ui-runtime';
import { asDiagnostics, asHover, asLocation, asReferences } from '@morse/ui-runtime';
import { MorseService } from '../../host/morse.service';
import { WorkspaceFilesStore } from '../../state/workspace-files.store';
import { WorkspaceTabs, type FileTab } from '../../state/workspace-tabs';
import { NoteHoverDirective } from '../../ui/pin-annotation/note-hover.directive';
import { PinAnnotation, type AnnotationTarget } from '../../ui/pin-annotation/pin-annotation';
import type { PopoverAnchor } from '@morse/ui-runtime';
import { Markdown } from '../../ui/markdown/markdown';

/** One highlighted range in the preview: a pinned chip, or the drag in progress. */
interface Highlight {
  id: string;
  start: number;
  end: number;
  /** The range's annotation, when the chip carries one. The live band has none. */
  note?: string;
}

/**
 * What the annotation editor needs from whatever carries a note: the pin's id,
 * the note itself, and the range for its header. A `Highlight` maps onto it
 * through `openBandAnnotation`, a store pin satisfies it as-is.
 */
interface AnnotationPinRef {
  id: string;
  note?: string;
  startLine?: number;
  endLine?: number;
}

/** The hover card: what the language server said, and where to pin it. */
interface HoverCard {
  contents: string;
  /** Offsets from the preview's own top-left, already clamped into the pane. */
  top: number;
  left: number;
  /** The position the card is about, so "Find references" can reuse it. */
  point: SourcePoint;
  /**
   * Which symbol the card describes (`line:start-end`). Hovering anywhere inside
   * one identifier yields the same key, so a pointer jittering across a word
   * keeps the card — and the lock clock counting down on it.
   */
  key: string;
}

/** The symbol the pointer is resting on, and where to put its card. */
interface HoverTarget {
  point: SourcePoint;
  /** `line:start-end`, so a resting pointer is not mistaken for a new symbol. */
  key: string;
  clientX: number;
  clientY: number;
}

/**
 * One measured diagnostic underline. Diagnostics are drawn as an overlay rather
 * than by rewriting the highlighted HTML: the markup comes from highlight.js, and
 * injecting spans into it would mean re-escaping text the renderer already owns.
 * A rect is measured from a real `Range`, so a squiggle sits under exactly the
 * characters the server named, whatever the font does.
 */
interface DiagnosticMark {
  id: string;
  severity: LspSeverity;
  message: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

function rangeText(range: { start: number; end: number } | undefined): string {
  if (range === undefined) {
    return '';
  }
  return range.start === range.end ? `L${range.start}` : `L${range.start}–${range.end}`;
}

/** First guess for the code line box; measured from the DOM after the first paint. */
const DEFAULT_LINE_HEIGHT = 19.2;

/**
 * How long a hover or a jump may take. Both are one round trip to a server that
 * is already warm — a cold one answers `undefined` immediately (the host starts
 * it in the background), so this only covers a slow project, never a download.
 */
const LSP_REQUEST_TIMEOUT_MS = 20_000;
/**
 * Diagnostics are the one thing worth waiting for: the host starts a server for
 * them, and a project that has to fetch one through `npx` is slow once.
 */
const LSP_DIAGNOSTICS_TIMEOUT_MS = 45_000;
/** A hover asks as the pointer moves; one request per still pointer is enough. */
const HOVER_DEBOUNCE_MS = 140;
/** The hover card's width, in px; the placement clamp needs to know it. */
const HOVER_CARD_WIDTH = 380;
/**
 * How long a hover outlives the pointer leaving the source. The card carries the
 * "Find references" button, so a pointer on its way there must not dismiss it.
 */
const HOVER_CLOSE_DELAY_MS = 260;
/**
 * How long the pointer has to stay on a symbol before the card pins itself.
 * Deliberate, not accidental: long enough that crossing a symbol on the way
 * somewhere else does not pin a card, short enough to reach on purpose. The ring
 * in the card counts this down, so the wait is visible rather than mysterious.
 */
const HOVER_LOCK_MS = 900;
/** How long the jumped-to line stays lit. */
const FLASH_MS = 900;

/**
 * A file opened from the Explorer, read by the host (`readFile`) and shown with
 * the same highlight.js the transcript uses.
 *
 * Read-only, with one exception that matters: dragging across the line numbers
 * picks a range and pins it to the next prompt as `path:start-end` — the browser
 * host's stand-in for VS Code's "add selection to chat". VS Code opens the real
 * editor for a file the user wants to change; this only reads and quotes.
 */
@Component({
  selector: 'morse-file-preview',
  templateUrl: './file-preview.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // Escape dismisses the card, locked or not — a pinned card must not be a trap
    // with only one small way out — and otherwise abandons a range being dragged.
    '(document:keydown.escape)': 'onEscape()',
    // A press anywhere outside the card does the same, which is what a reader
    // expects of a popover: the ✕ is a fallback, not the only way out.
    '(document:pointerdown)': 'onDocumentPointerDown($event)',
  },
  // A hover card carries the server's markdown, so it goes through the same
  // sanitised renderer the transcript uses rather than a second pipeline.
  imports: [Markdown, PinAnnotation, NoteHoverDirective],
  styleUrl: './file-preview.css',
})
export class FilePreview {
  readonly tab = input.required<FileTab>();

  private readonly tabs = inject(WorkspaceTabs);
  private readonly attachments = inject(AttachmentStore);
  private readonly animation = inject(AnimationService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly display = inject(DisplayPrefs);
  private readonly workspaceStore = inject(WorkspaceFilesStore);
  private readonly morse = inject(MorseService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly sourceElement = viewChild<ElementRef<HTMLElement>>('source');
  private readonly gutterElement = viewChild<ElementRef<HTMLElement>>('gutter');
  private readonly wrapElement = viewChild<ElementRef<HTMLElement>>('wrap');
  private readonly codeElement = viewChild<ElementRef<HTMLElement>>('code');
  private readonly hoverElement = viewChild<ElementRef<HTMLElement>>('hoverCard');

  /** The text without its final newline, so the gutter and the code line up. */
  private readonly source = computed(() => {
    const content = this.tab().content ?? '';
    return content.endsWith('\n') ? content.slice(0, -1) : content;
  });

  protected readonly lines = computed(() => {
    const source = this.source();
    const count = source.length === 0 ? 1 : source.split('\n').length;
    return Array.from({ length: count }, (_, index) => index + 1);
  });

  protected readonly highlighted = computed<SafeHtml>(() => {
    const tab = this.tab();
    if (tab.content === undefined || tab.binary) {
      return this.sanitizer.bypassSecurityTrustHtml('');
    }
    return this.sanitizer.bypassSecurityTrustHtml(highlightCode(this.source(), tab.language).html);
  });

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
            html: this.sanitizer.bypassSecurityTrustHtml(
              highlightCode(row.text, language).html,
            ),
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

  private readonly lineHeight = signal(DEFAULT_LINE_HEIGHT);
  private readonly selected = signal<{ start: number; end: number } | undefined>(undefined);

  /**
   * Whether this host can answer LSP questions at all. The browser host runs the
   * servers; VS Code leaves the capability off because its own LSP already owns
   * the files it opens.
   */
  protected readonly lspReady = computed(() => this.morse.capabilities()?.lsp === true);

  /** The hover card, when the pointer is on an identifier the server knows. */
  protected readonly hoverCard = signal<HoverCard | undefined>(undefined);
  /**
   * A card that stayed long enough to be pinned. It survives the pointer leaving,
   * ignores other hovers, and is ended by its own close button (or Escape).
   * Without it, reaching for the card's own "Find references" button dismisses
   * the card that carries it.
   */
  protected readonly hoverLocked = signal(false);
  /** The lock's clock, in ms, so the ring and the timer cannot drift apart. */
  protected readonly hoverLockMs = HOVER_LOCK_MS;
  /**
   * The language server's verdict on this file. `undefined` until it answers, and
   * `available: false` when no server covers the language — which the header says
   * out loud instead of showing a clean 0.
   */
  private readonly diagnostics = signal<LspDiagnostics | undefined>(undefined);
  protected readonly diagnosticsBusy = signal(false);
  /** Underlines, measured from real rects once the highlight is on screen. */
  protected readonly marks = signal<readonly DiagnosticMark[]>([]);
  protected readonly problemsOpen = signal(false);
  protected readonly references = signal<LspReferences | undefined>(undefined);
  protected readonly referencesOpen = signal(false);
  /** The references request is in flight; the panel says so instead of being blank. */
  protected readonly referencesBusy = signal(false);
  /**
   * What the panel says while there is nothing to list: a cold server answers
   * `undefined`, and a click that emptied the hover card must not leave nothing
   * behind at all.
   */
  protected readonly referencesNote = computed(() =>
    this.referencesBusy() ? 'Reading references…' : 'The language server did not answer.',
  );
  /** The line a jump landed on, lit briefly so the eye can find it. */
  protected readonly flash = signal<number | undefined>(undefined);

  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * What the pointer was over at the last move: the symbol a settle will ask
   * about, or `undefined` when it is off a symbol (whitespace, punctuation).
   */
  private hoverTarget: HoverTarget | undefined;
  private hoverCloseTimer: ReturnType<typeof setTimeout> | undefined;
  private hoverLockTimer: ReturnType<typeof setTimeout> | undefined;
  /** Guards against an older hover answering after a newer one. */
  private hoverSequence = 0;
  private marksTimer: ReturnType<typeof setTimeout> | undefined;
  /** The pin a drag started inside, so releasing edits it instead of adding. */
  private readonly editingId = signal<string | undefined>(undefined);
  /** The just-merged band, flashed briefly so the merge is visible. */
  protected readonly mergedId = signal<string | undefined>(undefined);
  private anchor = 1;

  /** The live drag's label (`L14–23`), shown in the header while dragging. */
  protected readonly rangeLabel = computed(() => rangeText(this.selected()));
  /**
   * Every range this file's chips carry, plus the drag in progress. The pins are
   * the source of truth, so removing a chip removes its highlight too — and a
   * second drag adds to the picture instead of replacing it.
   */
  protected readonly highlights = computed<readonly Highlight[]>(() => {
    const path = this.tab().path;
    const editing = this.editingId();
    const pinned: Highlight[] = this.attachments
      .pins()
      .filter(
        (pin) =>
          pin.path === path && pin.startLine !== undefined && pin.id !== editing,
      )
      .map((pin) => ({
        id: pin.id,
        start: pin.startLine as number,
        end: pin.endLine ?? (pin.startLine as number),
        note: pin.note,
      }));
    const live = this.selected();
    return live === undefined
      ? pinned
      : [...pinned, { id: 'live', start: live.start, end: live.end }];
  });
  /** Ranges already pinned to this file (the drag in progress is not one yet). */
  protected readonly pinnedCount = computed(
    () => this.highlights().filter((highlight) => highlight.id !== 'live').length,
  );

  protected topOf(highlight: Highlight): number {
    return (highlight.start - 1) * this.lineHeight();
  }

  /** The y-offset a line's top sits at, in the overlay's own space. */
  protected lineTop(line: number): number {
    return (line - 1) * this.lineHeight();
  }

  // --- the range annotations -------------------------------------------------

  /**
   * The pin whose annotation editor is open, and where the ✎ that opened it sits
   * on screen — the card is anchored there, wherever the trigger happened to be.
   */
  protected readonly annotationPin = signal<AnnotationPinRef | undefined>(undefined);
  protected readonly annotationAnchor = signal<PopoverAnchor | undefined>(undefined);

  /** What the editor's header names: this file, and the range being annotated. */
  protected readonly annotationTarget = computed<AnnotationTarget | undefined>(() => {
    const pin = this.annotationPin();
    return pin === undefined
      ? undefined
      : { path: this.tab().path, range: this.rangeOf(pin) };
  });

  /** The markdown the editor opens with (the pin's own note, if it has one). */
  protected readonly annotationNote = computed(() => this.annotationPin()?.note ?? '');

  /** The ✎ on a band: the highlight maps onto the pin shape the editor wants. */
  protected openBandAnnotation(highlight: Highlight, event: Event): void {
    this.openAnnotation(
      { id: highlight.id, note: highlight.note, startLine: highlight.start, endLine: highlight.end },
      event,
    );
  }

  /** The ✎ on a diff row, or on a band: open the editor anchored to it. */
  protected openAnnotation(pin: AnnotationPinRef, event: Event): void {
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

  /** The `L30-31` label the editor's header shows (absent for a whole-file pin). */
  private rangeOf(pin: AnnotationPinRef): string | undefined {
    if (pin.startLine === undefined) {
      return undefined;
    }
    const end = pin.endLine ?? pin.startLine;
    return end !== pin.startLine ? `L${pin.startLine}-${end}` : `L${pin.startLine}`;
  }

  /** A chip's annotation hint: first line, cut short — the hover card has the rest. */
  protected readonly pinNoteHint = pinNoteHint;

  /**
   * The pin whose range **ends** on this new-file anchor, so the one annotation
   * affordance per pin lands at the last row of what it covers (unified and
   * split alike; split looks only at the new-file anchor the rows already
   * carry). `undefined` when no pin of this file ends here.
   */
  protected notePinAt(anchor: number | undefined): PendingPin | undefined {
    if (anchor === undefined) {
      return undefined;
    }
    const path = this.tab().path;
    return (
      this.attachments
        .pins()
        .find(
          (pin) =>
            pin.path === path &&
            pin.startLine !== undefined &&
            (pin.endLine ?? pin.startLine) === anchor,
        )
    );
  }

  /**
   * The old side's affordance in the split view: it hosts the ✎ only when the
   * new side has **no** row at the pin's end — a deletion at the end of its
   * hunk leaves no new-file row behind — and never as a second button beside
   * the new side's.
   */
  protected splitOldNotePin(side: DiffRow | undefined, other: DiffRow | undefined): PendingPin | undefined {
    return this.notePinAt(other?.newAnchor) !== undefined
      ? undefined
      : this.notePinAt(side?.newAnchor);
  }

  /** Every problem the server reported for this file, in its own order. */
  protected readonly problems = computed(() => this.diagnostics()?.diagnostics ?? []);
  /** The header's count, split so an error reads differently from a warning. */
  protected readonly problemCounts = computed(() => {
    const list = this.problems();
    return {
      errors: list.filter((problem) => problem.severity === 'error').length,
      warnings: list.filter((problem) => problem.severity === 'warning').length,
      total: list.length,
    };
  });
  /**
   * Whether a language server covers this file. `undefined` until one answers,
   * `false` when none does — the header then says "no language server" rather
   * than letting an empty list read as a clean file.
   */
  protected readonly lspAvailable = computed(() => this.diagnostics()?.available);

  protected heightOf(highlight: Highlight): number {
    return (highlight.end - highlight.start + 1) * this.lineHeight();
  }

  constructor() {
    afterNextRender(() => this.measureLineHeight());
    // A different file starts with no pinned range, no problem list, no hover and
    // no references panel: all of it described the file that was in front.
    effect(() => {
      this.tab();
      untracked(() => {
        this.selected.set(undefined);
        this.annotationPin.set(undefined);
        this.annotationAnchor.set(undefined);
        this.diagnostics.set(undefined);
        this.marks.set([]);
        this.hoverCard.set(undefined);
        this.references.set(undefined);
        this.referencesOpen.set(false);
        this.problemsOpen.set(false);
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
    // Ask a language server about the file whenever it (or the mode) changes, so
    // the squiggles always describe the text on screen. A reload re-reads the
    // file, which lands here too.
    effect(() => {
      const tab = this.tab();
      const mode = this.mode();
      if (!this.lspReady() || mode !== 'file' || tab.content === undefined || tab.binary === true) {
        return;
      }
      untracked(() => void this.loadDiagnostics(tab.path));
    });
    // Underlines are drawn from real rects, and a rect only exists once the
    // highlighted HTML has been painted — so this measures one tick after the
    // content (or the diagnostics) changed, never before.
    effect(() => {
      this.diagnostics();
      this.highlighted();
      this.mode();
      this.lineHeight();
      untracked(() => this.scheduleMarks());
    });
    // A jump from a definition landed on a line: reveal it. The tab object is
    // replaced by `revealLine`, so asking for the same line twice still fires.
    effect(() => {
      const tab = this.tab();
      const line = tab.line;
      if (line === undefined || tab.content === undefined) {
        return;
      }
      untracked(() => this.revealLine(line));
    });
  }

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
   * Clicking a change block in either diff layout pins its new-file range to the
   * next prompt — the diff view's stand-in for dragging line numbers, so a click
   * is enough. Clicking an already-pinned block unpins it again.
   */
  protected toggleChange(row: UnifiedRow | DiffRow | undefined): void {
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
      this.attachments.removePin(covering.id);
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

  protected isSelected(line: number): boolean {
    return this.highlights().some(
      (highlight) => line >= highlight.start && line <= highlight.end,
    );
  }

  /**
   * Pointer down on a line number starts a range; moving extends it, and a click
   * (no movement) inside an existing highlight takes that highlight off — the
   * same toggle the diff view's change blocks use, so one gesture means one thing
   * in both surfaces.
   */
  protected startSelection(event: PointerEvent, line: number): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.anchor = line;
    // Dragging from inside an existing highlight edits it; from empty space it
    // starts a new one (which the store then merges with anything it touches).
    this.editingId.set(
      this.highlights().find(
        (highlight) =>
          highlight.id !== 'live' && line >= highlight.start && line <= highlight.end,
      )?.id,
    );
    this.selected.set({ start: line, end: line });
    const gutter = event.currentTarget as HTMLElement;
    try {
      gutter.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic event (a test) has no pointer to capture; the listeners below
      // still see the moves while the pointer is over the gutter.
    }
    // A click and a drag start the same way, so only the moves tell them apart.
    let dragged = false;
    const move = (moveEvent: PointerEvent): void => {
      const target = this.lineAt(moveEvent.clientY);
      if (target === undefined) {
        return;
      }
      dragged = true;
      this.selected.set({
        start: Math.min(this.anchor, target),
        end: Math.max(this.anchor, target),
      });
    };
    const stop = (): void => {
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', stop);
      gutter.removeEventListener('pointercancel', stop);
      const inside = this.editingId();
      if (!dragged && inside !== undefined) {
        // Clicking a highlighted line number removes that highlight, and with it
        // the chip on the next prompt (`highlights()` is derived from the pins).
        this.clearSelection();
        this.attachments.removePin(inside);
        this.attachments.say('info', `Removed the ${this.tab().title} highlight.`);
        return;
      }
      this.pinSelection();
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', stop);
    gutter.addEventListener('pointercancel', stop);
  }

  protected clearSelection(): void {
    this.selected.set(undefined);
    this.editingId.set(undefined);
  }

  /**
   * The band's own "Cancel": removes the highlight it belongs to, and with it the
   * chip on the next prompt (`highlights()` is derived from the pins). The `live`
   * band is a drag still in progress — not a pin — so cancelling it only abandons
   * the drag.
   */
  protected removeHighlight(event: Event, highlight: Highlight): void {
    // The band sits beside the source, but a click that reaches the code surface
    // should never be read as "follow this identifier".
    event.stopPropagation();
    this.clearSelection();
    // A removed band must not leave its annotation editor behind pointing at a
    // pin that no longer exists.
    if (this.annotationPin()?.id === highlight.id) {
      this.closeAnnotation();
    }
    if (highlight.id === 'live') {
      return;
    }
    this.attachments.removePin(highlight.id);
    this.attachments.say('info', `Removed the ${this.tab().title} highlight.`);
  }

  /**
   * Escape: the hover card first (the newest thing on screen), then a drag in
   * progress, so a range being dragged can be abandoned without pinning it. A
   * highlight that was already pinned is not removed here — it is a chip on the
   * next prompt, and its line number is what toggles it off.
   */
  protected onEscape(): void {
    if (this.hoverCard() !== undefined || this.hoverLockTimer !== undefined) {
      this.clearHover();
      return;
    }
    if (this.selected() !== undefined) {
      this.clearSelection();
    }
  }

  protected reload(): void {
    this.tabs.reload(this.tab().id);
  }

  /**
   * Grab a highlight's top or bottom edge and move that boundary. Each move
   * rewrites the pin, so the store's coalescing merges it the moment the edge
   * touches a neighbouring range — "bersentuhan langsung merged".
   */
  protected startResizeEdge(
    event: PointerEvent,
    highlight: Highlight,
    edge: 'start' | 'end',
  ): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic event (a test) has no pointer to capture.
    }
    const move = (moveEvent: PointerEvent): void => {
      const line = this.lineAt(moveEvent.clientY);
      if (line === undefined) {
        return;
      }
      // Read the pin again: it is the same range, moved — not merged.
      const current = this.attachments.pins().find((pin) => pin.id === highlight.id);
      const baseStart = current?.startLine ?? highlight.start;
      const baseEnd = current?.endLine ?? baseStart;
      const start = edge === 'start' ? Math.min(line, baseEnd) : baseStart;
      const end = edge === 'end' ? Math.max(line, baseStart) : baseEnd;
      this.attachments.setPinRange(highlight.id, {
        startLine: start,
        endLine: end > start ? end : undefined,
      });
    };
    const stop = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      // Released: only now does a boundary that reached a neighbour coalesce,
      // and the union keeps the full length of both.
      const current = this.attachments.pins().find((pin) => pin.id === highlight.id);
      if (current?.startLine !== undefined) {
        const before = this.attachments.pins().length;
        const id = this.attachments.pin(
          { path: this.tab().path, startLine: current.startLine, endLine: current.endLine },
          highlight.id,
        );
        if (this.attachments.pins().length < before) {
          // The boundary met a neighbour and swallowed it: show the union.
          this.celebrate(id, { start: current.startLine, end: current.endLine ?? current.startLine });
        }
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  // --- the language server ---------------------------------------------------

  /** The `lsp*` arguments for a position, `cwd` included exactly like `readFile`. */
  private args(path: string, point?: SourcePoint): Record<string, unknown> {
    const cwd = this.tab().projectCwd;
    const base: Record<string, unknown> = { path, ...(cwd === undefined ? {} : { cwd }) };
    return point === undefined
      ? base
      : { ...base, line: point.line, character: point.character };
  }

  /** Asks for this file's problem list. The host starts a server if it must. */
  private async loadDiagnostics(path: string): Promise<void> {
    this.diagnosticsBusy.set(true);
    try {
      const answer = await this.morse.requestHostCommand(
        'lspDiagnostics',
        this.args(path),
        LSP_DIAGNOSTICS_TIMEOUT_MS,
      );
      if (this.tab().path !== path) {
        // The reader moved on while the server was starting; the answer describes
        // a file that is no longer in front.
        return;
      }
      this.diagnostics.set(asDiagnostics(answer));
    } finally {
      this.diagnosticsBusy.set(false);
    }
  }

  private scheduleMarks(): void {
    if (this.marksTimer !== undefined) {
      clearTimeout(this.marksTimer);
    }
    this.marksTimer = setTimeout(() => {
      this.marksTimer = undefined;
      this.measureMarks();
    }, 0);
  }

  /**
   * Turns each diagnostic into the rects it covers, in the overlay's own space.
   * A diagnostic that spans lines (a missing brace) yields one rect per line, so
   * every part of it is underlined instead of a band across the whole block.
   */
  private measureMarks(): void {
    const source = this.sourceElement()?.nativeElement;
    const wrap = this.wrapElement()?.nativeElement;
    const answer = this.diagnostics();
    if (
      source === undefined ||
      wrap === undefined ||
      answer === undefined ||
      this.mode() !== 'file'
    ) {
      this.marks.set([]);
      return;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const text = this.source();
    const marks: DiagnosticMark[] = [];
    answer.diagnostics.forEach((problem, index) => {
      const start = offsetAt(text, problem.range.start);
      const end = Math.max(start + 1, offsetAt(text, problem.range.end));
      const range = domRangeFor(source, start, end);
      if (range === undefined) {
        return;
      }
      // `Range.getClientRects` is the measurement this needs, but it is not in
      // every DOM (jsdom, older WebKit). Without it the file simply gets no
      // underlines; the problem list in the header still names them.
      const rects = typeof range.getClientRects === 'function' ? [...range.getClientRects()] : [];
      for (const [part, rect] of rects.entries()) {
        if (rect.width <= 0 && rect.height <= 0) {
          continue;
        }
        marks.push({
          id: `${index}:${part}`,
          severity: problem.severity,
          message: problem.message,
          top: rect.top - wrapRect.top,
          left: rect.left - wrapRect.left,
          width: Math.max(rect.width, 2),
          height: rect.height,
        });
      }
    });
    this.marks.set(marks);
  }

  /** The source position under a pointer, or `undefined` when it is not over text. */
  private pointOf(event: MouseEvent): SourcePoint | undefined {
    const source = this.sourceElement()?.nativeElement;
    if (source === undefined) {
      return undefined;
    }
    const caret = caretAt(event.clientX, event.clientY);
    if (caret === undefined) {
      return undefined;
    }
    const offset = sourceOffsetIn(source, caret.node, caret.offset);
    return offset === undefined ? undefined : pointAt(this.source(), offset);
  }

  /**
   * Moving over the code decides, once the pointer settles, whether to ask for a
   * hover or to let one go. Nothing is decided on the move itself: a cursor
   * crossing a word (or a bracket) on its way somewhere else must not cost a
   * pinned card. `HOVER_DEBOUNCE_MS` is what tells "resting here" from "passing
   * through", and it is the single knob both halves of that rule share.
   */
  protected onSourceMove(event: PointerEvent): void {
    if (!this.lspReady() || this.mode() !== 'file') {
      return;
    }
    const point = this.pointOf(event);
    const span = point === undefined ? undefined : identifierAt(this.source(), point);
    this.hoverTarget =
      point === undefined || span === undefined
        ? undefined
        : {
            point,
            // `line:start-end`: every character of one identifier yields the same
            // key, so a pointer resting on a word is not a move to a new symbol.
            key: `${point.line}:${span.start}-${span.end}`,
            clientX: event.clientX,
            clientY: event.clientY,
          };
    if (this.hoverTimer !== undefined) {
      clearTimeout(this.hoverTimer);
    }
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = undefined;
      this.settleHover();
    }, HOVER_DEBOUNCE_MS);
  }

  /**
   * The pointer has stopped. On a symbol that is not the one showing, the card is
   * replaced (`askHover` clears it first, so the old one goes at once); off a
   * symbol, an *unpinned* card has been left behind. A pinned card survives both,
   * because that is what pinning buys — reaching for its own buttons must not end
   * it — and only a hover on another symbol takes it over.
   */
  private settleHover(): void {
    const target = this.hoverTarget;
    if (target === undefined) {
      if (!this.hoverLocked()) {
        this.clearHover();
      }
      return;
    }
    if (this.hoverCard()?.key === target.key) {
      // Already showing this symbol: keep the card, and keep its lock clock
      // counting rather than restarting it under a resting pointer.
      return;
    }
    void this.askHover(target);
  }

  protected onSourceLeave(): void {
    // The pointer is off the code, so nothing pending may fire for where it was:
    // a settle that landed after the pointer left would ask for a hover nobody is
    // pointing at, and clearing the card would cancel the close grace instead.
    this.hoverTarget = undefined;
    if (this.hoverTimer !== undefined) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = undefined;
    }
    if (this.hoverLocked()) {
      // Pinned: the pointer may go anywhere, including onto the card's buttons.
      return;
    }
    if (this.hoverCard() === undefined) {
      this.clearHover();
      return;
    }
    this.cancelHoverClose();
    this.hoverCloseTimer = setTimeout(() => {
      this.hoverCloseTimer = undefined;
      this.clearHover();
    }, HOVER_CLOSE_DELAY_MS);
  }

  /** The pointer is on the card: it is not leaving, whatever the source says. */
  protected cancelHoverClose(): void {
    if (this.hoverCloseTimer !== undefined) {
      clearTimeout(this.hoverCloseTimer);
      this.hoverCloseTimer = undefined;
    }
  }

  /** The close button, and Escape. */
  protected closeHover(): void {
    if (this.hoverCard() === undefined && this.hoverLockTimer === undefined) {
      return;
    }
    this.clearHover();
  }

  /**
   * A press outside the card dismisses it, pinned or not. Clicks that land *on*
   * the card are its own controls — Copy, Find references, the ✕ — so they are
   * left alone; everything else (the code, the gutter, the sidebar, the header)
   * is "somewhere else".
   */
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (this.hoverCard() === undefined) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && this.hoverElement()?.nativeElement.contains(target) === true) {
      return;
    }
    this.clearHover();
  }

  /**
   * The clock that pins the card. It runs whether the pointer is on the symbol
   * or has moved onto the card itself — the point is that the reader is still
   * reading it — and only a new symbol, Escape or the close button stops it.
   */
  private startLockTimer(): void {
    this.cancelLockTimer();
    this.hoverLockTimer = setTimeout(() => {
      this.hoverLockTimer = undefined;
      this.hoverLocked.set(true);
    }, HOVER_LOCK_MS);
  }

  private cancelLockTimer(): void {
    if (this.hoverLockTimer !== undefined) {
      clearTimeout(this.hoverLockTimer);
      this.hoverLockTimer = undefined;
    }
  }

  /** Clicking an identifier follows it to its definition, the mouse's F12. */
  protected onSourceClick(event: MouseEvent): void {
    void this.followDefinition(event);
  }

  private async askHover(target: HoverTarget): Promise<void> {
    // Another symbol has the pointer now, so the card showing the previous one goes
    // at once rather than lingering while the host answers — an editor's behaviour.
    // What keeps that from firing on a cursor that is merely passing through is the
    // settle in `onSourceMove`, not this.
    this.clearHover();
    const sequence = (this.hoverSequence += 1);
    const { point } = target;
    const answer = await this.morse.requestHostCommand(
      'lspHover',
      this.args(this.tab().path, point),
      LSP_REQUEST_TIMEOUT_MS,
    );
    if (sequence !== this.hoverSequence) {
      // A newer hover already answered; this one describes where the pointer was.
      return;
    }
    const hover = asHover(answer);
    if (hover === undefined) {
      // Cleared above: the symbol has nothing to show, and the card that described
      // the previous one is already gone.
      return;
    }
    this.hoverCard.set(
      this.placeCard(hover.contents, point, target.key, target.clientX, target.clientY),
    );
    this.startLockTimer();
  }

  private clearHover(): void {
    // Bumping the sequence abandons a hover already in flight.
    this.hoverSequence += 1;
    if (this.hoverTimer !== undefined) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = undefined;
    }
    this.cancelHoverClose();
    this.cancelLockTimer();
    this.hoverLocked.set(false);
    this.hoverCard.set(undefined);
  }

  /**
   * Just under the pointer, clamped into the pane. The card lives on the host
   * rather than inside the scrolling content, so scrolling does not drag it away
   * from the symbol it is describing.
   */
  private placeCard(
    contents: string,
    point: SourcePoint,
    key: string,
    clientX: number,
    clientY: number,
  ): HoverCard {
    const bounds = this.host.nativeElement.getBoundingClientRect();
    return {
      contents,
      point,
      key,
      left: Math.max(6, Math.min(clientX - bounds.left + 12, Math.max(6, bounds.width - HOVER_CARD_WIDTH - 6))),
      top: Math.max(6, Math.min(clientY - bounds.top + 18, Math.max(6, bounds.height - 48))),
    };
  }

  private async followDefinition(event: MouseEvent): Promise<void> {
    if (!this.lspReady() || this.mode() !== 'file') {
      return;
    }
    const point = this.pointOf(event);
    if (point === undefined || identifierAt(this.source(), point) === undefined) {
      return;
    }
    const answer = await this.morse.requestHostCommand(
      'lspDefinition',
      this.args(this.tab().path, point),
      LSP_REQUEST_TIMEOUT_MS,
    );
    const location = asLocation(answer);
    if (location === undefined) {
      return;
    }
    this.clearHover();
    this.jump(location);
  }

  /** Opens a location: this file scrolls to the line, another earns its own tab. */
  protected jump(location: LspLocation): void {
    const line = location.range.start.line + 1;
    if (location.path === this.tab().path) {
      this.tabs.revealLine(this.tab().id, line);
      return;
    }
    this.tabs.openFile(location.path, line);
  }

  /** A problem row: the target is this file, so there is no tab to open. */
  protected jumpToLine(line: number): void {
    this.tabs.revealLine(this.tab().id, line);
  }

  protected showReferences(card: HoverCard): void {
    // The card has said what it can: the panel is the answer now, so the card
    // steps aside rather than sitting on top of the list it just asked for. The
    // panel opens immediately, before the answer, so a slow server shows
    // "Reading references…" instead of nothing.
    this.clearHover();
    this.references.set(undefined);
    this.referencesOpen.set(true);
    this.problemsOpen.set(false);
    void this.loadReferences(card.point);
  }

  private async loadReferences(point: SourcePoint): Promise<void> {
    const path = this.tab().path;
    this.referencesBusy.set(true);
    try {
      const answer = await this.morse.requestHostCommand(
        'lspReferences',
        this.args(path, point),
        LSP_REQUEST_TIMEOUT_MS,
      );
      if (this.tab().path !== path) {
        // The reader moved on; the tab effect has already cleared the panel.
        return;
      }
      this.references.set(asReferences(answer));
    } finally {
      this.referencesBusy.set(false);
    }
  }

  protected closeReferences(): void {
    this.referencesOpen.set(false);
    this.references.set(undefined);
  }

  /** The header's problem list and the references panel share the one slot. */
  protected toggleProblems(): void {
    this.problemsOpen.update((open) => !open);
    this.referencesOpen.set(false);
  }

  protected problemTitle(): string {
    const counts = this.problemCounts();
    const parts: string[] = [];
    if (counts.errors > 0) {
      parts.push(`${counts.errors} error${counts.errors === 1 ? '' : 's'}`);
    }
    if (counts.warnings > 0) {
      parts.push(`${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`);
    }
    const others = counts.total - counts.errors - counts.warnings;
    if (others > 0) {
      parts.push(`${others} more`);
    }
    return parts.join(', ');
  }

  /**
   * Brings a jumped-to line into view, centred when it is out of sight, and lights
   * it briefly: a landing point is easy to lose in a long file.
   */
  private revealLine(line: number): void {
    setTimeout(() => {
      const code = this.codeElement()?.nativeElement;
      if (code === undefined) {
        return;
      }
      this.measureLineHeight();
      const height = this.lineHeight();
      const top = (line - 1) * height;
      if (top < code.scrollTop || top + height > code.scrollTop + code.clientHeight) {
        code.scrollTop = Math.max(0, top - code.clientHeight / 2 + height / 2);
      }
      this.flash.set(line);
      setTimeout(() => {
        if (this.flash() === line) {
          this.flash.set(undefined);
        }
      }, FLASH_MS);
    }, 0);
  }

  private measureLineHeight(): void {
    const source = this.sourceElement()?.nativeElement;
    if (source === undefined) {
      return;
    }
    const height = Number.parseFloat(getComputedStyle(source).lineHeight);
    if (Number.isFinite(height) && height > 0) {
      this.lineHeight.set(height);
    }
  }

  private lineAt(clientY: number): number | undefined {
    const gutter = this.gutterElement()?.nativeElement;
    if (gutter === undefined) {
      return undefined;
    }
    const top = gutter.getBoundingClientRect().top;
    const line = Math.floor((clientY - top) / this.lineHeight()) + 1;
    return Math.min(this.lines().length, Math.max(1, line));
  }

  /** The drag just ended: the range becomes a chip on the next prompt. */
  private pinSelection(): void {
    const selection = this.selected();
    if (selection === undefined) {
      return;
    }
    const endLine = selection.end > selection.start ? selection.end : undefined;
    const before = this.attachments.pins().length;
    const id = this.attachments.pin(
      { path: this.tab().path, startLine: selection.start, endLine },
      this.editingId(),
    );
    if (this.attachments.pins().length < before) {
      this.celebrate(id, { start: selection.start, end: selection.end });
    }
    this.attachments.say('info', `Pinned ${this.tab().title} ${this.rangeLabel()} to this message.`);
    // The chip now owns this highlight; keeping the live range would draw it twice.
    this.selected.set(undefined);
    this.editingId.set(undefined);
  }

  /**
   * Two ranges became one: flash the merged band and throw confetti from the
   * seam, so the merge is something the user sees rather than a chip that
   * silently disappeared.
   */
  private celebrate(id: string, range: { start: number; end: number }): void {
    if (id.length === 0) {
      return;
    }
    this.mergedId.set(id);
    setTimeout(() => {
      if (this.mergedId() === id) {
        this.mergedId.set(undefined);
      }
    }, 720);

    const merged = this.attachments.pins().find((pin) => pin.id === id);
    const wrap = this.sourceElement()?.nativeElement.closest('.source-wrap');
    if (merged?.startLine === undefined || !(wrap instanceof HTMLElement)) {
      return;
    }
    const mergedStart = merged.startLine;
    const mergedEnd = merged.endLine ?? mergedStart;
    const lineHeight = this.lineHeight();
    // Burst from the seam the neighbour sat on: the side the range grew toward.
    const seamY =
      mergedEnd > range.end
        ? range.end * lineHeight
        : mergedStart < range.start
          ? (range.start - 1) * lineHeight
          : ((range.start + range.end) / 2 - 0.5) * lineHeight;
    this.animation.confetti(wrap, { x: wrap.clientWidth / 2, y: seamY });
  }
}

/**
 * The text node and offset under a viewport point. Two APIs exist for this: the
 * standards-track `caretPositionFromPoint` and WebKit's older
 * `caretRangeFromPoint`. Neither is guaranteed in a webview, so both are tried,
 * and a DOM that offers neither simply gets no hover.
 */
function caretAt(clientX: number, clientY: number): { node: Node; offset: number } | undefined {
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(clientX, clientY);
  if (position !== undefined && position !== null) {
    return { node: position.offsetNode, offset: position.offset };
  }
  const range = doc.caretRangeFromPoint?.(clientX, clientY);
  if (range === undefined || range === null) {
    return undefined;
  }
  return { node: range.startContainer, offset: range.startOffset };
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
