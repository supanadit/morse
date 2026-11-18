import { describe, expect, it } from 'vitest';
import { describeTool, startingActivity, stepForEvent } from './activity.js';

describe('startingActivity', () => {
  it('has a row to show before an engine has said anything at all', () => {
    expect(startingActivity(90)).toEqual({ kind: 'starting', label: 'Getting started…', at: 90 });
  });
});

describe('stepForEvent', () => {
  it('opens a tool step that carries its outcome when it ends', () => {
    const start = stepForEvent(
      {
        type: 'agent/tool-start',
        at: 1,
        toolCallId: 't1',
        name: 'bash',
        title: 'npm test',
        input: '{"command":"npm test"}',
      },
      10,
    );
    expect(start).toMatchObject({
      kind: 'step',
      toolCallId: 't1',
      step: { kind: 'tool', tool: 'bash', status: 'running', label: 'Running npm test…' },
    });

    expect(
      stepForEvent(
        {
          type: 'agent/tool-end',
          at: 1,
          toolCallId: 't1',
          status: 'error',
          output: 'exit 1',
          durationMs: 900,
        },
        20,
      ),
    ).toEqual({
      kind: 'tool',
      toolCallId: 't1',
      status: 'error',
      error: 'exit 1',
      durationMs: 900,
    });
  });

  it('advances a running tool without inventing a step', () => {
    expect(
      stepForEvent({ type: 'agent/tool-update', at: 1, toolCallId: 't1', status: 'running' }, 15),
    ).toEqual({ kind: 'tool', toolCallId: 't1', status: 'running' });
    // A progress report with no status of its own is still a call in flight.
    expect(
      stepForEvent({ type: 'agent/tool-update', at: 1, toolCallId: 't2', output: '…' }, 16),
    ).toEqual({ kind: 'tool', toolCallId: 't2', status: 'running' });
  });

  it('closes a tool that worked without claiming it failed', () => {
    expect(
      stepForEvent(
        {
          type: 'agent/tool-end',
          at: 1,
          toolCallId: 't1',
          status: 'ok',
          output: 'done',
          durationMs: 12,
        },
        17,
      ),
    ).toStrictEqual({ kind: 'tool', toolCallId: 't1', status: 'ok', durationMs: 12 });
  });

  it('writes and clears', () => {
    expect(
      stepForEvent({ type: 'agent/delta', at: 1, channel: 'text', delta: 'Ta' }, 30),
    ).toMatchObject({
      kind: 'step',
      step: { kind: 'writing' },
    });
    expect(stepForEvent({ type: 'agent/message', at: 1, text: 'Tally', thinking: '' }, 40)).toEqual(
      {
        kind: 'clear',
      },
    );
  });

  it('thinks at the start and while the reasoning streams, and says nothing otherwise', () => {
    expect(stepForEvent({ type: 'agent/run-start', at: 1 }, 30)).toMatchObject({
      kind: 'step',
      step: { kind: 'thinking', label: 'Wait, let me think…', at: 30 },
    });
    expect(
      stepForEvent({ type: 'agent/delta', at: 1, channel: 'thinking', delta: 'hmm' }, 31),
    ).toMatchObject({ kind: 'step', step: { kind: 'thinking' } });
    expect(stepForEvent({ type: 'agent/run-end', at: 1, reason: 'settled' }, 32)).toBeUndefined();
  });
});

describe('describeTool', () => {
  it('drops the engine’s own "<tool>: " prefix in favour of a proper verb', () => {
    expect(describeTool('edit', 'edit: src/app.ts').label).toBe('Editing src/app.ts…');
    // Engines capitalise inconsistently; the name is matched case-insensitively.
    expect(describeTool('Read', 'READ: notes.md').label).toBe('Reading notes.md…');
  });

  it('reads the thing being worked on out of the raw arguments when a title says no more', () => {
    expect(describeTool('write', 'write', '{"path":"docs/STATUS.md"}').label).toBe(
      'Writing docs/STATUS.md…',
    );
    expect(describeTool('bash', 'bash', '{"command":"npm run lint"}').label).toBe(
      'Running npm run lint…',
    );
  });

  it('still says something useful for a tool Morse has never heard of', () => {
    expect(describeTool('memory_search', 'memory_search').label).toBe('Using memory_search…');
    expect(describeTool('memory_search', 'memory_search: billing').label).toBe(
      'Using memory_search billing…',
    );
  });

  it('keeps the row to one line, however long the command or path is', () => {
    const label = describeTool('bash', 'bash', `{"command":"${'x'.repeat(200)}"}`).label;
    expect(label.startsWith('Running xxx')).toBe(true);
    expect(label.length).toBeLessThanOrEqual('Running '.length + 72 + 1 + 1);
    expect(describeTool('bash', 'bash: a\n  b   c').label).toBe('Running a b c…');
  });

  it('survives arguments that are not JSON, and an unnamed tool', () => {
    expect(describeTool('bash', 'bash', 'not json').label).toBe('Running…');
    expect(describeTool('  ', undefined, undefined).label).toBe('Using tool…');
  });
});
