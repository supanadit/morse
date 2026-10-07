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
import { AnimationService } from '../../core/animation.service';
import { AttachmentStore } from '../../core/attachments';
import { DisplayPrefs, type DiffView } from '../../core/display-prefs';
import { statusByPath } from '../../core/git-status';
import { highlightCode } from '../../core/highlight';
import { asDiagnostics, asHover, asLocation, asReferences } from '../../core/lsp';
import { MorseService } from '../../core/morse.service';
import { WorkspaceFiles } from '../../core/workspace-files';
import { WorkspaceTabs, type FileTab } from '../../core/workspace-tabs';
import { Markdown } from '../../shared/markdown/markdown';
import {
  domRangeFor,
  identifierAt,
  offsetAt,
  pointAt,
  sourceOffsetIn,
  type SourcePoint,
} from './preview-positions';
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
  imports: [Markdown],
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        min-width: 0;
        /* The hover card is positioned against the pane, not the scrolled code. */
        position: relative;
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
      /*
       * Each band's own way out, at the corner it ends in. It sits above the
       * bottom resize edge (z-index) so a click near the corner cancels rather
       * than starting a resize, and it is the one part of the band that takes
       * pointer events — the band itself stays inert so text can still be
       * selected and identifiers clicked through it.
       */
      .cancel {
        position: absolute;
        right: 8px;
        bottom: -9px;
        z-index: 3;
        padding: 1px 7px;
        border: 1px solid var(--morse-border);
        border-radius: 6px;
        background: var(--morse-panel, var(--morse-bg));
        color: var(--morse-fg-muted);
        font: inherit;
        font-size: 10.5px;
        line-height: 15px;
        cursor: pointer;
        pointer-events: auto;
        opacity: 0.72;
      }
      /*
       * The same specificity the global button:hover:not(:disabled) has, so the
       * band's button does not paint the theme accent on hover (see AGENTS.md).
       */
      .cancel:hover:not(:disabled),
      .cancel:focus-visible {
        opacity: 1;
        color: var(--morse-fg);
        border-color: color-mix(in srgb, var(--morse-error) 45%, var(--morse-border));
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
      /* The header's problem count: a click opens the list below it. */
      .problems {
        display: flex;
        align-items: center;
        gap: 3px;
        flex: none;
        padding: 1px 6px;
        border: 0;
        border-radius: 5px;
        background: color-mix(in srgb, var(--morse-warn) 16%, transparent);
        color: var(--morse-warn);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .problems.errors {
        background: color-mix(in srgb, var(--morse-error) 16%, transparent);
        color: var(--morse-error);
      }
      .problems:hover:not(:disabled) {
        background: color-mix(in srgb, currentColor 26%, transparent);
      }
      .lsp-none,
      .lsp-busy {
        flex: none;
        font-size: 10.5px;
        color: var(--morse-fg-muted);
      }
      /*
       * The problem list and the references panel share one slot under the header:
       * both answer "what did the server say", and only one at a time is useful.
       */
      .lsp-panel {
        flex: none;
        max-height: 30vh;
        overflow: auto;
        border-bottom: 1px solid var(--morse-border);
        background: var(--morse-panel, var(--morse-bg));
      }
      .lsp-panel-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 10px;
        border-bottom: 1px solid var(--morse-border);
      }
      .lsp-panel-title {
        flex: 1;
        font-size: 11px;
        color: var(--morse-fg-muted);
      }
      .lsp-row {
        display: flex;
        align-items: baseline;
        gap: 8px;
        width: 100%;
        padding: 3px 10px;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        font-size: 11.5px;
        text-align: left;
        cursor: pointer;
      }
      .lsp-row:hover:not(:disabled) {
        background: var(--morse-hover);
      }
      .lsp-row-path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .lsp-row-line {
        flex: none;
        color: var(--morse-fg-muted);
        font-family: var(--morse-font-mono);
        font-size: 10.5px;
      }
      .lsp-row.problem.error .lsp-row-path {
        color: var(--morse-error);
      }
      .lsp-row.problem.warning .lsp-row-path {
        color: var(--morse-warn);
      }
      /*
       * A diagnostic is an overlay, not markup in the code: the HTML comes from
       * highlight.js, and the mark's rect is measured from a real Range, so it
       * underlines exactly the characters the server named.
       */
      .mark {
        position: absolute;
        z-index: 2;
        pointer-events: auto;
        border-bottom: 2px solid currentColor;
        color: var(--morse-warn);
        opacity: 0.85;
        cursor: help;
      }
      .mark.error {
        color: var(--morse-error);
      }
      .mark.warning {
        color: var(--morse-warn);
      }
      .mark.information,
      .mark.hint {
        color: var(--morse-info, var(--morse-fg-muted));
        border-bottom-style: dotted;
      }
      /* The line a jump landed on, lit once so the eye can find it. */
      .flash {
        position: absolute;
        left: 0;
        right: 0;
        z-index: 1;
        height: 1.6em;
        pointer-events: none;
        background: color-mix(in srgb, var(--morse-accent) 22%, transparent);
        animation: flash-line 900ms ease-out;
      }
      @keyframes flash-line {
        0% {
          background: color-mix(in srgb, var(--morse-accent) 45%, transparent);
        }
        100% {
          background: transparent;
        }
      }
      /*
       * The hover card sits on the host, not inside the scrolling source: a card
       * that scrolled with the text would drift away from the symbol it explains.
       */
      .hover-card {
        position: absolute;
        z-index: 6;
        width: 380px;
        max-height: 40vh;
        overflow: auto;
        padding: 6px 10px 4px;
        border: 1px solid var(--morse-border);
        border-radius: 8px;
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
        font-size: 11.5px;
      }
      .hover-body {
        /* The server's markdown: code blocks keep their own scroll, prose wraps. */
        overflow-wrap: anywhere;
      }
      .hover-foot {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 2px;
        border-top: 1px solid var(--morse-border);
      }
      .hover-refs {
        flex: 1;
        min-width: 0;
        padding: 2px 0;
        border: 0;
        background: none;
        color: var(--morse-accent);
        font: inherit;
        font-size: 11px;
        text-align: left;
        cursor: pointer;
      }
      .hover-refs:hover:not(:disabled) {
        text-decoration: underline;
      }
      /* The countdown to a pinned card: a ring that closes as the clock runs. */
      .lock-ring {
        flex: none;
        width: 16px;
        height: 16px;
      }
      .lock-ring svg {
        display: block;
        width: 16px;
        height: 16px;
      }
      .lock-ring circle {
        fill: none;
        stroke-width: 2;
      }
      .lock-ring .track {
        stroke: color-mix(in srgb, var(--morse-border) 80%, transparent);
      }
      .lock-ring .sweep {
        stroke: var(--morse-accent);
        stroke-linecap: round;
        /* 2πr, for r = 6. */
        stroke-dasharray: 37.7;
        stroke-dashoffset: 37.7;
        transform: rotate(-90deg);
        transform-origin: 50% 50%;
        animation: lock-sweep var(--morse-lock-ms, 900ms) linear forwards;
      }
      @keyframes lock-sweep {
        to {
          stroke-dashoffset: 0;
        }
      }
      .hover-close {
        flex: none;
        padding: 0 5px;
        border: 0;
        border-radius: 5px;
        background: none;
        color: var(--morse-fg-muted);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .hover-close:hover:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      /* Pinned: the card reads as deliberate, not as something about to vanish. */
      .hover-card.locked {
        border-color: color-mix(in srgb, var(--morse-accent) 55%, var(--morse-border));
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
