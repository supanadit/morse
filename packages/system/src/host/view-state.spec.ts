import { describe, expect, it } from 'vitest';
import type { AgentSessionState, ModelRef } from '@morse/agent';
import { toSessionViewState } from './view-state.js';

const META = { agentReady: true, agentStarting: false, busy: false };

function base(): AgentSessionState {
  return {
    workspace: { cwd: '/repo', name: 'repo' },
    thinkingLevel: 'off',
    availableModels: [],
    availableThinkingLevels: [],
    availableCommands: [],
    streaming: false,
  };
}

describe('toSessionViewState', () => {
  it('carries extension widgets and status lines through as copies', () => {
    const state: AgentSessionState = {
      ...base(),
      widgets: [{ key: 'demo', lines: ['a', 'b'], placement: 'belowEditor' }],
      statuses: [{ key: 'ext', text: 'Turn 3 done' }],
    };

    const view = toSessionViewState(state, META);

    expect(view.widgets).toEqual([{ key: 'demo', lines: ['a', 'b'], placement: 'belowEditor' }]);
    expect(view.statuses).toEqual([{ key: 'ext', text: 'Turn 3 done' }]);
    // A copy, so a later patch on the agent's state cannot mutate the view.
    expect(view.widgets?.[0]?.lines).not.toBe(state.widgets?.[0]?.lines);
  });

  it('leaves them out when the agent has none', () => {
    const view = toSessionViewState(base(), META);

    expect(view.widgets).toBeUndefined();
    expect(view.statuses).toBeUndefined();
  });

  it('carries the input modalities, as a copy, so the picker can badge them', () => {
    const input: ModelRef['input'] = ['text', 'image'];
    const state: AgentSessionState = {
      ...base(),
      model: { provider: 'ollama', id: 'gemma-3', name: 'Gemma 3', input },
    };

    const view = toSessionViewState(state, META);

    expect(view.model?.input).toEqual(['text', 'image']);
    expect(view.model?.input).not.toBe(input);
  });

  it('omits input when pi did not report any, instead of claiming text-only', () => {
    const state: AgentSessionState = {
      ...base(),
      model: { provider: 'ollama', id: 'mystery', name: 'Mystery' },
      availableModels: [{ provider: 'ollama', id: 'mystery', name: 'Mystery', input: [] }],
    };

    const view = toSessionViewState(state, META);

    expect(view.model?.input).toBeUndefined();
    expect(view.availableModels[0]?.input).toBeUndefined();
  });

  it('carries the measured session speed through, as a copy', () => {
    const speed = { avgTokensPerSecond: 42.7, peakTokensPerSecond: 88.9, slowestTokensPerSecond: 11.3 };
    const view = toSessionViewState({ ...base(), speed }, META);

    expect(view.speed).toEqual(speed);
    // A copy, so a later patch on the agent's state cannot mutate the view.
    expect(view.speed).not.toBe(speed);
  });

  it('leaves speed absent on a session that predates the feature', () => {
    // An old session file carries no measurement: the panel must show — rather
    // than a zero, so the key is omitted entirely rather than defaulted.
    const view = toSessionViewState(base(), META);

    expect(view.speed).toBeUndefined();
  });
});
