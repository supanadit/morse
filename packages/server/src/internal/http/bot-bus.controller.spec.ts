import { describe, expect, it, vi } from 'vitest';
import type { HttpException } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { BotBusError, silentLogger } from '@morse/system';
import type { BotRosterEntry, BotBusSendInput } from '@morse/protocol';
import { BotBusController, type BusRequest } from './bot-bus.controller.js';

/**
 * The bus endpoint's whole contract is what the plugins in the two engine
 * packages already POST to: a loopback peer, a bearer token naming the bot, and
 * exactly four tools. Anything else is a refusal the plugin reads as a sentence.
 */

function fakeBot(): {
  resolveBusToken: ReturnType<typeof vi.fn>;
  busRoster: ReturnType<typeof vi.fn>;
  busSend: ReturnType<typeof vi.fn>;
  busHumanRoster: ReturnType<typeof vi.fn>;
  busSendToHuman: ReturnType<typeof vi.fn>;
} {
  return {
    resolveBusToken: vi.fn((token: string) => (token === 'good' ? 'sigil' : undefined)),
    busRoster: vi.fn((_username: string): BotRosterEntry[] => []),
    busSend: vi.fn(async (_username: string, _input: BotBusSendInput) => ({
      deliveryId: 'delivery-1',
      conversationId: 'dm:sigil:loom',
      queued: true,
    })),
    busHumanRoster: vi.fn(async (_username: string) => []),
    busSendToHuman: vi.fn(async (_username: string, _input: unknown) => ({
      deliveryId: 'entry-9',
      conversationId: 'dm__u-ada__sigil',
      queued: true,
    })),
  };
}

function request(
  overrides: {
    auth?: string;
    remoteAddress?: string;
    /** False for a request object with no socket, so `req.ip` is the only peer. */
    socket?: boolean;
    ip?: string;
    headers?: Record<string, string | undefined>;
  } = {},
): BusRequest {
  const headers = overrides.headers ?? {};
  if (overrides.auth !== undefined) {
    headers['authorization'] = overrides.auth;
  }
  return {
    headers,
    ...(overrides.socket === false
      ? {}
      : { socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' } }),
    ...(overrides.ip === undefined ? {} : { ip: overrides.ip }),
  };
}

/** The status and the JSON body a refusal would have produced. */
async function refusal(run: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await run;
  } catch (error: unknown) {
    const http = error as HttpException;
    return { status: http.getStatus(), body: http.getResponse() };
  }
  throw new Error('the controller answered instead of refusing');
}

describe('BotBusController', () => {
  it('answers a POST with 200, not the framework default 201', () => {
    // The plugin reads `error` from a 200 body, and the ruling pins 200 for a
    // `BotBusError`; a `@Post` without `@HttpCode` answers 201 instead.
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, BotBusController.prototype.route)).toBe(200);
  });

  it('refuses a request that did not come from this machine', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    await expect(controller.call('list', {}, request({ remoteAddress: '10.0.0.5' })))
      .rejects.toThrow(/local/i);
    // The peer check runs first: a stranger learns nothing about tokens.
    expect(bot.resolveBusToken).not.toHaveBeenCalled();
  });

  it('accepts every spelling of loopback, including the IPv4-mapped one', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      await expect(
        controller.call('list', {}, request({ auth: 'Bearer good', remoteAddress })),
      ).resolves.toEqual({ bots: [] });
    }
  });

  it('falls back to req.ip and strips the ::ffff: prefix', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    await expect(
      controller.call(
        'list',
        {},
        request({ auth: 'Bearer good', socket: false, ip: '::ffff:127.0.0.1' }),
      ),
    ).resolves.toEqual({ bots: [] });
  });

  it('refuses a missing or unknown token', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    await expect(
      controller.call('list', {}, request({ remoteAddress: '127.0.0.1' })),
    ).rejects.toThrow(/token/);
    await expect(controller.call('list', {}, request({ auth: 'Bearer nope' }))).rejects.toThrow(
      /token/,
    );
    expect(bot.resolveBusToken).toHaveBeenCalledWith('nope');
    expect(bot.busRoster).not.toHaveBeenCalled();
  });

  it('answers 401 with a body the plugin can read as a sentence', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    const answer = await refusal(controller.call('list', {}, request({ auth: 'Bearer nope' })));

    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ error: expect.stringMatching(/token/i) });
  });

  it('answers the roster for the caller the token names', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    const body = await controller.call('list', {}, request({ auth: 'Bearer good' }));

    expect(bot.busRoster).toHaveBeenCalledWith('sigil');
    expect(body).toEqual({ bots: [] });
  });

  it('reads only to, text and kind from a send', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    const body = await controller.call(
      'send',
      {
        to: 'loom',
        text: 'name it',
        kind: 'assign',
        // A caller's own bookkeeping must never reach the service.
        entryId: 'entry-1',
        deliveryId: 'forged',
        status: 'done',
        attachments: ['/etc/passwd'],
      },
      request({ auth: 'Bearer good' }),
    );

    expect(bot.busSend).toHaveBeenCalledWith('sigil', {
      to: 'loom',
      text: 'name it',
      kind: 'assign',
    });
    expect(body).toEqual({
      deliveryId: 'delivery-1',
      conversationId: 'dm:sigil:loom',
      queued: true,
    });
  });

  it('leaves kind out when the body has none, so the service defaults it', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    await controller.call('send', { to: 'loom', text: 'hi' }, request({ auth: 'Bearer good' }));

    expect(bot.busSend).toHaveBeenCalledWith('sigil', { to: 'loom', text: 'hi' });
  });

  it('answers the humans for the caller the token names', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    const body = await controller.call('human-list', {}, request({ auth: 'Bearer good' }));

    expect(bot.busHumanRoster).toHaveBeenCalledWith();
    expect(body).toEqual({ humans: [] });
  });

  it('reads only to, text and conversationId from a human send', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    const body = await controller.call(
      'human-send',
      {
        to: 'u-ada',
        text: 'done',
        conversationId: 'dm__u-ada__sigil',
        status: 'done',
      },
      request({ auth: 'Bearer good' }),
    );

    expect(bot.busSendToHuman).toHaveBeenCalledWith('sigil', {
      to: 'u-ada',
      text: 'done',
      conversationId: 'dm__u-ada__sigil',
    });
    expect(body).toEqual({
      deliveryId: 'entry-9',
      conversationId: 'dm__u-ada__sigil',
      queued: true,
    });
  });

  it('leaves conversationId out when the body has none, so the service DMs', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    await controller.call('human-send', { to: 'u-ada', text: 'hi' }, request({ auth: 'Bearer good' }));

    expect(bot.busSendToHuman).toHaveBeenCalledWith('sigil', { to: 'u-ada', text: 'hi' });
  });

  it('returns a tool error instead of throwing when a human send is refused', async () => {
    const bot = fakeBot();
    bot.busSendToHuman.mockRejectedValue(new BotBusError('unknown human "nobody"'));
    const controller = new BotBusController(bot);

    const body = await controller.call(
      'human-send',
      { to: 'nobody', text: 'x' },
      request({ auth: 'Bearer good' }),
    );

    expect(body).toEqual({ error: 'unknown human "nobody"' });
  });

  it('refuses a human send whose fields are not what human_send accepts', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    const answer = await refusal(
      controller.call(
        'human-send',
        { to: 'u-ada', text: 'x', conversationId: 7 },
        request({ auth: 'Bearer good' }),
      ),
    );

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: expect.stringMatching(/human send/i) });
    expect(bot.busSendToHuman).not.toHaveBeenCalled();
  });

  it('returns a tool error instead of throwing when the bus refuses', async () => {
    const bot = fakeBot();
    bot.busSend.mockRejectedValue(new BotBusError('a bot cannot send to itself'));
    const controller = new BotBusController(bot);

    const body = await controller.call(
      'send',
      { to: 'sigil', text: 'x' },
      request({ auth: 'Bearer good' }),
    );

    expect(body).toEqual({ error: 'a bot cannot send to itself' });
  });

  it('logs an unexpected failure and answers one readable sentence with 500', async () => {
    const bot = fakeBot();
    bot.busSend.mockRejectedValue(new Error('registry write failed'));
    const logger = { ...silentLogger, error: vi.fn() };
    const controller = new BotBusController(bot, logger);

    const answer = await refusal(
      controller.call('send', { to: 'loom', text: 'x' }, request({ auth: 'Bearer good' })),
    );

    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({ error: 'Morse could not handle that request.' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('refuses a send whose fields are not what bot_send accepts', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    const answer = await refusal(
      controller.call(
        'send',
        { to: 'loom', text: 'x', kind: 'shout' },
        request({ auth: 'Bearer good' }),
      ),
    );

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: expect.stringMatching(/kind/) });
    expect(bot.busSend).not.toHaveBeenCalled();
  });

  it('404s a tool it does not serve', async () => {
    const bot = fakeBot();
    const controller = new BotBusController(bot);

    const answer = await refusal(controller.call('ask', {}, request({ auth: 'Bearer good' })));

    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ error: expect.stringMatching(/ask/) });
    expect(bot.busSend).not.toHaveBeenCalled();
    expect(bot.busRoster).not.toHaveBeenCalled();
    expect(bot.busHumanRoster).not.toHaveBeenCalled();
    expect(bot.busSendToHuman).not.toHaveBeenCalled();
  });

  it('answers 503 when this host has no bot mode', async () => {
    const controller = new BotBusController(undefined);

    const answer = await refusal(controller.call('list', {}, request({ auth: 'Bearer good' })));

    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: 'Bot mode is not available on this host.' });
  });
});
