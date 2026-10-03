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