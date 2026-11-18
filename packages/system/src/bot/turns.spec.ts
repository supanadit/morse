import type { BotActivity, BotHandoff } from '@morse/protocol';
import { describe, expect, it } from 'vitest';
import {
  BotTurnTracker,
  TURN_ERROR_MAX,
  TURN_HANDOFFS_MAX,
  TURN_PARTIAL_MAX,
  TURN_STEPS_MAX,
} from './turns.js';

/** The shortest path to the step a tool call opens, since only its label matters. */
function toolStep(label: string, at: number): BotActivity {
  return { kind: 'tool', label, tool: 'bash', at, status: 'running' };
}

/** An ask a turn made, with the delivery it created. */
function handoff(deliveryId: string, at = 0): BotHandoff {
  return { username: 'loom', conversationId: 'dm-loom', deliveryId, at, state: 'asked' };
}

describe('bot turn tracker', () => {
  it('starts with a starting step and keeps the newest eight', () => {
    const tracker = new BotTurnTracker(() => 0);
    tracker.start('sigil', 'dm-sigil');
    for (let index = 0; index < 10; index += 1) {
      tracker.step('sigil', { kind: 'thinking', label: `step ${index}`, at: index });
    }
    const turn = tracker.get('sigil');
    expect(turn?.steps).toHaveLength(8);
    expect(turn?.steps.at(-1)?.label).toBe('step 9');
    expect(turn?.startedAt).toBe(0);
  });

  it('moves the newest step instead of growing the turn for a repeat', () => {
    const tracker = new BotTurnTracker(() => 0);
    tracker.start('sigil', 'dm-sigil');
    const started = tracker.get('sigil')?.steps;
    expect(started).toHaveLength(1);

    tracker.touch('sigil', 7);
    expect(tracker.get('sigil')?.steps).toHaveLength(1);
    expect(tracker.get('sigil')?.steps.at(-1)?.at).toBe(7);

    tracker.step('sigil', { kind: 'writing', label: 'Writing the answer…', at: 10 });
    tracker.touch('sigil', 42);
    const steps = tracker.get('sigil')?.steps ?? [];
    expect(steps).toHaveLength(2);
    expect(steps.at(-1)).toMatchObject({ kind: 'writing', at: 42 });
  });

  it('closes the step a tool call opened', () => {
    const tracker = new BotTurnTracker(() => 0);
    tracker.start('sigil', 'dm-sigil');
    tracker.step(
      'sigil',
      { kind: 'tool', label: 'Running npm test', tool: 'bash', at: 1, status: 'running' },
      't1',
    );
    tracker.toolStatus('sigil', 't1', { status: 'ok', durationMs: 900 });
    expect(tracker.get('sigil')?.steps.at(-1)).toMatchObject({ status: 'ok', durationMs: 900 });
  });

  it('keeps the tail of the answer and hands the turn over once', () => {
    const tracker = new BotTurnTracker(() => 0);
    tracker.start('sigil', 'dm-sigil');
    tracker.appendPartial('sigil', 'x'.repeat(2_500));
    expect(tracker.get('sigil')?.partial).toHaveLength(2_000);
    expect(tracker.take('sigil')?.conversationId).toBe('dm-sigil');
    expect(tracker.get('sigil')).toBeUndefined();
  });

  it('starts a turn at the clock’s time and forgets it on request', () => {
    let now = 41;
    const tracker = new BotTurnTracker(() => now);
    tracker.start('sigil', 'dm-sigil');
    expect(tracker.get('sigil')?.startedAt).toBe(41);
    expect(tracker.get('sigil')?.steps[0]).toMatchObject({
      kind: 'starting',
      label: 'Getting started…',
      at: 41,
    });

    now = 42;
    tracker.clear('sigil');
    expect(tracker.get('sigil')).toBeUndefined();
    expect(tracker.take('sigil')).toBeUndefined();
  });

  it('keeps the last characters of the answer, not the first', () => {
    const tracker = new BotTurnTracker(() => 0);
    tracker.start('sigil', 'dm-sigil');
    tracker.appendPartial('sigil', 'a'.repeat(1_900));
    tracker.appendPartial('sigil', 'b'.repeat(200));
    expect(tracker.get('sigil')?.partial).toBe('a'.repeat(1_800) + 'b'.repeat(200));
    expect(tracker.get('sigil')?.partial).toHaveLength(TURN_PARTIAL_MAX);
  });

  it('keeps a failed tool’s error to one line of at most 300 characters', () => {
    const tracker = new BotTurnTracker(() => 0);
    tracker.start('sigil', 'dm-sigil');
    tracker.step('sigil', toolStep('Running npm test', 1), 't1');
    tracker.toolStatus('sigil', 't1', {
      status: 'error',
      error: 'first line\nsecond line\nthird line',
    });
    expect(tracker.get('sigil')?.steps.at(-1)?.error).toBe('first line');

    tracker.step('sigil', toolStep('Running npm test', 2), 't2');
    tracker.toolStatus('sigil', 't2', { status: 'error', error: 'x'.repeat(500) });
    expect(TURN_ERROR_MAX).toBe(300);
    expect(tracker.get('sigil')?.steps.at(-1)?.error).toBe('x'.repeat(TURN_ERROR_MAX));
  });

  it('ignores a tool update whose step already fell off the turn', () => {
    const tracker = new BotTurnTracker(() => 0);
    tracker.start('sigil', 'dm-sigil');
    tracker.step('sigil', toolStep('Running npm test', 1), 't1');
    for (let index = 0; index < TURN_STEPS_MAX; index += 1) {
      tracker.step('sigil', { kind: 'thinking', label: `step ${index}`, at: index + 2 });
    }
    const before = tracker.get('sigil')?.steps;
    expect(before?.some((step) => step.kind === 'tool')).toBe(false);

    tracker.toolStatus('sigil', 't1', { status: 'error', error: 'too late' });
    expect(tracker.get('sigil')?.steps).toEqual(before);
  });

  it('keeps the newest eight asks and replaces one already on the row', () => {
    const tracker = new BotTurnTracker(() => 0);
    tracker.start('sigil', 'dm-sigil');
    for (let index = 0; index < 10; index += 1) {
      tracker.handoff('sigil', handoff(`d${index}`, index));
    }
    expect(tracker.get('sigil')?.handoffs.map((entry) => entry.deliveryId)).toEqual([
      'd2',
      'd3',
      'd4',
      'd5',
      'd6',
      'd7',
      'd8',
      'd9',
    ]);

    tracker.handoff('sigil', { ...handoff('d5', 99), state: 'done' });
    const handoffs = tracker.get('sigil')?.handoffs ?? [];
    expect(handoffs).toHaveLength(TURN_HANDOFFS_MAX);
    expect(handoffs[3]).toMatchObject({ deliveryId: 'd5', at: 99, state: 'done' });
  });
});
