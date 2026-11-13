import { describe, expect, it, vi } from 'vitest';
import type { HostSessionController } from '@morse/system';
import { silentLogger } from '@morse/system';
import type { WebSocket } from 'ws';
import { MorseGateway } from './morse.gateway.js';
import type { MorseSessionFactory } from './session-factory.service.js';

/**
 * A client frame that makes the controller throw is a bug in this host. The
 * socket must not go silent over it: the failure is logged and reported down the
 * connection's own error channel, so the rest of the session keeps working.
 */
function socket(): {
  client: WebSocket;
  handlers: Map<string, (...args: unknown[]) => void>;
  send: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const send = vi.fn();
  const client = {
    readyState: 1,
    send,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return client;
    },
  } as unknown as WebSocket;
  return { client, handlers, send };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('MorseGateway message handling', () => {
  it('logs a throwing handler and reports it on the same socket', async () => {
    const controller = {
      start: vi.fn(async () => undefined),
      handleClientMessage: vi.fn(async () => {
        throw new Error('boom');
      }),
      dispose: vi.fn(async () => undefined),
    } as unknown as HostSessionController;
    const release = vi.fn();
    const sessions = {
      createFor: vi.fn(() => controller),
      release,
    } as unknown as MorseSessionFactory;
    const errors: string[] = [];
    const logger = {
      ...silentLogger,
      error: (message: string) => errors.push(message),
    };
    const gateway = new MorseGateway(sessions, logger);
    const { client, handlers: socketHandlers, send } = socket();

    gateway.handleConnection(client);
    socketHandlers.get('message')?.(
      Buffer.from(JSON.stringify({ type: 'bot/list', payload: {} })),
    );
    await flush();

    expect(errors[0]).toContain('bot/list');
    expect(send).toHaveBeenCalledTimes(1);
    const frame = JSON.parse(send.mock.calls[0]?.[0] as string) as unknown;
    expect(frame).toEqual({
      type: 'error',
      payload: { message: 'boom', at: expect.any(Number) as number },
    });
    // The connection is still usable: a later frame is handled, not dropped.
    socketHandlers.get('message')?.(
      Buffer.from(JSON.stringify({ type: 'bot/list', payload: {} })),
    );
    await flush();
    expect(controller.handleClientMessage).toHaveBeenCalledTimes(2);
  });
});
