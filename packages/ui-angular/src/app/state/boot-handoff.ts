import { Injectable } from '@angular/core';

/** Where a mark sits, in viewport coordinates (centre + size). */
export interface HandoffTarget {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The bridge between the cold-start splash and the empty-state hero.
 *
 * The hero registers the place its mark occupies; the splash, on the way out,
 * reads it and flies the mark it already showed to that exact spot — one logo
 * that moves, instead of two that cross-fade. When there is no hero (a resumed
 * session with history, a non-empty transcript) the target is `null` and the
 * splash falls back to a plain fade.
 */
@Injectable({ providedIn: 'root' })
export class BootHandoff {
  private target: HandoffTarget | null = null;

  /** Called by the hero whenever its mark is laid out (or cleared when it goes). */
  aim(target: HandoffTarget | null): void {
    this.target = target;
  }

  /** Read once by the splash as it starts its exit. */
  read(): HandoffTarget | null {
    return this.target;
  }
}
