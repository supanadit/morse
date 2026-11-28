import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@morse/agent';
import type { HostToClientMessage, SharedComposerState } from '@morse/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerHub } from './composer-hub.js';
import { silentLogger } from '../logger.js';

type Tagged = { sessionKey: string; event: AgentEvent };

function setup(existingDir?: string) {
  const prompt = vi.fn(async () => ({ accepted: true }));
  const compact = vi.fn(async () => undefined);
  const setModel = vi.fn(async () => undefined);
  const setThinkingLevel = vi.fn(async () => undefined);
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
  const dataDir = existingDir ?? mkdtempSync(join(tmpdir(), 'morse-composer-'));
  const hub = new ComposerHub({
    chat: { prompt, compact, setModel, setThinkingLevel },
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
  return {
    hub,
    prompt,
    compact,
    setModel,
    setThinkingLevel,
    userPrompt,
    emitted,
    states,
    event,
    stateOf,
    dataDir,
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function runEnd(reason: 'settled' | 'aborted' | 'error'): AgentEvent {
  return { type: 'agent/run-end', reason, at: 1 };
}

function input(text: string) {
  return { text, images: [], pins: [] };
}

describe('ComposerHub picks', () => {
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

  it('holds a pick made mid-run and applies it to the next turn, not the live one', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    const model = { provider: 'zai', id: 'glm-5.4', name: 'GLM-5.4' };

    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { model } });
    // The running turn is untouched: nothing reached the engine.
    expect(test.setModel).not.toHaveBeenCalled();
    expect(test.stateOf('s1')?.pending).toEqual({ model });

    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('after this') });
    // The row is stamped with what it will run on, and is still only queued.
    expect(test.stateOf('s1')?.queue[0]?.pick).toEqual({ model });
    expect(test.setModel).not.toHaveBeenCalled();

    test.states.set('s1', { streaming: false });
    test.event('s1', runEnd('settled'));
    await settle();

    // Applied first, then sent: the next turn runs on the pick.
    expect(test.setModel).toHaveBeenCalledWith(model, 's1');
    expect(test.prompt).toHaveBeenCalledTimes(1);
    expect(test.setModel.mock.invocationCallOrder[0]).toBeLessThan(
      test.prompt.mock.invocationCallOrder[0] ?? Infinity,
    );
    // Consumed: it was for that one turn.
    expect(test.stateOf('s1')).toBeUndefined();
  });

  it('merges a model pick and a thinking pick into one next turn', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    test.hub.handle({
      sessionId: 's1',
      action: 'pick',
      pick: { model: { provider: 'zai', id: 'glm-5.4' } },
    });
    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { thinking: 'high' } });
    expect(test.stateOf('s1')?.pending).toEqual({
      model: { provider: 'zai', id: 'glm-5.4' },
      thinking: 'high',
    });

    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('go') });
    test.states.set('s1', { streaming: false });
    test.event('s1', runEnd('settled'));
    await settle();
    expect(test.setThinkingLevel).toHaveBeenCalledWith('high', 's1');
  });

  it('runs each queued message on its own model, in order', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    const a = { provider: 'zai', id: 'glm-5.4' };
    const b = { provider: 'opencode-go', id: 'claude-opus-5' };

    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { model: a } });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('first') });
    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { model: b } });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('second') });

    const queue = test.stateOf('s1')?.queue ?? [];
    expect(queue.map((item) => item.pick?.model?.id)).toEqual(['glm-5.4', 'claude-opus-5']);

    // Two settles drain both, each preceded by its own model.
    test.states.set('s1', { streaming: false });
    test.event('s1', runEnd('settled'));
    await settle();
    test.event('s1', runEnd('settled'));
    await settle();
    expect(test.setModel.mock.calls.map((call) => call[0].id)).toEqual([
      'glm-5.4',
      'claude-opus-5',
    ]);
    expect(test.prompt.mock.calls.map((call) => call[0])).toEqual(['first', 'second']);
  });

  it('every message queued after a pick runs on it, and none on a model it did not advertise', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    const model = { provider: 'zai', id: 'glm-5.4' };
    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { model } });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('first') });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('second') });
    // Each row names the model it will fire on, before anything runs.
    expect(test.stateOf('s1')?.queue.map((item) => item.pick?.model)).toEqual([model, model]);

    test.states.set('s1', { streaming: false });
    test.event('s1', runEnd('settled'));
    await settle();
    test.event('s1', runEnd('settled'));
    await settle();

    expect(test.prompt.mock.calls.map((call) => call[0])).toEqual(['first', 'second']);
    // Every set is the advertised model; nothing else was ever applied.
    expect(test.setModel.mock.calls.every((call) => call[0].id === 'glm-5.4')).toBe(true);
  });

  it('re-picking mid-queue gives the messages after the re-pick the new model', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    const glm = { provider: 'zai', id: 'glm-5.4' };
    const opus = { provider: 'opencode-go', id: 'claude-opus-5' };
    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { model: glm } });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('on glm') });
    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { model: opus } });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('on opus') });
    expect(test.stateOf('s1')?.queue.map((item) => item.pick?.model?.id)).toEqual([
      'glm-5.4',
      'claude-opus-5',
    ]);

    test.states.set('s1', { streaming: false });
    test.event('s1', runEnd('settled'));
    await settle();
    test.event('s1', runEnd('settled'));
    await settle();
    // The last model set before each message is the one its row promised.
    const order = [
      ...test.setModel.mock.calls.map((call, i) => ({
        at: test.setModel.mock.invocationCallOrder[i],
        what: call[0].id,
      })),
      ...test.prompt.mock.calls.map((call, i) => ({
        at: test.prompt.mock.invocationCallOrder[i],
        what: call[0],
      })),
    ].sort((a, b) => a.at - b.at);
    expect(order.map((entry) => entry.what)).toEqual([
      'glm-5.4',
      'on glm',
      'claude-opus-5',
      'on opus',
    ]);
  });

  it('a steer while streaming keeps the live model: the pick stays for the next turn', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { model: { provider: 'zai', id: 'glm-5.4' } } });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('join this run') });
    const id = test.stateOf('s1')?.queue[0]?.id ?? '';

    test.hub.handle({ sessionId: 's1', action: 'send', itemId: id });
    await settle();

    // Sent as a steer into the running turn — which keeps its own model.
    expect(test.prompt).toHaveBeenCalledWith('join this run', 'steer', [], [], 's1');
    expect(test.setModel).not.toHaveBeenCalled();
  });

  it('keeps a consumed pick when the turn it was for is refused', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    const model = { provider: 'zai', id: 'glm-5.4' };
    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { model } });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('later') });
    test.prompt.mockResolvedValueOnce({ accepted: false, reason: 'refused' });

    test.states.set('s1', { streaming: false });
    test.event('s1', runEnd('settled'));
    await settle();

    // The queue pauses with the item and its model intact, for the reader to retry.
    expect(test.stateOf('s1')?.paused).toBe('failed');
    expect(test.stateOf('s1')?.queue[0]?.pick).toEqual({ model });
  });

  it('a refused Send-now of a stamped item does not leak its model onto a later turn', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: false });
    const model = { provider: 'zai', id: 'glm-5.4' };
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: { ...input('mine'), pick: { model } } });
    const id = test.stateOf('s1')?.queue[0]?.id ?? '';
    test.prompt.mockResolvedValueOnce({ accepted: false, reason: 'refused' });

    test.hub.handle({ sessionId: 's1', action: 'send', itemId: id });
    await settle();

    // The item keeps its own model for the retry; the session has no pending
    // pick, so nothing else inherits it.
    expect(test.stateOf('s1')?.queue[0]?.pick).toEqual({ model });
    expect(test.stateOf('s1')?.pending).toBeUndefined();
  });

  it('a queued model and a pending pick survive a restart', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    const model = { provider: 'zai', id: 'glm-5.4', name: 'GLM-5.4' };
    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { model } });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('kept') });
    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { thinking: 'high' } });

    // A fresh hub over the same data dir, as a restarted host would build one.
    const restarted = setup(dir);
    const state = restarted.hub.snapshot().states.find((entry) => entry.sessionId === 's1');
    expect(state?.queue[0]?.pick).toEqual({ model });
    expect(state?.pending).toEqual({ model, thinking: 'high' });
    // The snapshot a reconnecting client receives is the same one.
    expect(restarted.hub.snapshot().states.some((entry) => entry.sessionId === 's1')).toBe(true);
  });

  it('forgets a pending pick with its session', () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    test.hub.handle({ sessionId: 's1', action: 'pick', pick: { thinking: 'low' } });
    test.hub.forget('s1');
    expect(test.stateOf('s1')).toBeUndefined();
    expect(test.hub.snapshot().states).toEqual([]);
  });
});

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

  it('holds a session’s queue and Send-now during its compaction, without holding another’s', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: false });
    test.states.set('s2', { streaming: false });
    test.hub.setCompacting('s1', true);
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('during') });
    await settle();
    expect(test.prompt).not.toHaveBeenCalled();

    // Even an explicit Send-now leaves the item queued while the rewrite runs.
    const id = test.stateOf('s1')?.queue[0]?.id;
    expect(id).toBeDefined();
    test.hub.handle({ sessionId: 's1', action: 'send', itemId: id! });
    await settle();
    expect(test.prompt).not.toHaveBeenCalled();
    expect(test.stateOf('s1')?.queue.map((item) => item.text)).toEqual(['during']);

    // A different conversation is not affected by s1's gate.
    test.hub.handle({ sessionId: 's2', action: 'enqueue', item: input('elsewhere') });
    await settle();
    expect(test.prompt).toHaveBeenCalledWith('elsewhere', 'new', [], [], 's2');

    test.hub.setCompacting('s1', false);
    await settle();
    expect(test.prompt).toHaveBeenCalledWith('during', 'new', [], [], 's1');
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

  it('cancels a queued compaction exactly like a queued message', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: true });
    test.hub.handle({
      sessionId: 's1',
      action: 'enqueue',
      item: { ...input('ignored'), text: 'Compact context', compaction: {} },
    });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('keep me') });
    const id = test.stateOf('s1')?.queue.find((item) => item.compaction !== undefined)?.id;
    expect(id).toBeDefined();

    test.hub.handle({ sessionId: 's1', action: 'remove', itemId: id! });
    expect(test.stateOf('s1')?.queue.map((item) => item.text)).toEqual(['keep me']);

    test.states.set('s1', { streaming: false });
    test.event('s1', runEnd('settled'));
    await settle();

    expect(test.compact).not.toHaveBeenCalled();
    expect(test.prompt).toHaveBeenCalledWith('keep me', 'new', [], [], 's1');
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

  it('pauses a failed item instead of retrying it on every settle', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: false });
    test.compact.mockRejectedValueOnce(new Error('engine blew up'));
    test.hub.handle({
      sessionId: 's1',
      action: 'enqueue',
      item: { text: 'Compact context', images: [], pins: [], compaction: {} },
    });
    await settle();

    expect(test.compact).toHaveBeenCalledTimes(1);
    // The item stays at the head, the queue pauses, and the reader is told —
    // the next settle must not silently retry it.
    expect(test.stateOf('s1')?.queue.map((item) => item.text)).toEqual(['Compact context']);
    expect(test.stateOf('s1')?.paused).toBe('failed');
    expect(
      test.emitted.some(
        (message) =>
          message.type === 'notice' &&
          message.payload.level === 'error' &&
          message.payload.text.includes('failed to run'),
      ),
    ).toBe(true);

    test.event('s1', runEnd('settled'));
    await settle();
    expect(test.compact).toHaveBeenCalledTimes(1);
  });

  it('waits without pausing when the session is not open yet', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    test.states.set('s1', { streaming: false });
    test.prompt.mockResolvedValueOnce({ accepted: false, reason: 'no-session' });
    test.hub.handle({ sessionId: 's1', action: 'enqueue', item: input('next') });
    await settle();

    // Still queued, explicitly not paused: opening the session drains it.
    expect(test.stateOf('s1')?.queue.map((item) => item.text)).toEqual(['next']);
    expect(test.stateOf('s1')?.paused).toBeUndefined();
    expect(
      test.emitted.some(
        (message) => message.type === 'notice' && message.payload.text.includes('not open'),
      ),
    ).toBe(true);
  });

  it('reports a drained compaction as busy while it runs, whatever starts it', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    const seen: [string, boolean][] = [];
    test.hub.subscribeCompacting((sessionKey, active) => seen.push([sessionKey, active]));
    let release: () => void = () => undefined;
    test.compact.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    test.states.set('s1', { streaming: false });
    test.hub.handle({
      sessionId: 's1',
      action: 'enqueue',
      item: { text: 'Compact context', images: [], pins: [], compaction: {} },
    });
    await settle();

    // Rewriting in flight: every controller learns it, so the session reads
    // Working instead of idle.
    expect(seen).toEqual([['s1', true]]);
    release();
    await settle();
    await settle();
    expect(seen).toEqual([
      ['s1', true],
      ['s1', false],
    ]);
  });

  it('treats a compaction against a closed session as a wait, not a failure', async () => {
    const test = setup();
    dir = test.dataDir;
    hub = test.hub;
    const { AgentUnavailableError } = await import('../errors.js');
    test.states.set('s1', { streaming: false });
    test.compact.mockRejectedValueOnce(new AgentUnavailableError('Session s1 is no longer open.'));
    test.hub.handle({
      sessionId: 's1',
      action: 'enqueue',
      item: { text: 'Compact context', images: [], pins: [], compaction: {} },
    });
    await settle();

    expect(test.stateOf('s1')?.queue.map((item) => item.text)).toEqual(['Compact context']);
    expect(test.stateOf('s1')?.paused).toBeUndefined();
  });
});
