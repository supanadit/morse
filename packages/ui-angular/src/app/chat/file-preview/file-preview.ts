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
import { AnimationService } from '../../core/animation.service';
import { AttachmentStore } from '../../core/attachments';
import { DisplayPrefs, type DiffView } from '../../core/display-prefs';
import { statusByPath } from '../../core/git-status';
import { highlightCode } from '../../core/highlight';
import { WorkspaceFiles } from '../../core/workspace-files';
import { WorkspaceTabs, type FileTab } from '../../core/workspace-tabs';
import {
  addedFileDiff,
  parseUnifiedDiff,
  splitRows,
  unifiedRows,
  type DiffRow,
  type SplitRow,
  type UnifiedRow,
} from './git-diff';

/** One highlighted range in the preview: a pinned chip, or the drag in progress. */
interface Highlight {
  id: string;
  start: number;
  end: number;
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
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        min-width: 0;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: none;
        min-height: var(--morse-head-height);
        padding: 0 10px 0 14px;
        border-bottom: 1px solid var(--morse-border);
      }
      .path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--morse-font-mono);
        font-size: 12px;
        color: var(--morse-fg);
      }
      /* The commit a file's diff belongs to, beside its path. */
      .commit-ref {
        flex: none;
        padding: 0 6px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--morse-fg-muted) 12%, transparent);
        color: var(--morse-fg-muted);
        font-family: var(--morse-font-mono);
        font-size: 10px;
        line-height: 16px;
      }
      .meta {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: none;
      }
      .badge {
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--morse-badge-bg, var(--morse-hover));
        color: var(--morse-fg-muted);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .stat {
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      /* The pinned range, right where the drag happened. */
      .range {
        padding: 1px 7px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--morse-accent) 22%, transparent);
        color: var(--morse-fg);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      .icon {
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: none;
        color: var(--morse-fg-muted);
        cursor: pointer;
      }
      .icon:hover:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      /* The File / Unified / Split switch, shown only for a changed file. */
      .modes {
        display: inline-flex;
        flex: none;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        overflow: hidden;
      }
      .modes button {
        padding: 2px 8px;
        border: 0;
        background: transparent;
        color: var(--morse-fg-muted);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .modes button + button {
        border-left: 1px solid var(--morse-border);
      }
      .modes button:hover:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .modes button.on {
        background: color-mix(in srgb, var(--morse-accent) 24%, transparent);
        color: var(--morse-fg);
      }
      /* The two diff layouts share the code surface and its metrics. */
      .diff {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 6px 0;
        background: var(--morse-code-bg, var(--morse-bg));
        font-family: var(--morse-font-mono);
        font-size: 12px;
        line-height: 1.6;
      }
      .drow,
      .srow {
        display: flex;
        align-items: stretch;
        min-height: 1.6em;
      }
      .dtext {
        flex: 1;
        min-width: 0;
        padding: 0 16px 0 6px;
        /*
         * A long diff line wraps onto the next visual line instead of running
         * under the neighbouring side. Both sides of a .srow grow together
         * (align-items: stretch), so the old/new pairing stays one row.
         */
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .dnum {
        flex: none;
        min-width: 44px;
        padding: 0 8px 0 10px;
        color: var(--morse-fg-muted);
        text-align: right;
        user-select: none;
        font-variant-numeric: tabular-nums;
        opacity: 0.7;
      }
      .dsign {
        flex: none;
        width: 14px;
        text-align: center;
        color: var(--morse-fg-muted);
        user-select: none;
      }
      .drow.add,
      .side.add {
        background: color-mix(in srgb, var(--morse-success) 14%, transparent);
      }
      .drow.del,
      .side.del {
        background: color-mix(in srgb, var(--morse-error) 14%, transparent);
      }
      .drow.add .dsign,
      .side.add .dsign {
        color: var(--morse-success);
      }
      .drow.del .dsign,
      .side.del .dsign {
        color: var(--morse-error);
      }
      /*
       * A change block is clickable: one click pins its new-file range to the
       * next prompt, the same chip a dragged range makes in the File view.
       */
      .drow.clickable,
      .side.clickable {
        cursor: pointer;
      }
      .drow.clickable:hover,
      .side.clickable:hover {
        background: color-mix(in srgb, var(--morse-accent) 12%, transparent);
      }
      .drow.pinned,
      .side.pinned {
        background: color-mix(in srgb, var(--morse-accent) 22%, transparent);
        box-shadow: inset 2px 0 0 color-mix(in srgb, var(--morse-accent) 70%, transparent);
      }
      .drow.hunk {
        margin: 6px 0 2px;
        padding: 2px 12px;
        background: var(--morse-code-head, var(--morse-hover));
        color: var(--morse-fg-muted);
      }
      .srow .side {
        flex: 1 1 50%;
        min-width: 0;
        display: flex;
        align-items: stretch;
        border-left: 1px solid var(--morse-border);
      }
      .srow .side:first-child {
        border-left: 0;
      }
      .code {
        display: flex;
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 8px 0;
        background: var(--morse-code-bg, var(--morse-bg));
      }
      pre,
      .gutter {
        margin: 0;
        font-family: var(--morse-font-mono);
        font-size: 12px;
        line-height: 1.6;
      }
      /*
       * The gutter is the drag surface. It stays put while the source scrolls
       * sideways, so the numbers a drag started on do not slide away.
       */
      .gutter {
        flex: none;
        position: sticky;
        left: 0;
        z-index: 2;
        padding: 0 10px 0 14px;
        color: var(--morse-fg-muted);
        text-align: right;
        user-select: none;
        background: var(--morse-code-bg, var(--morse-bg));
        opacity: 0.7;
      }
      .gutter .num {
        display: block;
        height: 1.6em;
        cursor: pointer;
        font-variant-numeric: tabular-nums;
      }
      .gutter .num.selected {
        color: var(--morse-fg);
        background: color-mix(in srgb, var(--morse-accent) 34%, transparent);
        opacity: 1;
      }
      .source-wrap {
        position: relative;
        flex: 1;
        min-width: 0;
      }
      .source {
        position: relative;
        z-index: 1;
        padding: 0 16px 0 4px;
        white-space: pre;
      }
      .selection {
        position: absolute;
        left: 0;
        right: 0;
        z-index: 2;
        pointer-events: none;
        background: color-mix(in srgb, var(--morse-accent) 16%, transparent);
        border-left: 2px solid color-mix(in srgb, var(--morse-accent) 70%, transparent);
      }
      /* A merge flashes the band, so the union is seen even if the particles are. */
      .selection.merged {
        animation: selection-merged 620ms ease-out;
      }
      @keyframes selection-merged {
        0% {
          background: color-mix(in srgb, var(--morse-accent) 60%, transparent);
          box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--morse-accent) 80%, transparent);
        }
        100% {
          background: color-mix(in srgb, var(--morse-accent) 16%, transparent);
          box-shadow: inset 0 0 0 0 transparent;
        }
      }
      /*
       * A rainbow ring that spins once around the merged band — border only, so
       * the text underneath stays readable. The angle is a registered custom
       * property, which is what lets a conic gradient animate at all.
       */
      @property --morse-rainbow {
        syntax: '<angle>';
        initial-value: 0deg;
        inherits: false;
      }
      .selection.merged::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 3px;
        padding: 2px;
        background: conic-gradient(
          from var(--morse-rainbow),
          #f43f5e,
          #fb923c,
          #facc15,
          #4ade80,
          #38bdf8,
          #a78bfa,
          #f43f5e
        );
        -webkit-mask:
          linear-gradient(#000 0 0) content-box,
          linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask:
          linear-gradient(#000 0 0) content-box,
          linear-gradient(#000 0 0);
        mask-composite: exclude;
        pointer-events: none;
        animation: morse-rainbow-spin 700ms linear;
      }
      @keyframes morse-rainbow-spin {
        from {
          --morse-rainbow: 0deg;
        }
        to {
          --morse-rainbow: 360deg;
        }
      }
      /* The band's top and bottom edges are drag handles, like the Explorer pane's
         top edge: pull one to move that boundary. */
      .edge {
        position: absolute;
        left: 0;
        right: 0;
        height: 6px;
        pointer-events: auto;
        cursor: ns-resize;
      }
      .edge.top {
        top: -3px;
      }
      .edge.bottom {
        bottom: -3px;
      }
      .edge:hover {
        background: color-mix(in srgb, var(--morse-accent) 70%, transparent);
      }
      .hint {
        margin: 0;
        padding: 12px 16px;
        color: var(--morse-fg-muted);
        font-size: 12px;
      }
      .hint.error {
        color: var(--morse-warn);
      }
    `,
  ],
})
export class FilePreview {
  readonly tab = input.required<FileTab>();

  private readonly tabs = inject(WorkspaceTabs);
  private readonly attachments = inject(AttachmentStore);
  private readonly animation = inject(AnimationService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly display = inject(DisplayPrefs);
  private readonly workspace = inject(WorkspaceFiles);
  private readonly sourceElement = viewChild<ElementRef<HTMLElement>>('source');
  private readonly gutterElement = viewChild<ElementRef<HTMLElement>>('gutter');

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
    statusByPath(this.workspace.status()).get(this.tab().path),
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

  protected heightOf(highlight: Highlight): number {
    return (highlight.end - highlight.start + 1) * this.lineHeight();
  }

  constructor() {
    afterNextRender(() => this.measureLineHeight());
    // A different file starts with no pinned range.
    effect(() => {
      this.tab();
      untracked(() => this.selected.set(undefined));
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

  /** Pointer down on a line number starts a range; moving extends it. */
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
    const move = (moveEvent: PointerEvent): void => {
      const target = this.lineAt(moveEvent.clientY);
      if (target === undefined) {
        return;
      }
      this.selected.set({
        start: Math.min(this.anchor, target),
        end: Math.max(this.anchor, target),
      });
    };
    const stop = (): void => {
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', stop);
      gutter.removeEventListener('pointercancel', stop);
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
