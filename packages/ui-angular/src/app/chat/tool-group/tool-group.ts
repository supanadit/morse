import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { ToolTranscriptItem } from '@morse/protocol';
import { AnimationService } from '../../core/animation.service';
import { DisplayPrefs } from '../../core/display-prefs';
import { EnterDirective } from '../../shared/enter.directive';
import type { ProcessStep } from '../transcript-rows';

interface ToolTarget {
  dir: string;
  base: string;
}

interface ToolDiff {
  added: number;
  removed: number;
}

/**
 * The steps of a turn as one timeline: tool calls and thinking notes in the order
 * they happened, with a per-step status indicator (running spinner, ✓ done,
 * ✗ failed). The header collapses the whole timeline — "Working for 3s ·
 * 2 actions" while the agent is busy, "Worked for 6s · 5 actions · 2 thoughts"
 * when the turn is done. Only the newest timeline is open while a run is going;
 * a host passes `working` for the group that is currently live.
 *
 * Every step is a card that opens its own detail (input/output, full thinking
 * text), and cards animate in one after another so a long turn reads as
 * progress instead of a wall of text.
 *
 * The reader can also choose the `compact` display (see `DisplayPrefs`): then
 * the live turn stays folded, the header is followed by a single line naming the
 * newest action, thinking notes are dropped, and the steps lose their card
 * chrome. Same data, two densities.
 */
@Component({
  selector: 'morse-tool-group',
  imports: [EnterDirective],
  templateUrl: './tool-group.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
      }
      .summary {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 100%;
        padding: 2px 8px 2px 4px;
        margin-left: -4px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 12.5px;
        cursor: pointer;
      }
      .summary:hover {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .state {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
      }
      .state.ok {
        color: var(--morse-success);
      }
      .state.error {
        color: var(--morse-error);
      }
      .spinner {
        width: 11px;
        height: 11px;
        border-radius: 50%;
        border: 1.5px solid var(--morse-border);
        border-top-color: var(--morse-accent);
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .chev {
        display: inline-block;
        transition: transform 170ms cubic-bezier(0.2, 0.7, 0.3, 1);
      }
      .chev.open {
        transform: rotate(90deg);
      }
      .dots {
        display: inline-flex;
        gap: 2px;
        color: currentColor;
      }
      .dots i {
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background: currentColor;
        animation: dot 1.2s ease-in-out infinite;
      }
      .dots i:nth-child(2) {
        animation-delay: 0.15s;
      }
      .dots i:nth-child(3) {
        animation-delay: 0.3s;
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
      .rows {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin: 6px 0 0;
        padding: 0;
        list-style: none;
        overflow: hidden;
      }
      /*
       * Compact turns are a tree, not a stack of cards. The guide line is what
       * makes a step read as a child of the turn summary instead of a sibling
       * at the same level, and each node hangs a file child off it.
       */
      .tree {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin: 6px 0 2px 6px;
        padding: 0 0 0 14px;
        border-left: 1px solid var(--morse-guide);
        list-style: none;
      }
      .node {
        position: relative;
        min-width: 0;
      }
      /* The horizontal tick that joins a node to the guide line above it. */
      .node::before {
        content: '';
        position: absolute;
        left: -14px;
        top: 11px;
        width: 8px;
        height: 1px;
        background: var(--morse-guide);
      }
      .node-row {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        min-width: 0;
        padding: 2px 6px 2px 0;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }
      .node-row:hover {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      /* A tree body is a nested detail fold under its node, not a card body. */
      .node .body {
        margin: 2px 0;
        padding: 2px 6px 6px 14px;
        border-left: 1px solid var(--morse-guide);
      }
      .node-row .verb {
        flex: none;
        color: var(--morse-fg);
      }
      .node-row .target {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--morse-font-mono);
        font-size: 11.5px;
      }
      /* A thinking preview is prose, not a command or a path. */
      .node-row .target.thought {
        font-family: var(--morse-font);
        font-size: 12px;
      }
      .glyph.thinking {
        color: var(--morse-typename);
      }
      /* The files a step touched, indented under it behind a second guide line. */
      .children {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin: 2px 0;
        padding: 0 0 0 14px;
        border-left: 1px solid var(--morse-guide);
        list-style: none;
      }
      .child {
        position: relative;
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        /* 14px from the guide line plus this 6px lands the icon exactly under
           the parent row's glyph, not under its status tick. */
        padding: 1px 0 1px 6px;
        color: var(--morse-fg-muted);
        font-size: 11.5px;
      }
      .child::before {
        content: '';
        position: absolute;
        left: -14px;
        top: 50%;
        width: 14px;
        height: 1px;
        background: var(--morse-guide);
      }
      .child .file-icon {
        flex: none;
        width: 11px;
        height: 11px;
        fill: none;
        stroke: var(--morse-number);
        stroke-width: 1.2;
        stroke-linejoin: round;
      }
      .child .file-name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--morse-font-mono);
      }
      .card {
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        background: color-mix(in srgb, var(--morse-panel) 55%, transparent);
        overflow: hidden;
      }
      .card.running {
        border-color: color-mix(in srgb, var(--morse-accent) 55%, var(--morse-border));
      }
      .card.failed {
        border-color: color-mix(in srgb, var(--morse-error) 55%, var(--morse-border));
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 5px 8px;
        border: 0;
        background: transparent;
        color: var(--morse-fg);
        font-size: 12.5px;
        text-align: left;
        cursor: pointer;
      }
      .head:hover {
        background: var(--morse-hover);
      }
      /* Per-step indicator shown next to each step. */
      .status {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 13px;
        height: 13px;
      }
      .status .ok {
        color: var(--morse-success);
        font-size: 10px;
      }
      .status .fail {
        color: var(--morse-error);
        font-size: 11px;
      }
      .status .bulb {
        color: var(--morse-typename);
        font-size: 11px;
      }
      .glyph {
        flex: none;
        width: 13px;
        text-align: center;
        font-size: 12px;
      }
      .glyph.edit {
        color: var(--morse-keyword);
      }
      .glyph.read {
        color: var(--morse-number);
      }
      .glyph.search {
        color: var(--morse-typename);
      }
      .glyph.shell {
        color: var(--morse-success);
      }
      .chip {
        flex: none;
        padding: 0 5px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        color: var(--morse-fg-muted);
        font-family: var(--morse-font-mono);
        font-size: 11px;
      }
      .args {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--morse-font-mono);
        font-size: 11.5px;
      }
      .args .dir {
        color: var(--morse-fg-muted);
      }
      .preview {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-size: 12px;
      }
      .diff {
        flex: none;
        display: inline-flex;
        gap: 4px;
        font-family: var(--morse-font-mono);
        font-size: 11.5px;
      }
      .diff .add {
        color: var(--morse-success);
      }
      .diff .del {
        color: var(--morse-error);
      }
      .meta {
        flex: none;
        color: var(--morse-fg-muted);
        font-variant-numeric: tabular-nums;
      }
      .grow {
        flex: 1;
      }
      .body {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 0 10px 8px 30px;
        overflow: hidden;
      }
      .body .label-small {
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--morse-fg-muted);
      }
      .body pre {
        margin: 0;
        max-height: 260px;
        overflow: auto;
        padding: 8px 10px;
        border-radius: var(--morse-radius-sm);
        background: var(--morse-panel);
        font-family: var(--morse-font-mono);
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
      }
    `,
  ],
})
export class ToolGroup {
  readonly steps = input.required<ProcessStep[]>();
  /**
   * Whether this is the live section of a running turn, from the host's own
   * state. This decides the automatic open/close: the live timeline stays open
   * for as long as it is the newest one, and collapses once the run produces a
   * new section or finishes — never step by step.
   */
  readonly working = input<boolean>(false);

  private readonly animation = inject(AnimationService);
  private readonly display = inject(DisplayPrefs);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly openSteps = signal<Record<string, boolean>>({});
  /**
   * The user's explicit choice, if any. Cleared whenever the automatic state
   * changes, so the timeline follows the run instead of fighting the reader.
   */
  private readonly override = signal<boolean | null>(null);
  /** Ticks while something runs so elapsed times stay live. */
  private readonly tick = signal(0);

  protected readonly tools = computed(() =>
    this.steps().filter((step): step is Extract<ProcessStep, { kind: 'tool' }> => step.kind === 'tool'),
  );
  protected readonly thoughts = computed(
    () => this.steps().filter((step) => step.kind === 'thinking').length,
  );
  protected readonly running = computed(() =>
    this.tools().some((step) => step.item.status === 'running'),
  );
  protected readonly failed = computed(() =>
    this.tools().some((step) => step.item.status === 'error'),
  );
  /** The reader's chosen density, read from the shared preference. */
  protected readonly compact = computed(() => this.display.toolDisplay() === 'compact');
  /**
   * What the compact tree shows: every step once the tree is open (thinking
   * notes included, so the summary's thought count is truthful), and only the
   * newest step while it is folded.
   */
  protected readonly compactSteps = computed<ProcessStep[]>(() => {
    const steps = this.steps();
    if (this.isOpen()) {
      return steps;
    }
    const last = steps.at(-1);
    return last === undefined ? [] : [last];
  });
  /**
   * Open while the turn runs, collapsed once it is finished.
   *
   * `running()` is the fallback for hosts that do not report a run state: a
   * tool that is executing keeps the timeline open, and between two steps the
   * host still reports the run, so it cannot flap open and shut per step.
   *
   * The compact display deliberately opts out: it stays folded while the agent
   * works and puts the newest action on the summary line instead.
   */
  protected readonly autoOpen = computed(() =>
    this.compact() ? false : this.working() || this.running(),
  );
  protected readonly isOpen = computed(() => this.override() ?? this.autoOpen());

  protected readonly state = computed<'running' | 'ok' | 'error'>(() => {
    if (this.running()) {
      return 'running';
    }
    return this.failed() ? 'error' : 'ok';
  });

  protected readonly summary = computed(() => {
    const actions = this.tools().length;
    const thoughts = this.thoughts();
    const label = actions === 1 ? 'action' : 'actions';
    const notes = thoughts > 0 ? ` · ${thoughts} ${thoughts === 1 ? 'thought' : 'thoughts'}` : '';
    const elapsed = this.totalMs();

    if (this.running()) {
      return elapsed > 0
        ? `Working for ${formatDuration(elapsed)} · ${actions} ${label}${notes}`
        : `Working… · ${actions} ${label}${notes}`;
    }
    return elapsed > 0
      ? `Worked for ${formatDuration(elapsed)} · ${actions} ${label}${notes}`
      : `${actions} ${label}${notes}`;
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.running()) {
        return;
      }
      const handle = setInterval(() => this.tick.update((value) => value + 1), 500);
      onCleanup(() => clearInterval(handle));
    });

    // A new run (or a finished one) resets the manual choice.
    effect(() => {
      this.autoOpen();
      this.override.set(null);
    });

    // Animate only on a state change; a first render must not shift the layout.
    let initialised = false;
    effect((onCleanup) => {
      const open = this.isOpen();
      const animate = initialised;
      initialised = true;
      // Wait for the DOM to settle before measuring, otherwise the collapse
      // animation would start from the wrong height. A macrotask instead of
      // requestAnimationFrame: frames are paused in a hidden document.
      const timer = setTimeout(() => {
        this.animation.reveal(this.list()?.nativeElement ?? null, open, { animate });
      }, 0);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected toggle(): void {
    this.override.set(!this.isOpen());
  }

  protected toggleStep(key: string): void {
    const open = !this.isStepOpen(key);
    this.openSteps.update((state) => ({ ...state, [key]: open }));
    // The body is created by this change, so measure it after the DOM settles.
    setTimeout(() => {
      const body = this.host.nativeElement.querySelector<HTMLElement>(
        `[data-body="${CSS.escape(key)}"]`,
      );
      if (body) {
        this.animation.reveal(body, open, { animate: true });
      }
    }, 0);
  }

  protected isStepOpen(key: string): boolean {
    return this.openSteps()[key] === true;
  }

  /** One line of a thinking note, so the timeline stays scannable. */
  protected preview(thinking: string): string {
    const flat = thinking.replace(/\s+/g, ' ').trim();
    return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
  }

  protected elapsed(item: ToolTranscriptItem): string {
    if (item.status === 'running') {
      this.tick();
      const live = Date.now() - item.at;
      return live > 0 ? formatDuration(live) : '';
    }
    return item.durationMs === undefined ? '' : formatDuration(item.durationMs);
  }

  protected target(item: ToolTranscriptItem): ToolTarget {
    const raw = rawTitle(item);
    const cut = raw.lastIndexOf('/');
    return cut === -1
      ? { dir: '', base: raw }
      : { dir: raw.slice(0, cut + 1), base: raw.slice(cut + 1) };
  }

  /**
   * `+26 -7` or git's "275 insertions(+), 4 deletions(-)" — nothing else.
   * A lone `-3057` in an output is a date or a count, not a change size, so it
   * must not be shown as a diff.
   */
  protected diff(item: ToolTranscriptItem): ToolDiff | null {
    const text = `${item.title}\n${item.output ?? ''}`;
    const pair = /\+(\d+)\s*[-−](\d+)/.exec(text);
    if (pair) {
      return { added: Number(pair[1]), removed: Number(pair[2]) };
    }
    const additions = /(\d+)\s+insertions?\(\+\)/.exec(text)?.[1];
    const deletions = /(\d+)\s+deletions?\([-−]\)/.exec(text)?.[1];
    if (additions === undefined && deletions === undefined) {
      return null;
    }
    return { added: Number(additions ?? 0), removed: Number(deletions ?? 0) };
  }

  protected glyphClass(item: ToolTranscriptItem): string {
    const name = item.name.toLowerCase();
    if (name.includes('edit') || name.includes('write') || name.includes('patch')) {
      return 'edit';
    }
    if (name.includes('bash') || name.includes('shell') || name.includes('exec')) {
      return 'shell';
    }
    if (name.includes('search') || name.includes('grep') || name.includes('find')) {
      return 'search';
    }
    return 'read';
  }

  /** One word for the compact summary line: "Edit notes.md", "Run npm test". */
  protected verb(item: ToolTranscriptItem): string {
    const name = item.name.toLowerCase();
    if (name.includes('edit') || name.includes('write') || name.includes('patch')) {
      return 'Edit';
    }
    if (name.includes('read')) {
      return 'Read';
    }
    if (name.includes('search') || name.includes('grep') || name.includes('find')) {
      return 'Search';
    }
    if (name.includes('bash') || name.includes('shell') || name.includes('exec')) {
      return 'Run';
    }
    // An unknown tool keeps its own name rather than a wrong verb.
    return item.name;
  }

  /**
   * What the compact line names after the verb. A file reads by its base name
   * (the directory chain is noise at this density); a shell command is the
   * command itself, flattened to one line and clipped so a long invocation
   * cannot push the diff off the row.
   */
  protected compactTarget(item: ToolTranscriptItem): string {
    if (this.glyphClass(item) !== 'shell') {
      return this.target(item).base;
    }
    const flat = rawTitle(item).replace(/\s+/g, ' ').trim();
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
  }

  /**
   * The file a step changed, for the child row under it, or `null` when the step
   * is not a file edit (a shell command, a search, a read). Only edits grow a
   * child: the file is what the action produced, and repeating it under a read
   * would just echo the parent row.
   */
  protected fileOf(item: ToolTranscriptItem): string | null {
    const name = item.name.toLowerCase();
    const editsFile =
      name.includes('edit') || name.includes('write') || name.includes('patch');
    if (!editsFile) {
      return null;
    }
    const raw = rawTitle(item);
    return raw.length > 0 && raw !== item.name ? raw : null;
  }

  /** The file name alone, so a long path does not push the row out of view. */
  protected basename(path: string): string {
    const clean = path.replace(/[\\/]+$/, '');
    const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    return cut === -1 ? clean : clean.slice(cut + 1);
  }

  protected glyph(item: ToolTranscriptItem): string {
    switch (this.glyphClass(item)) {
      case 'edit':
        return '✎';
      case 'shell':
        return '❯';
      case 'search':
        return '⌕';
      default:
        return '☰';
    }
  }

  private totalMs(): number {
    return this.tools().reduce((sum, step) => {
      if (step.item.status === 'running') {
        this.tick();
        return sum + Math.max(0, Date.now() - step.item.at);
      }
      return sum + (step.item.durationMs ?? 0);
    }, 0);
  }
}

/** The tool title without the `name: ` prefix pi prefixes it with. */
function rawTitle(item: ToolTranscriptItem): string {
  return item.title.startsWith(`${item.name}: `)
    ? item.title.slice(item.name.length + 2)
    : item.title;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(1, Math.round(ms))}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
