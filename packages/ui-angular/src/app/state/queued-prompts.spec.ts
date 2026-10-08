import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { QueuedPrompts } from './queued-prompts';

describe('QueuedPrompts', () => {
  afterEach(() => TestBed.resetTestingModule());

  function store(): QueuedPrompts {
    return TestBed.inject(QueuedPrompts);
  }

  it('keeps follow-ups in the order they were queued', () => {
    const queue = store();

    queue.enqueue({ text: 'first', images: [], pins: [] });
    queue.enqueue({ text: 'second', images: [], pins: [] });

    expect(queue.queued().map((item) => item.text)).toEqual(['first', 'second']);
    expect(queue.count()).toBe(2);
  });

  it('dispatches the oldest follow-up and leaves the rest queued', () => {
    const queue = store();
    queue.enqueue({ text: 'first', images: [], pins: [] });
    queue.enqueue({ text: 'second', images: [], pins: [] });

    expect(queue.shift()?.text).toBe('first');
    expect(queue.queued().map((item) => item.text)).toEqual(['second']);
  });

  it('scopes the queue to the session each prompt belongs to', () => {
    const queue = store();
    queue.enqueue({ text: 'for A', images: [], pins: [] }, 'a');
    queue.enqueue({ text: 'for B', images: [], pins: [] }, 'b');

    // A settle in session B must not dispatch the prompt queued for A.
    expect(queue.head('b')?.text).toBe('for B');
    expect(queue.shift('b')?.text).toBe('for B');
    expect(queue.queued().map((item) => item.text)).toEqual(['for A']);
  });

  it('shows each tab only its own queue', () => {
    const queue = store();
    queue.enqueue({ text: 'for A', images: [], pins: [] }, 'a');
    queue.enqueue({ text: 'for B', images: [], pins: [] }, 'b');

    expect(queue.forOwner('a').map((item) => item.text)).toEqual(['for A']);
    expect(queue.forOwner('b').map((item) => item.text)).toEqual(['for B']);
    expect(queue.forOwner('c')).toEqual([]);
  });

  it('carries a queue across a draft that became a session', () => {
    const queue = store();
    queue.enqueue({ text: 'later', images: [], pins: [] }, 'draft-1');

    queue.rekey('draft-1', 's1');

    expect(queue.forOwner('s1').map((item) => item.text)).toEqual(['later']);
    expect(queue.forOwner('draft-1')).toEqual([]);
  });

  it('removes a single follow-up by id', () => {
    const queue = store();
    const id = queue.enqueue({ text: 'drop me', images: [], pins: [] });

    queue.remove(id);

    expect(queue.queued()).toEqual([]);
    expect(queue.shift()).toBeUndefined();
  });

  it('moves a follow-up past the one it is dropped on, both ways', () => {
    const queue = store();
    const first = queue.enqueue({ text: 'first', images: [], pins: [] }, 's1');
    const second = queue.enqueue({ text: 'second', images: [], pins: [] }, 's1');
    const third = queue.enqueue({ text: 'third', images: [], pins: [] }, 's1');

    // Dropped downward it lands after the target; upward, before it.
    queue.move(first, third);
    expect(queue.forOwner('s1').map((item) => item.text)).toEqual(['second', 'third', 'first']);

    queue.move(first, second);
    expect(queue.forOwner('s1').map((item) => item.text)).toEqual(['first', 'second', 'third']);
  });

  it('moves the head, so the queue dispatches what the reader chose first', () => {
    const queue = store();
    queue.enqueue({ text: 'first', images: [], pins: [] }, 's1');
    const second = queue.enqueue({ text: 'second', images: [], pins: [] }, 's1');

    queue.move(second, 'queued-1');

    expect(queue.shift('s1')?.text).toBe('second');
  });

  it('refuses a cross-session or self move', () => {
    const queue = store();
    const a = queue.enqueue({ text: 'for A', images: [], pins: [] }, 'a');
    const b = queue.enqueue({ text: 'for B', images: [], pins: [] }, 'b');

    expect(queue.canMove(a, b)).toBe(false);
    expect(queue.canMove(a, a)).toBe(false);
    queue.move(b, a);

    expect(queue.forOwner('a').map((item) => item.text)).toEqual(['for A']);
    expect(queue.forOwner('b').map((item) => item.text)).toEqual(['for B']);
  });
});
