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

  it('removes a single follow-up by id', () => {
    const queue = store();
    const id = queue.enqueue({ text: 'drop me', images: [], pins: [] });

    queue.remove(id);

    expect(queue.queued()).toEqual([]);
    expect(queue.shift()).toBeUndefined();
  });
});
