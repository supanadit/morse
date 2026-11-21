import { describe, expect, it, vi } from 'vitest';
import type { AgentInteractionRequest } from '@morse/agent';
import { InteractionHub } from './interaction-hub.js';

const REQUEST: AgentInteractionRequest = {
  requestId: 'req-1',
  kind: 'form',
  title: 'Composer fix',
  fields: [{ key: 'choice', label: 'Choice', type: 'text', required: true }],
};

describe('InteractionHub', () => {
  it('tells every subscriber when a request arrives and when it is settled', () => {
    const hub = new InteractionHub();
    const first = vi.fn();
    const second = vi.fn();
    hub.subscribe(first);
    hub.subscribe(second);

    hub.add('sess-a', REQUEST);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(hub.pendingFor('sess-a')).toBe(REQUEST);

    expect(hub.settle('req-1')).toBe('sess-a');
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(hub.pendingFor('sess-a')).toBeUndefined();
  });

  it('does not re-notify when another client repeats the request it already holds', () => {
    const hub = new InteractionHub();
    const changed = vi.fn();
    hub.subscribe(changed);

    hub.add('sess-a', REQUEST);
    hub.add('sess-a', REQUEST);

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('keeps one request per session and forgets only the removed session', () => {
    const hub = new InteractionHub();
    const other: AgentInteractionRequest = {
      requestId: 'req-2',
      kind: 'confirm',
      title: 'Proceed?',
      message: 'Continue?',
    };
    hub.add('sess-a', REQUEST);
    hub.add('sess-b', other);

    expect(hub.pendingFor('sess-b')).toBe(other);
    hub.forget('sess-a');
    expect(hub.pendingFor('sess-a')).toBeUndefined();
    expect(hub.pendingFor('sess-b')).toBe(other);
  });
});
