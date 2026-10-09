import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** The buttons a title bar can carry. The pane draws them, so they look the same everywhere. */
export type PaneActionId = 'add' | 'remove' | 'refresh' | 'expand' | 'close';

/** One button on a title bar, as data — the panel says what it does, never how it looks. */
export interface PaneAction {
  /** Which standard button it is. */
  readonly id: PaneActionId;
  /** What it does. */
  readonly run: () => void;
  /** Its tooltip and accessible name, when the standard one does not fit. */
  readonly label?: string;
  /** On: the button is showing a state (the git panel's expand toggle). */
  readonly active?: boolean;
  /** The action cannot be taken right now (a git command is already running). */
  readonly disabled?: boolean;
}

/** What each button says when the panel leaves the name to the pane. */
const DEFAULT_LABELS: Record<PaneActionId, string> = {
  add: 'New',
  remove: 'Remove',
  refresh: 'Refresh',
  expand: 'Expand',
  close: 'Close',
};

/** What each text button draws. */
const GLYPHS: Record<string, string> = {
  add: '+',
  remove: '−',
  refresh: '⟳',
  close: '✕',
};

/**
 * The frame every panel is drawn in: a title bar that belongs to the window rather than to
 * the panel, and a body whose content is the panel's own business.
 *
 * Every panel had grown its own. The Explorer had a header, the git column another, the
 * session list a third, and each one drew its own fold chevron, its own padding, its own
 * refresh button — so "the same panel" looked like three different things, and a fourth
 * panel meant a fourth look. Here the row, the fold, the count and the buttons are the
 * pane's; a panel passes a title, a count, whether it is folded, and a list of buttons as
 * data (`PaneAction`). Its content is free.
 *
 * The title bar carries `data-pane-handle`: it is the grip a docking drag takes hold of,
 * and the reason a panel needs no idea which column it is in. Where a pane sits, how wide
 * it is and what it is dragged next to stay the shell's business (`state/layout-state.ts`).
 */
@Component({
  selector: 'morse-pane',
  templateUrl: './pane.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './pane.css',
})
export class Pane {
  /** The panel's name, in its own title bar. */
  readonly title = input.required<string>();
  /** A count or a short state next to the name — the Explorer's file count. */
  readonly meta = input<string>();
  /** Folded, when the panel can fold; leave it out and the name is an ordinary label. */
  readonly folded = input<boolean>();
  /** The title bar's buttons, in the order they are drawn. */
  readonly actions = input<readonly PaneAction[]>([]);
  /** The reader folded or unfolded it. */
  readonly foldToggle = output<void>();

  protected label(action: PaneAction): string {
    return action.label ?? DEFAULT_LABELS[action.id];
  }

  protected glyph(action: PaneAction): string {
    return GLYPHS[action.id] ?? '';
  }
}
