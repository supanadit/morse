import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayStack } from '../state/overlay-stack';
import { OverlayEscape } from './overlay-escape';

/**
 * One Escape, delivered the way the browser delivers it: from the element that has
 * focus, up through the document. A press dispatched straight at `document` would be
 * an at-target event, where a capture listener runs in registration order like any
 * other — so it could not tell a consumed press from a passing one.
 */
function pressEscape(): KeyboardEvent {
  const focused = document.createElement('div');
  document.body.appendChild(focused);
  const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
  focused.dispatchEvent(event);
  focused.remove();
  return event;
}

/** A view that closes itself on Escape, as the file preview and the transcript do. */
function listensForEscape(): { stop: () => void; calls: () => number } {
  const spy = vi.fn();
  const listener = (): void => void spy();
  document.addEventListener('keydown', listener);
  return {
    stop: () => document.removeEventListener('keydown', listener),
    calls: () => spy.mock.calls.length,
  };
}

describe('OverlayEscape', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('dismisses the overlay on top, and only that one', () => {
    const stack = TestBed.inject(OverlayStack);
    TestBed.inject(OverlayEscape);
    const below = vi.fn();
    const above = vi.fn();
    stack.open(below);
    stack.open(above);

    pressEscape();

    expect(above).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
  });

  it('keeps a press that dismissed a dialog from closing a view behind it', () => {
    const stack = TestBed.inject(OverlayStack);
    TestBed.inject(OverlayEscape);
    stack.open(() => undefined);
    const view = listensForEscape();

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(true);
    expect(view.calls()).toBe(0);
    view.stop();
  });

  it('lets Escape through when nothing is open, and stops listening on destroy', () => {
    const stack = TestBed.inject(OverlayStack);
    TestBed.inject(OverlayEscape);
    const view = listensForEscape();

    expect(pressEscape().defaultPrevented).toBe(false);
    expect(view.calls()).toBe(1);
    view.stop();

    const close = vi.fn();
    stack.open(close);
    TestBed.resetTestingModule();
    pressEscape();

    expect(close).not.toHaveBeenCalled();
  });

  it('ignores every key but Escape', () => {
    const stack = TestBed.inject(OverlayStack);
    TestBed.inject(OverlayEscape);
    const close = vi.fn();
    stack.open(close);
    const focused = document.createElement('div');
    document.body.appendChild(focused);

    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true }));

    expect(close).not.toHaveBeenCalled();
    focused.remove();
  });
});
