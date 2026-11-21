import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { SharedComposerDraft, SharedComposerState } from '@morse/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../host/morse.service';
import { ComposerDrafts } from '../state/composer-drafts';
import { QueuedPrompts } from '../state/queued-prompts';
import { ComposerSync } from './composer-sync';

function setup(shared = true) {
  const stateListeners = new Set<(state: SharedComposerState) => void>();
  const draftListeners = new Set<(draft: SharedComposerDraft) => void>();
  const morse = {
    sharedComposer: signal(shared),
    onComposerState: (listener: (state: SharedComposerState) => void) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    onComposerDraft: (listener: (draft: SharedComposerDraft) => void) => {
      draftListeners.add(listener);
      return () => {
        draftListeners.delete(listener);
      };
    },
    composerDraft: vi.fn(),
    composerQueue: vi.fn(),
    prompt: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: MorseService, useValue: morse }],
  });
  const sync = TestBed.inject(ComposerSync);
  const queue = TestBed.inject(QueuedPrompts);
  const drafts = TestBed.inject(ComposerDrafts);
  const state = (payload: SharedComposerState): void => {
    for (const listener of [...stateListeners]) {
      listener(payload);
    }
  };
  const draft = (payload: SharedComposerDraft): void => {
    for (const listener of [...draftListeners]) {
      listener(payload);
    }
  };
  return { sync, queue, drafts, morse, state, draft };
}

describe('ComposerSync', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('applies the host\u2019s queue and pause to the store', () => {
    const { queue, state } = setup();

    state({
      sessionId: 's1',
      queue: [
        { id: 'q1', text: 'first' },
        { id: 'q2', text: 'second', compaction: { instructions: 'keep the schema' } },
      ],
      paused: 'failed',
    });

    expect(queue.forOwner('s1').map((item) => item.id)).toEqual(['q1', 'q2']);
    expect(queue.forOwner('s1')[0]?.images).toEqual([]);
    expect(queue.pausedReason('s1')).toBe('failed');
  });

  it('relays typing to the host and applies another device\u2019s text', () => {
    vi.useFakeTimers();
    const { sync, drafts, morse, draft } = setup();

    sync.draft('s1', 'half a thought');
    vi.advanceTimersByTime(250);
    const sent = morse.composerDraft.mock.calls[0]?.[0] as SharedComposerDraft;
    expect(sent).toMatchObject({ sessionId: 's1', text: 'half a thought' });

    // This page's own echo is ignored; another page's words land in the draft.
    draft({ ...sent });
    expect(drafts.snapshot().texts['s1']).toBeUndefined();
    draft({ sessionId: 's1', text: 'from the phone', origin: 'another-page' });
    expect(drafts.snapshot().texts['s1']).toBe('from the phone');
  });

  it('sends queue requests on a shared host, and mutates the store otherwise', () => {
    const shared = setup(true);
    shared.sync.remove('s1', { id: 'q1', text: 'next', images: [], pins: [], sessionId: 's1' });
    expect(shared.morse.composerQueue).toHaveBeenCalledWith({
      sessionId: 's1',
      action: 'remove',
      itemId: 'q1',
    });

    TestBed.resetTestingModule();
    const local = setup(false);
    local.sync.enqueue({ text: 'next', images: [], pins: [] }, 's1');
    expect(local.morse.composerQueue).not.toHaveBeenCalled();
    expect(local.queue.forOwner('s1').map((item) => item.text)).toEqual(['next']);
  });
});
