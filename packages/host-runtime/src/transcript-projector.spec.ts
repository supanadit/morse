import { describe, expect, it } from 'vitest';
import type { HostToClientMessage } from '@morse/protocol';
import { TranscriptProjector } from './transcript-projector.js';

const TICKS = [10, 20, 30, 40];
let next = 0;
const now = (): number => TICKS[next++ % TICKS.length];

describe('TranscriptProjector live compaction', () => {
  it('records a successful compaction as a marker row carrying the summary', () => {
    const emitted: HostToClientMessage[] = [];
    const projector = new TranscriptProjector({ emit: (message) => emitted.push(message), now });

    projector.apply({
      type: 'agent/compaction',
      at: now(),
      summary: '## Summary\n\nBuilt the tree.',
      tokensBefore: 150_000,
    });
    const appends = emitted
      .filter((message): message is Extract<HostToClientMessage, { type: 'transcript/append' }> =>
        message.type === 'transcript/append',
      )
      .map((message) => message.payload);
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({
      kind: 'compaction',
      summary: expect.stringContaining('Built the tree.'),
      tokensBefore: 150_000,
    });
    expect(projector.snapshot()).toHaveLength(1);
  });

  it('keeps a summary-less marker without an empty summary field', () => {
    const emitted: HostToClientMessage[] = [];
    const projector = new TranscriptProjector({ emit: (message) => emitted.push(message), now });

    projector.apply({ type: 'agent/compaction', at: now(), summary: '' });
    const appends = emitted
      .filter((message): message is Extract<HostToClientMessage, { type: 'transcript/append' }> =>
        message.type === 'transcript/append',
      )
      .map((message) => message.payload);
    expect(appends[0]).toMatchObject({ kind: 'compaction' });
    expect('summary' in (appends[0] as Record<string, unknown>)).toBe(false);
  });
});

/**
 * pi never reports a per-tool duration, so the projector measures one from the
 * start it stamped — otherwise a finished turn can never say "Worked for Ns".
 */
describe('TranscriptProjector tool elapsed', () => {
  it('measures a duration when the event carries none', () => {
    const emitted: HostToClientMessage[] = [];
    let clock = 1_000;
    const projector = new TranscriptProjector({
      emit: (message) => emitted.push(message),
      now: () => clock,
    });

    projector.apply({
      type: 'agent/tool-start',
      at: clock,
      toolCallId: 'c1',
      name: 'bash',
      title: 'bash: npm test',
    });
    clock = 4_500;
    projector.apply({
      type: 'agent/tool-end',
      at: clock,
      toolCallId: 'c1',
      status: 'ok',
      output: 'done',
    });

    const item = projector.snapshot().find((entry) => entry.kind === 'tool');
    expect(item).toMatchObject({ kind: 'tool', status: 'ok', durationMs: 3_500 });
  });

  it('keeps a duration the event did report', () => {
    const emitted: HostToClientMessage[] = [];
    const projector = new TranscriptProjector({
      emit: (message) => emitted.push(message),
      now: () => 0,
    });

    projector.apply({
      type: 'agent/tool-start',
      at: 0,
      toolCallId: 'c1',
      name: 'read',
      title: 'read: a.ts',
    });
    projector.apply({
      type: 'agent/tool-end',
      at: 0,
      toolCallId: 'c1',
      status: 'ok',
      durationMs: 42,
    });

    expect(projector.snapshot().find((entry) => entry.kind === 'tool')).toMatchObject({
      durationMs: 42,
    });
  });
});