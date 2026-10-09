/**
 * One resize drag, from the pointerdown on a handle to the release.
 *
 * Four panes had grown their own copy of this: capture the pointer so the drag survives
 * leaving the handle, coalesce the moves into one layout per paint, apply the value while
 * the drag runs and write it once when it ends, then take the listeners off. What stays
 * with each pane is only what it alone knows — which axis moves it, which way round, how
 * far it may go — and that is `value`.
 *
 * It reads no signal and no element: a site hands it `value`, `preview` and `commit`.
 */
export interface ResizeDrag<T> {
  /**
   * The value this pointer position asks for, in the pane's own terms. Called on every
   * move; the result is handed to `preview` no more than once per frame, and to `commit`
   * when the drag ends.
   */
  readonly value: (pointer: PointerEvent) => T;
  /** Applies a value while the drag runs: usually a `persist: false` write. */
  readonly preview: (value: T) => void;
  /** Applies the value once, when the drag ends. */
  readonly commit: (value: T) => void;
  /** The drag started — the pane puts itself in its resizing state. */
  readonly begin?: () => void;
  /** The drag ended, released or cancelled — the pane takes that state back. */
  readonly end?: () => void;
}

/**
 * Starts the drag on the handle that received `event`. Returns as soon as the listeners
 * are on — the drag runs on the handle's own `pointermove`/`pointerup`/`pointercancel`,
 * which it removes when it ends.
 */
export function startResize<T>(event: PointerEvent, drag: ResizeDrag<T>): void {
  const handle = event.currentTarget as HTMLElement | null;
  if (handle === null) {
    return;
  }
  // A press on a handle is a drag, not a selection anywhere else on the page.
  event.preventDefault();
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // A synthetic event (a test) has no pointer to capture; the listeners below still see
    // the moves while the pointer is over the handle.
  }
  drag.begin?.();

  let frame = 0;
  let pending: T | undefined;
  let moved = false;
  const apply = (): void => {
    frame = 0;
    if (moved) {
      drag.preview(pending as T);
    }
  };
  const move = (pointer: PointerEvent): void => {
    const first = !moved;
    pending = drag.value(pointer);
    moved = true;
    /*
     * The first movement paints at once: a drag that waited for a frame before showing
     * anything feels like it has not started. Every one after it is coalesced, so a fast
     * drag still runs one layout per paint.
     */
    if (first) {
      apply();
      return;
    }
    if (frame === 0) {
      frame = requestAnimationFrame(apply);
    }
  };
  const stop = (): void => {
    if (frame !== 0) {
      cancelAnimationFrame(frame);
    }
    // Write the choice once, when the drag ends, not on every frame. A press that never
    // moved has no choice to write.
    if (moved) {
      drag.commit(pending as T);
    }
    drag.end?.();
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', stop);
    handle.removeEventListener('pointercancel', stop);
  };

  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}
