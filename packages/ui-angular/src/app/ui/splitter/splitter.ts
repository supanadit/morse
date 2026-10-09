import { Directive, computed, inject, input } from '@angular/core';
import { LayoutState, type SizeId } from '../../state/layout-state';
import { startResize } from '../resize-drag';

/** Which side of the sized box the hand is on. The drag grows the box away from it. */
export type SplitterEdge = 'left' | 'right' | 'top' | 'bottom';

/**
 * One resize handle, whatever it resizes.
 *
 * Five panes had grown five versions of this. The git column worked around the shell's
 * column transition and paused its own animation; the Explorer measured a different
 * element than the one it resized; the Changes divider measured a sibling; and every one of
 * them wrote the new size onto the panel's own template — so a drag re-rendered the hundreds
 * of rows inside that panel, once a frame. The one pane that did not do that, the navigation
 * column, was the one that felt right.
 *
 * So the handle owns the whole gesture — measure, follow the pointer, clamp, hold the shell
 * still, reset on a double-click — and the size lands in `LayoutState`, whose shell binding
 * is what puts it on screen. A panel says which size it drags and which way it grows, and
 * then hears about the drag only through CSS.
 */
@Directive({
  selector: '[morseSplitter]',
  host: {
    '[attr.role]': '"separator"',
    '[attr.aria-orientation]': 'vertical() ? "vertical" : "horizontal"',
    '[attr.aria-label]': 'label()',
    '[style.touch-action]': '"none"',
    '(pointerdown)': 'onPointerDown($event)',
    '(dblclick)': 'onDoubleClick()',
  },
})
export class Splitter {
  private readonly layout = inject(LayoutState);

  /** Which size this handle drags, in the layout's one home for sizes. */
  readonly id = input.required<SizeId>({ alias: 'morseSplitter' });
  /** The side of the sized box the hand is on; the drag grows the box away from it. */
  readonly edge = input.required<SplitterEdge>();
  /** The box being sized: the handle's parent, or the sibling above a divider inside a pane. */
  readonly box = input<'parent' | 'previous'>('parent');
  /** The nearest this box may come to its edge, in px. */
  readonly min = input(0);
  /**
   * The furthest it may go. A number, or a measurement of the handle — for a limit that
   * depends on the room left in the window, which is the pane's own fact to know.
   */
  readonly max = input<number | ((handle: HTMLElement) => number)>(
    Number.POSITIVE_INFINITY,
  );
  /** What this handle resizes, for a screen reader. */
  readonly label = input.required<string>();
  /** The pane's own step before the drag: leaving a mode the resize would fight. */
  readonly prepare = input<(() => void) | undefined>(undefined);

  /** A handle between columns is a vertical line; between rows, a horizontal one. */
  protected readonly vertical = computed(() => {
    const edge = this.edge();
    return edge === 'left' || edge === 'right';
  });

  protected onPointerDown(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    const box = this.boxOf(handle);
    if (box === null || event.button !== 0) {
      return;
    }
    this.prepare()?.();

    const id = this.id();
    const vertical = this.vertical();
    const limit = this.max();
    const from = vertical ? event.clientX : event.clientY;
    const start = this.startSize(box, vertical);
    const grow = this.edge() === 'right' || this.edge() === 'bottom' ? 1 : -1;
    // Measured once, before the box moves: half of these limits are relative to the window.
    const most = typeof limit === 'function' ? limit(handle) : limit;
    const shell = handle.closest('.shell') as HTMLElement | null;

    startResize(event, {
      value: (pointer) => {
        const moved = (vertical ? pointer.clientX : pointer.clientY) - from;
        return Math.min(most, Math.max(this.min(), start + grow * moved));
      },
      preview: (px) => this.layout.setSize(id, px, false),
      commit: (px) => this.layout.setSize(id, px),
      begin: () => {
        /*
         * The drag follows the pointer, not the shell's column transition: retargeting that
         * animation on every move is exactly what made the resize feel heavy.
         */
        shell?.style.setProperty('transition', 'none');
        box.classList.add('resizing');
      },
      end: () => {
        shell?.style.removeProperty('transition');
        box.classList.remove('resizing');
      },
    });
  }

  /** Back to the default the stylesheet gives this box, for the reader who overshot. */
  protected onDoubleClick(): void {
    this.layout.setSize(this.id(), undefined);
  }

  private boxOf(handle: HTMLElement): HTMLElement | null {
    return this.box() === 'previous'
      ? (handle.previousElementSibling as HTMLElement | null)
      : handle.parentElement;
  }

  /** Where the drag starts: what the box measures now, or the size it was last given. */
  private startSize(box: HTMLElement, vertical: boolean): number {
    const rect = box.getBoundingClientRect();
    const measured = vertical ? rect.width : rect.height;
    return measured > 0 ? measured : (this.layout.size(this.id()) ?? 0);
  }
}
