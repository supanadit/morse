import { Injectable, computed, signal } from '@angular/core';

/** One open overlay: the caller's way out of it, registered while it is up. */
interface Overlay {
  readonly close: () => void;
}

/**
 * The overlays that are open, in the order they opened.
 *
 * A dialog owns the whole screen while it is up, so the *topmost* one is the one
 * that answers Escape. Every dialog used to listen for Escape itself and dismiss,
 * which meant one press dismissed all of them at once — and nothing coordinated
 * who was on top. An overlay registers here while it is open and releases on
 * destroy; `closeTop` is the only way in, so the order lives in one place.
 *
 * It lives in `state/` rather than `services/` for a reason: `ShellState` reads
 * `depth()` for `modalOpen`, and a store may not import a service (R-U5). It holds
 * no DOM — the Escape key itself is `ui/overlay-escape.ts`.
 */
@Injectable({ providedIn: 'root' })
export class OverlayStack {
  private readonly entries = signal<readonly Overlay[]>([]);

  /** How many overlays are open. `ShellState.modalOpen` is this being above zero. */
  readonly depth = computed(() => this.entries().length);

  /**
   * Registers an open overlay and returns its release. The owner releases on
   * destroy; calling it again does nothing.
   */
  open(close: () => void): () => void {
    const entry: Overlay = { close };
    this.entries.update((open) => [...open, entry]);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.entries.update((open) => open.filter((each) => each !== entry));
    };
  }

  /**
   * Dismisses the overlay on top. Whether that closes it is the overlay's own
   * answer: a dialog stepping back through its own modes stays registered, so the
   * next press is still its business. Returns whether there was one to dismiss.
   */
  closeTop(): boolean {
    const open = this.entries();
    const top = open[open.length - 1];
    if (top === undefined) {
      return false;
    }
    top.close();
    return true;
  }
}
