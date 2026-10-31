import type { AgentSessionState } from '@morse/agent';
import { describe, expect, it, vi } from 'vitest';
import { UnsupportedByHostError } from '../errors.js';
import { silentLogger } from '../logger.js';
import { ChatService } from './service.js';
import type { ChatAgent, ChatAgentHolder } from './ports.js';

const state: AgentSessionState = {
  workspace: { cwd: '/work', name: 'work' },
  thinkingLevel: 'off',
  availableModels: [],
  availableThinkingLevels: [],
  availableCommands: [],
  streaming: false,
};

function holder(agent: ChatAgent): ChatAgentHolder {
  return { requireActive: () => agent };
}

function agent(overrides: Partial<ChatAgent> = {}): ChatAgent {
  return {
    state: () => Promise.resolve(state),
    prompt: () => Promise.resolve('started'),
    abort: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    setThinkingLevel: () => Promise.resolve(),
    compact: () => Promise.resolve(),
    ...overrides,
  };
}

describe('ChatService mode selection', () => {
  it('delegates a mode switch to the active session', async () => {
    const setMode = vi.fn(() => Promise.resolve());
    const service = new ChatService({ agent: holder(agent({ setMode })), logger: silentLogger });

    await service.setMode('plan');
    expect(setMode).toHaveBeenCalledWith('plan');
  });

  it('refuses a mode switch when the harness has no modes', async () => {
    const service = new ChatService({ agent: holder(agent()), logger: silentLogger });
    await expect(service.setMode('plan')).rejects.toBeInstanceOf(UnsupportedByHostError);
  });
});
