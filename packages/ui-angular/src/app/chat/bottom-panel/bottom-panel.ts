import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  type Type,
} from '@angular/core';
import { PANEL_DEFAULT_HEIGHT, PanelState } from '../../core/panel-state';
import { TerminalView } from '../terminal/terminal-view';

/**
 * A tool the bottom panel offers. Adding one is a line here plus its component —
 * the bar's chips and the body's outlet both read this list, so the panel never
 * grows a second place to register a view.
 */
interface BottomPanelView {
  id: string;
  label: string;
  component: Type<unknown>;
}

const VIEWS: readonly BottomPanelView[] = [
  { id: 'terminal', label: 'Terminal', component: TerminalView },
];

/**
 * The browser host's bottom panel: a VS Code-style strip below the composer.
 * It starts folded to its chip row; a chip opens that tool, the chevron folds it
 * back, and its top edge drags the panel taller. VS Code never mounts it (its
 * host leaves `capabilities.terminal` off and keeps its own panel).
 *
 * The body stays mounted while folded, so a running terminal keeps its shell and
 * its scrollback instead of being killed by a collapse.
 */
@Component({
  selector: 'morse-bottom-panel',
  imports: [NgComponentOutlet],
  templateUrl: './bottom-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.full]': 'full()' },
  styles: [
    `
      :host {
        display: block;
        flex: none;
        min-width: 0;
      }
      /* Full screen: the panel owns the chat column, so it grows to fill it. */
      :host(.full) {
        flex: 1;
        min-height: 0;
      }
      :host(.full) .panel {
        height: 100%;
        border-top: 0;
      }
      .panel {
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
        border-top: 1px solid var(--morse-border);
        background: var(--morse-nav-bg);
      }
      /*
       * The top edge of an open panel: drag it up to make the terminal taller.
       * It sits in normal flow as its own strip rather than overlapping the bar
       * with a negative margin — the later sibling would paint and hit-test over
       * it there, leaving the handle unreachable.
       */
      .resize {
        flex: none;
        height: 5px;
        cursor: ns-resize;
        touch-action: none;
      }
      .resize:hover,
      .resize:active {
        background: color-mix(in srgb, var(--morse-accent) 45%, transparent);
      }
      /* A drag in progress: no hover hit-testing under the pointer. */
      .panel.resizing .bar,
      .panel.resizing .body {
        pointer-events: none;
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: none;
        height: 30px;
        padding: 0 6px 0 0;
      }
      .chips {
        display: flex;
        align-items: stretch;
        gap: 0;
        height: 100%;
      }
      /*
       * A minimal tab, matching the session strip above: flush, no box, no
       * radius — the active one is marked by the accent line under it. The
       * focus ring is drawn as that same line so clicking never leaves a box.
       */
      /*
       * A tool chip: its label and any actions of its own, one unit. A separate
       * `+` beside the chip would look like a second tool tab.
       */
      .chip {
        display: inline-flex;
        align-items: stretch;
        height: 100%;
        margin: 0;
        border: 0;
        border-radius: 0;
        background: none;
        color: var(--morse-fg-muted);
        transition: color 120ms ease, background 120ms ease;
      }
      .chip:hover {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .chip.active {
        color: var(--morse-fg);
        box-shadow: inset 0 -2px 0 var(--morse-accent);
      }
      .chip-label {
        display: inline-flex;
        align-items: center;
        padding: 0 12px;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .chip.with-actions .chip-label {
        padding-right: 2px;
      }
      .chip-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        align-self: stretch;
        padding: 0;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        font-size: 15px;
        line-height: 1;
        cursor: pointer;
      }
      .chip-label:focus-visible,
      .chip-action:focus-visible {
        outline: none;
        color: var(--morse-fg);
        box-shadow: inset 0 -2px 0 var(--morse-accent);
      }
      /*
       * The global button / button:hover rules are more specific than a plain
       * class, so they painted the chip's label accent-blue. The hover belongs to
       * the chip, not its parts; this keeps the override at equal specificity.
       */
      .chip-label:not(:disabled),
      .chip-action:not(:disabled),
      .chip-label:hover:not(:disabled),
      .chip-action:hover:not(:disabled) {
        background: none;
        color: inherit;
      }
      .grow {
        flex: 1;
        min-width: 8px;
      }
      .toggle {
        flex: none;
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
      }
      .toggle:hover:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .toggle svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .body {
        flex: 1;
        min-height: 0;
        display: flex;
        overflow: hidden;
        border-top: 1px solid var(--morse-border);
      }
      /* Folded: the chip row stays, the body keeps its state but no space. */
      .body.hidden {
        display: none;
      }
      .empty {
        margin: auto;
        padding: 12px;
        color: var(--morse-fg-muted);
        font-size: 12px;
      }
    `,
  ],
})
export class BottomPanel {
  private readonly panel = inject(PanelState);

  protected readonly views = VIEWS;
  protected readonly defaultHeight = PANEL_DEFAULT_HEIGHT;
  protected readonly activeView = this.panel.activeView;
  protected readonly expanded = this.panel.expanded;
  protected readonly height = this.panel.height;
  protected readonly full = this.panel.full;
  protected readonly actions = this.panel.actions;
  /** Where the pointer started and how tall the panel was, for the drag. */
  private resizeStartY = 0;
  private resizeStartHeight = 0;

  /** A chip: opens its tool, or folds the panel if it was already open. */
  protected select(id: string): void {
    this.panel.toggle(id);
  }

  /** The chevron: folds the open panel, or re-opens the last tool it showed. */
  protected toggleExpanded(): void {
    if (this.expanded()) {
      this.panel.collapse();
      return;
    }
    this.panel.toggle(this.activeView() ?? VIEWS[0]!.id);
  }

  /** The expand glyph: hand the panel the whole column, or fit it back below the chat. */
  protected toggleFull(): void {
    if (!this.expanded()) {
      this.panel.toggle(this.activeView() ?? VIEWS[0]!.id);
    }
    this.panel.toggleFull();
  }

  protected componentFor(id: string): Type<unknown> | undefined {
    return VIEWS.find((view) => view.id === id)?.component;
  }

  /**
   * Drag the top edge to size the panel. The height follows the pointer, so
   * pulling up (a negative delta) grows it; the drag is frame-coalesced so one
   * layout runs per paint even while the terminal's `ResizeObserver` re-fits.
   */
  protected onResizeStart(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    const panel = handle.parentElement;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic event (a test) has no pointer to capture; the listeners
      // below still see the moves while the pointer is over the handle.
    }
    this.resizeStartY = event.clientY;
    this.resizeStartHeight = this.height() ?? PANEL_DEFAULT_HEIGHT;
    let frame = 0;
    let pending = this.resizeStartHeight;
    const apply = (): void => {
      frame = 0;
      this.panel.setHeight(pending, false);
    };
    const move = (moveEvent: PointerEvent): void => {
      // Dragging up grows the panel: distance above the start adds to the height.
      pending = this.resizeStartHeight + (this.resizeStartY - moveEvent.clientY);
      if (frame === 0) {
        frame = requestAnimationFrame(apply);
      }
    };
    const stop = (): void => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        apply();
      }
      panel?.classList.remove('resizing');
      // Write the choice once, when the drag ends, not on every frame.
      this.panel.setHeight(pending);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    panel?.classList.add('resizing');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  /** Double-clicking the edge restores the default height. */
  protected onResizeReset(): void {
    this.panel.resetHeight();
  }
}
