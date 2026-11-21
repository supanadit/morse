import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@morse/agent';
import type { HostToClientMessage, SharedComposerState } from '@morse/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerHub } from './composer-hub.js';
import { silentLogger } from '../logger.js';

type Tagged = { sessionKey: string; event: AgentEvent };

function setup() {
  const prompt = vi.fn(async () => ({ accepted: true }));
  const compact = vi.fn(async () => undefined);
  const userPrompt = vi.fn();
  const emitted: HostToClientMessage[] = [];
  const states = new Map<string, { streaming: boolean }>();
  let listener: ((tagged: Tagged) => void) | undefined;
  const registry = {
    subscribe: (next: (tagged: Tagged) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    stateOf: (key: string) => states.get(key),
  };
  const dataDir = mkdtempSync(join(tmpdir(), 'morse-composer-'));
  const hub = new ComposerHub({
    chat: { prompt, compact },
    transcripts: { userPrompt },
    registry,
    dataDir,
    logger: silentLogger,
  });
  hub.subscribe((message) => emitted.push(message));
  const event = (sessionKey: string, next: AgentEvent): void => {
    listener?.({ sessionKey, event: next });
  };
  const stateOf = (sessionKey: string): SharedComposerState | undefined =>
    hub.snapshot().states.find((state) => state.sessionId === sessionKey);
  return { hub, prompt, compact, userPrompt, emitted, states, event, stateOf, dataDir };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function runEnd(reason: 'settled' | 'aborted' | 'error'): AgentEvent {
  return { type: 'agent/run-end', reason, at: 1 };
}

function input(text: string) {
  return { text, images: [], pins: [] };
}

describe('ComposerHub', () => {
  let dir = '';
  let hub: ComposerHub | undefined;

  beforeEach(() => {
    hub = undefined;
  });

  afterEach(() => {
    if (dir.length > 0) {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('drains the head when a run settles naturally', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('next') });
    expect(test.prompt).not.toHaveBeenCalled();

    test.states.set('s1', { streaming: false });
    test.event('s1', runEnd('settled'));
    await settle();

    expect(test.prompt).toHaveBeenCalledWith(
      'next',
      'new',
      [],
      [],
      's1',
    );
    expect(test.userPrompt).toHaveBeenCalledWith('s1', 'next', [], []);
    // An empty, unpaused queue is not part of the snapshot (and the broadcast
    // already told the client to clear the row).
    expect(test.stateOf('s1')).toBeUndefined();
  });

  it('pauses after the reader\u2019s Stop, and continue sends the head', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('next') });

    test.hub.requestStop('s1');
    test.event('s1', runEnd('aborted'));
    await settle();

    expect(test.prompt).not.toHaveBeenCalled();
    expect(test.stateOf('s1')?.paused).toBe('stopped');

    test.states.set('s1', { streaming: false });
    test.hub.handle({ sessionId: 's1', action: 'continue' });
    await settle();

    expect(test.prompt).toHaveBeenCalledTimes(1);
    expect(test.stateOf('s1')?.paused).toBeUndefined();
  });

  it('does not pause on a compaction\u2019s own abort', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('next') });

    // No `requestStop`: pi's compaction aborts the run itself.
    test.states.set('s1', { streaming: false });
    test.event('s1', runEnd('aborted'));
    await settle();

    expect(test.stateOf('s1')?.paused).toBeUndefined();
    expect(test.prompt).toHaveBeenCalledTimes(1);
  });

  it('pauses as failed after a crashed run', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('next') });

    test.event('s1', runEnd('error'));
    await settle();

    expect(test.stateOf('s1')?.paused).toBe('failed');
    expect(test.prompt).not.toHaveBeenCalled();
  });

  it('resumes without sending, and the next natural finish drains', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('next') });
    test.hub.requestStop('s1');
    test.event('s1', runEnd('aborted'));

    test.hub.handle({ sessionId: 's1', action: 'resume' });
    expect(test.stateOf('s1')?.paused).toBeUndefined();
    expect(test.prompt).not.toHaveBeenCalled();

    test.states.set('s1', { streaming: false });
    test.event('s1', runEnd('settled'));
    await settle();
    expect(test.prompt).toHaveBeenCalledTimes(1);
  });

  it('sends one queued item now, steering while a run is live', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('first') });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('second') });
    const first = test.stateOf('s1')?.queue[0];
    expect(first).toBeDefined();

    test.hub.handle({ sessionId: 's1', action: 'send', itemId: first!.id });
    await settle();

    expect(test.prompt).toHaveBeenCalledWith('first', 'steer', [], [], 's1');
    expect(test.stateOf('s1')?.queue.map((item) => item.text)).toEqual(['second']);
  });

  it('dispatches an enqueue that arrives after the run already settled', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: false });

    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('late') });
    await settle();

    expect(test.prompt).toHaveBeenCalledTimes(1);
  });

  it('keeps a cold session\u2019s queue until it opens, then drains it', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    // Not hot yet: no state at all.
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('later') });
    await settle();
    expect(test.prompt).not.toHaveBeenCalled();

    test.states.set('s1', { streaming: false });
    test.event('s1', {
      type: 'agent/ready',
      at: 1,
      state: { workspace: { cwd: '/repo', name: 'repo' } },
    } as AgentEvent);
    await settle();

    expect(test.prompt).toHaveBeenCalledTimes(1);
  });

  it('persists the paused queue across a restart', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('next') });
    test.hub.requestStop('s1');
    test.event('s1', runEnd('aborted'));
    await settle();

    const again = new ComposerHub({
      chat: { prompt: test.prompt, compact: test.compact },
      transcripts: { userPrompt: test.userPrompt },
      registry: {
        subscribe: () => () => undefined,
        stateOf: () => ({ streaming: false }),
      },
      dataDir: test.dataDir,
      logger: silentLogger,
    });
    const saved = again.snapshot().states.find((state) => state.sessionId === 's1');
    expect(saved?.paused).toBe('stopped');
    expect(saved?.queue.map((item) => item.text)).toEqual(['next']);
  });

  it('relays the text one device is typing to the others', () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;

    test.hub.setDraft({ sessionId: 's1', text: 'half a thought', origin: 'page-a' });

    const relay = test.emitted.find((message) => message.type === 'composer/draft');
    expect(relay?.payload).toEqual({ sessionId: 's1', text: 'half a thought', origin: 'page-a' });
    expect(test.hub.snapshot().drafts).toContainEqual({
      sessionId: 's1',
      text: 'half a thought',
      origin: '',
    });
  });
});
