import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayStack } from './overlay-stack';

/**
 * The order overlays are dismissed in. What the tests lock is the part that used
 * to be wrong: every overlay listened for Escape itself, so one press closed
 * whichever overlays happened to be open, top or not.
 */
describe('OverlayStack', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('closes the overlay that opened last, and only that one', () => {
    const stack = TestBed.inject(OverlayStack);
    const below = vi.fn();
    const above = vi.fn();
    stack.open(below);
    stack.open(above);

    expect(stack.closeTop()).toBe(true);

    expect(above).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
  });

  it('stays on the same overlay when its close did not remove it', () => {
    // A dialog that steps back through its own modes stays open: the next Escape
    // is still its business, not the one below it.
    const stack = TestBed.inject(OverlayStack);
    const below = vi.fn();
    const above = vi.fn();
    stack.open(below);
    stack.open(above);

    stack.closeTop();
    stack.closeTop();

    expect(above).toHaveBeenCalledTimes(2);
    expect(below).not.toHaveBeenCalled();
  });

  it('walks down as each overlay releases itself', () => {
    const stack = TestBed.inject(OverlayStack);
    const below = vi.fn();
    const above = vi.fn();
    stack.open(below);
    const release = stack.open(above);

    release();
    expect(stack.closeTop()).toBe(true);

    expect(below).toHaveBeenCalledTimes(1);
    expect(above).not.toHaveBeenCalled();
  });

  it('releases once, however often the owner calls it', () => {
    const stack = TestBed.inject(OverlayStack);
    const below = vi.fn();
    const above = vi.fn();
    stack.open(below);
    const release = stack.open(above);

    release();
    release();

    // The second call must not take the overlay below it with it.
    expect(stack.depth()).toBe(1);
    stack.closeTop();
    expect(below).toHaveBeenCalledTimes(1);
    expect(above).not.toHaveBeenCalled();
  });

  it('reports how many overlays are open, and closes nothing when there are none', () => {
    const stack = TestBed.inject(OverlayStack);
    expect(stack.depth()).toBe(0);
    expect(stack.closeTop()).toBe(false);

    stack.open(() => undefined);
    expect(stack.depth()).toBe(1);
  });
});
