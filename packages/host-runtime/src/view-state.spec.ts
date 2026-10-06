import { describe, expect, it } from 'vitest';
import type { AgentSessionState } from '@morse/core';
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
});
