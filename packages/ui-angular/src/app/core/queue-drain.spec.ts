import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from './morse.service';
import { QueueDrain } from './queue-drain';
import { QueuedPrompts } from './queued-prompts';

type MutableActivity = Map<string, { streaming: boolean; busy: boolean }>;

function idle(streaming = false): { streaming: boolean; busy: boolean } {
  return { streaming, busy: false };
}

function setup() {
  const activity = signal<MutableActivity>(new Map());
  const prompt = vi.fn();
  const fake = { sessionActivity: activity, prompt };
  TestBed.configureTestingModule({ providers: [{ provide: MorseService, useValue: fake }] });
  // Constructing the service is what arms its effect in the real app (`App`
  // injects it); a service does not drive change detection, so `tick()` flushes.
  TestBed.inject(QueueDrain);
  const queue = TestBed.inject(QueuedPrompts);
  TestBed.tick();
  return { activity, prompt, queue };
}

function enqueue(queue: QueuedPrompts, text: string, owner: string): void {
  queue.enqueue({ text, images: [], pins: [] }, owner);
}

describe('QueueDrain', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('runs a background session\u2019s queue when it settles, without the tab in front', () => {
    const { activity, prompt, queue } = setup();
    enqueue(queue, 'later', 's2');

    // The session is hot and idle even though another tab is in front.
    activity.set(new Map([['s2', idle()]]));
    TestBed.tick();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith('later', 'new', [], [], 's2');
    expect(queue.forOwner('s2')).toHaveLength(0);
  });

  it('waits while the session is working and drains once it settles', () => {
    const { activity, prompt, queue } = setup();
    enqueue(queue, 'later', 's2');

    activity.set(new Map([['s2', idle(true)]]));
    TestBed.tick();
    expect(prompt).not.toHaveBeenCalled();

    activity.set(new Map([['s2', idle()]]));
    TestBed.tick();
    expect(prompt).toHaveBeenCalledWith('later', 'new', [], [], 's2');
  });

  it('sends one prompt per settle, keeping the queue order', () => {
    const { activity, prompt, queue } = setup();
    enqueue(queue, 'first', 's2');
    enqueue(queue, 'second', 's2');

    activity.set(new Map([['s2', idle()]]));
    TestBed.tick();
    // One settle, one prompt: the other waits for the run this one starts.
    expect(prompt.mock.calls.map((call) => call[0])).toEqual(['first']);

    activity.set(new Map([['s2', idle(true)]]));
    TestBed.tick();
    activity.set(new Map([['s2', idle()]]));
    TestBed.tick();

    expect(prompt.mock.calls.map((call) => call[0])).toEqual(['first', 'second']);
    expect(queue.forOwner('s2')).toHaveLength(0);
  });

  it('keeps a queue while its session is not hot instead of dropping it', () => {
    const { activity, prompt, queue } = setup();
    enqueue(queue, 'later', 's3');

    // Only another session is live: there is no agent to run it in yet.
    activity.set(new Map([['s1', idle()]]));
    TestBed.tick();

    expect(prompt).not.toHaveBeenCalled();
    expect(queue.forOwner('s3')).toHaveLength(1);
  });

  it('does not dispatch a draft\u2019s queue, which has no session yet', () => {
    const { activity, prompt, queue } = setup();
    queue.enqueue({ text: 'draft', images: [], pins: [] }, undefined);

    activity.set(new Map([['s1', idle()]]));
    TestBed.tick();

    expect(prompt).not.toHaveBeenCalled();
    expect(queue.queued()).toHaveLength(1);
  });
});
