import type { AgentEvent } from '@morse/agent';
import { describe, expect, it } from 'vitest';
import { activityForEvent, describeTool, startingActivity } from './activity.js';

/** The shortest path to a tool-start event, since only three fields matter here. */
function toolStart(name: string, title?: string, input?: string): AgentEvent {
  return {
    type: 'agent/tool-start',
    at: 0,
    toolCallId: 'call-1',
    name,
    title: title ?? name,
    ...(input === undefined ? {} : { input }),
  };
}

describe('activityForEvent', () => {
  it('starts a round thinking, and keeps thinking while the reasoning streams', () => {
    expect(activityForEvent({ type: 'agent/run-start', at: 12 }, 34)).toEqual({
      kind: 'thinking',
      label: 'Wait, let me think…',
      at: 34,
    });
    expect(
      activityForEvent({ type: 'agent/delta', at: 0, channel: 'thinking', delta: 'hmm' }, 35),
    ).toMatchObject({ kind: 'thinking' });
  });

  it('switches to writing as soon as the answer itself starts streaming', () => {
    expect(
      activityForEvent({ type: 'agent/delta', at: 0, channel: 'text', delta: 'The ' }, 40),
    ).toEqual({ kind: 'writing', label: 'Writing the answer…', at: 40 });
  });

  it('says what a tool is doing to what, naming the tool it came from', () => {
    expect(activityForEvent(toolStart('read', 'read: launch-brief.md'), 50)).toEqual({
      kind: 'tool',
      tool: 'read',
      label: 'Reading launch-brief.md…',
      at: 50,
    });
    expect(activityForEvent(toolStart('bash', 'bash: npm run test:fast'), 51)).toMatchObject({
      label: 'Running npm run test:fast…',
    });
  });

  it('goes back to thinking once a tool comes back', () => {
    const end: AgentEvent = {
      type: 'agent/tool-end',
      at: 0,
      toolCallId: 'call-1',
      status: 'ok',
      output: 'done',
    };
    expect(activityForEvent(end, 60)).toEqual({
      kind: 'thinking',
      label: 'Thinking it over…',
      at: 60,
    });
  });

  it('clears when the answer arrives, so the row becomes the message', () => {
    expect(
      activityForEvent({ type: 'agent/message', at: 0, text: 'Done.', thinking: '' }, 70),
    ).toBe('clear');
  });

  it('says nothing about events that are not work in progress', () => {
    const state: AgentEvent = {
      type: 'agent/state',
      at: 0,
      state: {
        sessionId: 's',
        workspace: { root: '/w' },
        availableModels: [],
        availableThinkingLevels: [],
        availableCommands: [],
        streaming: true,
      },
    };
    expect(activityForEvent(state, 80)).toBeUndefined();
  });

  it('has a row to show before an engine has said anything at all', () => {
    expect(startingActivity(90)).toEqual({ kind: 'starting', label: 'Getting started…', at: 90 });
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
