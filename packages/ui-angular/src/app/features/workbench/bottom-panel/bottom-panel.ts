import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  type Type,
} from '@angular/core';
import { PANEL_DEFAULT_HEIGHT, PanelState } from '../../../state/panel-state';
import { TerminalView } from '../terminal/terminal-view';
import { startResize } from '../../../ui/resize-drag';

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
 * its scrollback instead of being killed by a collapse. `visible` is the same
 * idea for a whole-session hide: the host takes the space away with
 * `display: none` instead of unmounting, because an unmount would close the
 * host-owned shell (see `bottomPanelEnabled`).
 */
@Component({
  selector: 'morse-bottom-panel',
  imports: [NgComponentOutlet],
  templateUrl: './bottom-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.full]': 'full()',
    '[class.host-hidden]': '!visible()',
  },
  styleUrl: './bottom-panel.css',
})
export class BottomPanel {
  private readonly panel = inject(PanelState);

  /** Whether the panel takes space at all; `false` hides it without unmounting. */
  readonly visible = input(true);

  protected readonly views = VIEWS;
  protected readonly defaultHeight = PANEL_DEFAULT_HEIGHT;
  protected readonly activeView = this.panel.activeView;
  protected readonly expanded = this.panel.expanded;
  protected readonly height = this.panel.height;
  protected readonly full = this.panel.full;
  protected readonly actions = this.panel.actions;

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
    const startY = event.clientY;
    const startHeight = this.height() ?? PANEL_DEFAULT_HEIGHT;
    startResize(event, {
      begin: () => panel?.classList.add('resizing'),
      end: () => panel?.classList.remove('resizing'),
      // Dragging up grows the panel: distance above the start adds to the height.
      value: (pointer) => startHeight + (startY - pointer.clientY),
      preview: (height) => this.panel.setHeight(height, false),
      commit: (height) => this.panel.setHeight(height),
    });
  }

  /** Double-clicking the edge restores the default height. */
  protected onResizeReset(): void {
    this.panel.resetHeight();
  }
}
