import { Injectable } from '@angular/core';
import { animate, stagger, utils } from 'animejs';

export interface EnterOptions {
  /** Vertical offset to travel from, in px. */
  y?: number;
  scale?: number;
  duration?: number;
  delay?: number;
  ease?: string;
}

/**
 * One place for motion, so any component can use it and it stays consistent:
 * anime.js drives entrances, expansions, flights and state changes, while
 * continuous loops that must survive a hidden document (spinners, streaming
 * cursors) stay in CSS.
 *
 * Two rules this service enforces:
 *
 * 1. Motion never hides content. Every animation publishes a *final* state, and
 *    a settle timer snaps to that state in case the animation engine never
 *    ticks — headless screenshots, a webview that is not visible, jsdom tests.
 * 2. `prefers-reduced-motion` is respected; then animations are skipped and the
 *    final state is applied immediately.
 */
@Injectable({ providedIn: 'root' })
export class AnimationService {
  private readonly enabled =
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function' ||
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Guarantees the animation's end state, even if it never ran. Small extra
   * delay on top of the animation so a slow frame does not cause a jump.
   */
  private settle(target: Element, styles: Record<string, string | number>, afterMs: number): void {
    setTimeout(() => utils.set(target, styles), afterMs);
  }

  /** Entrance for a single element that just appeared. */
  enter(target: Element | null | undefined, options: EnterOptions = {}): void {
    if (!target) {
      return;
    }
    const { y = 8, scale, duration = 260, delay = 0, ease = 'out(3)' } = options;
    const rest = { opacity: 1, translateY: '0px', scale: 1 };
    if (!this.enabled) {
      utils.set(target, rest);
      return;
    }
    this.settle(target, rest, delay + duration + 120);
    animate(target, {
      opacity: [0, 1],
      translateY: [`${y}px`, '0px'],
      ...(scale === undefined ? {} : { scale: [scale, 1] }),
      duration,
      delay,
      ease,
    });
  }

  /** Entrance for a list, cascading slightly so it reads as one motion. */
  enterList(
    targets: Element[] | NodeListOf<Element>,
    options: EnterOptions & { each?: number } = {},
  ): void {
    const elements = Array.from(targets as ArrayLike<Element>);
    if (elements.length === 0) {
      return;
    }
    const { y = 8, duration = 240, delay = 0, each = 30, ease = 'out(3)' } = options;
    if (!this.enabled) {
      for (const element of elements) {
        utils.set(element, { opacity: 1, translateY: '0px' });
      }
      return;
    }
    // Each row gets its own settle timer so a frozen engine cannot strand it.
    elements.forEach((element, index) => {
      this.settle(
        element,
        { opacity: 1, translateY: '0px' },
        delay + index * each + duration + 120,
      );
    });
    animate(elements, {
      opacity: [0, 1],
      translateY: [`${y}px`, '0px'],
      duration,
      delay: stagger(each, { start: delay }),
      ease,
    });
  }

  /**
   * Expanding/collapsing a details panel without a fixed height.
   *
   * `animate: false` applies the end state instantly — used on a first render,
   * where animating would shift the transcript under the reader.
   */
  reveal(
    target: Element | null | undefined,
    open: boolean,
    options: { animate?: boolean; after?: () => void } = {},
  ): void {
    const { animate: shouldAnimate = true, after } = options;
    if (!target) {
      after?.();
      return;
    }
    const closed = { opacity: 0, height: '0px' };
    const opened = { opacity: 1, height: 'auto' };
    const height = Math.max(target.scrollHeight, target.getBoundingClientRect().height);

    if (!this.enabled || !shouldAnimate || height === 0) {
      utils.set(target, open ? opened : closed);
      after?.();
      return;
    }

    this.settle(target, open ? opened : closed, (open ? 240 : 180) + 160);
    animate(target, {
      opacity: open ? [0, 1] : [1, 0],
      height: open ? ['0px', `${height}px`] : [`${height}px`, '0px'],
      duration: open ? 240 : 180,
      ease: open ? 'out(3)' : 'in(2)',
      onComplete: () => {
        utils.set(target, open ? opened : closed);
        after?.();
      },
    });
  }

  /** Attention pulse, e.g. when a run starts. */
  pulse(target: Element | null | undefined): void {
    if (!this.enabled || !target) {
      return;
    }
    this.settle(target, { opacity: 1, scale: 1 }, 520);
    animate(target, {
      opacity: [0.4, 1],
      scale: [0.99, 1],
      duration: 320,
      ease: 'out(2)',
    });
  }

  /** Small pop for an element that changes state (badge, chevron, chip). */
  pop(target: Element | null | undefined, options: EnterOptions = {}): void {
    if (!target) {
      return;
    }
    const { scale = 1.18, duration = 220, ease = 'out(2)' } = options;
    if (!this.enabled) {
      return;
    }
    this.settle(target, { scale: 1 }, duration + 120);
    animate(target, { scale: [scale, 1], duration, ease });
  }

  /**
   * A repeating animation (idle breathing, a bobbing icon, a ping ring).
   *
   * Properties must be given as `[from, to]` pairs so the element can be put back
   * where it started when the loop stops; otherwise a paused loop freezes it
   * mid-breath. The returned function stops it and restores the start values.
   */
  loop(
    target: Element | null | undefined,
    params: Record<string, [string | number, string | number]>,
    options: { duration?: number; delay?: number; ease?: string; alternate?: boolean } = {},
  ): () => void {
    if (!target || !this.enabled) {
      return () => undefined;
    }
    const { duration = 900, delay = 0, ease = 'inOut(2)', alternate = true } = options;
    const animation = animate(target, { ...params, duration, delay, ease, loop: true, alternate });
    const rest: Record<string, string | number> = {};
    for (const [property, values] of Object.entries(params)) {
      rest[property] = values[0];
    }
    return () => {
      animation.pause();
      utils.set(target, rest);
    };
  }
}
