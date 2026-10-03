import { Injectable, inject } from '@angular/core';
import { animate, utils } from 'animejs';
import { AnimationService } from './animation.service';

/** What was dropped, in the shape the flying ghost needs. */
export interface FlightItem {
  name: string;
  /** `data:` URL for a thumbnail, when the item is an image. */
  thumbnail?: string;
}

interface Point {
  x: number;
  y: number;
}

/** Keep in sync with `--flight-duration`; the caller waits this long to attach. */
const FLIGHT_MS = 520;
const FLIGHT_STAGGER_MS = 70;

/**
 * The flourish after a drop: a small ghost of the file arcs from where it was
 * released into the composer, shrinks, and disappears as the real chip pops in.
 *
 * It is deliberately skippable — with reduced motion, or when the composer is not
 * on screen, `play()` resolves immediately and the attachment appears without the
 * theatre.
 */
@Injectable({ providedIn: 'root' })
export class DropFlight {
  private readonly animation = inject(AnimationService);

  /** Resolves when the last ghost has landed (or immediately when skipped). */
  async play(items: readonly FlightItem[], from: Point | undefined): Promise<void> {
    const target = this.resolveTarget();
    if (!this.animation.isEnabled || !from || !target || items.length === 0) {
      return;
    }
    if (typeof document === 'undefined') {
      return;
    }

    const total = FLIGHT_MS + (items.length - 1) * FLIGHT_STAGGER_MS;
    items.forEach((item, index) => {
      this.launch(item, from, target, index * FLIGHT_STAGGER_MS);
    });
    await wait(total);
  }

  /** Where the attachment lands: the chip row, or the composer itself. */
  private resolveTarget(): Point | undefined {
    const composer = document.querySelector('morse-chat-composer .box');
    if (!composer) {
      return undefined;
    }
    const box = composer.getBoundingClientRect();
    return { x: box.left + 26, y: box.top + 18 };
  }

  private launch(item: FlightItem, from: Point, to: Point, delay: number): void {
    const ghost = this.createGhost(item, from);
    document.body.appendChild(ghost);

    // An arc: it rises first, then falls into the composer, so the movement reads
    // as a throw rather than a straight slide.
    const lift = Math.min(from.y, to.y) - Math.max(60, Math.abs(from.y - to.y) * 0.35);
    animate(ghost, {
      translateX: [from.x, to.x],
      translateY: [
        { to: from.y, duration: FLIGHT_MS * 0.18 },
        { to: lift, duration: FLIGHT_MS * 0.42 },
        { to: to.y, duration: FLIGHT_MS * 0.4 },
      ],
      rotate: [0, -8, 6, 0],
      scale: [1, 1.04, 0.86, 0.42],
      opacity: [1, 1, 0.9, 0],
      duration: FLIGHT_MS,
      delay,
      ease: 'inOut(2)',
      onComplete: () => ghost.remove(),
    });
    // A frozen engine (hidden document, no frames) must not leave a ghost on
    // screen forever.
    setTimeout(() => ghost.remove(), delay + FLIGHT_MS + 400);
  }

  private createGhost(item: FlightItem, from: Point): HTMLElement {
    const ghost = document.createElement('div');
    ghost.className = 'drop-ghost';
    // Anchored at 0/0 and positioned purely by `translate`: setting left/top to
    // the drop point *and* animating translate doubles the offset, which threw the
    // ghost off screen.

    if (item.thumbnail) {
      const image = document.createElement('img');
      image.src = item.thumbnail;
      image.alt = '';
      ghost.appendChild(image);
    } else {
      const glyph = document.createElement('span');
      glyph.className = 'drop-ghost-glyph';
      glyph.textContent = '▤';
      ghost.appendChild(glyph);
    }

    const label = document.createElement('span');
    label.className = 'drop-ghost-name';
    label.textContent = item.name;
    ghost.appendChild(label);
    return ghost;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
