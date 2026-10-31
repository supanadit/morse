import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '@morse/system';
import { OpenCodeEventStream, type OpenCodeEvent } from './event-stream.js';

/**
 * One stream per engine, routed by session, is what lets several OpenCode
 * sessions stream at once without each owning a connection. These tests use a
 * real local SSE server: framing (comments, multi-line data), routing by
 * `sessionID`, reconnection after the response ends, and the fatal report after
 * the server stays down.
 */

const PASSWORD = 'stream-password';
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

interface FakeSseServer {
  url: string;
  /** Push a raw SSE frame to the open response(s). */
  send: (payload: unknown, sessionID?: string) => void;
  /** Push a raw line (comments, multi-line data) for framing tests. */
  raw: (text: string) => void;
  /** End the current response, forcing the client to reconnect. */
  disconnect: () => void;
  /** Stop answering new connections at all. */
  stop: () => Promise<void>;
  connections: () => number;
}

async function startSseServer(): Promise<FakeSseServer> {
  let connections = 0;
  const responses = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.headers.authorization !== AUTH) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (!request.url?.startsWith('/api/event')) {
      response.writeHead(404);
      response.end();
      return;
    }
    connections += 1;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write('data: {"type":"server.connected","data":{}}\n\n');
    response.write(': heartbeat\n\n');
    responses.add(response);
    request.on('close', () => responses.delete(response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    send(payload, sessionID) {
      const frame = {
        id: `evt_${connections}`,
        created: Date.now(),
        type: (payload as { type: string }).type,
        data: { ...(payload as { data?: object }).data, ...(sessionID ? { sessionID } : {}) },
      };
      for (const response of responses) {
        response.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
    },
    raw(text) {
      for (const response of responses) {
        response.write(text);
      }
    },
    disconnect() {
      for (const response of responses) {
        response.end();
      }
      responses.clear();
    },
    async stop() {
      for (const response of responses) {
        response.destroy();
      }
      responses.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    connections: () => connections,
  };
}

/** Waits until `predicate` holds, so tests never race the network. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('OpenCodeEventStream', () => {
  let server: FakeSseServer | undefined;
  let stream: OpenCodeEventStream | undefined;

  beforeEach(async () => {
    server = await startSseServer();
  });

  afterEach(async () => {
    await stream?.close();
    stream = undefined;
    await server?.stop();
    server = undefined;
  });

  function build(options: { fatalAfter?: number; reconnectBaseMs?: number } = {}): OpenCodeEventStream {
    return new OpenCodeEventStream(
      { baseUrl: server!.url, password: PASSWORD },
      {
        logger: silentLogger,
        reconnectBaseMs: options.reconnectBaseMs ?? 10,
        reconnectMaxMs: 50,
        fatalAfter: options.fatalAfter ?? 3,
      },
    );
  }

  it('routes each session\'s events to its own subscribers and ignores non-session events', async () => {
    stream = build();
    const a: OpenCodeEvent[] = [];
    const b: OpenCodeEvent[] = [];
    stream.subscribe('ses_a', (event) => a.push(event));
    stream.subscribe('ses_b', (event) => b.push(event));
    await until(() => server!.connections() === 1);

    server!.send({ type: 'session.text.delta', data: { delta: 'hello' } }, 'ses_a');
    server!.send({ type: 'session.text.delta', data: { delta: 'world' } }, 'ses_b');
    server!.send({ type: 'project.updated', data: { id: 'p1' } });
    server!.send({ type: 'session.text.ended', data: { text: 'done' } }, 'ses_unknown');

    await until(() => a.length >= 2 && b.length >= 2);
    // The first event each got is the synthetic connect notice.
    expect(a.map((event) => event.type)).toEqual(['stream.connected', 'session.text.delta']);
    expect(b.map((event) => event.type)).toEqual(['stream.connected', 'session.text.delta']);
    expect(a[1]?.data['delta']).toBe('hello');
    expect(b[1]?.data['delta']).toBe('world');
  });

  it('accepts the `properties` payload name as well as `data`', async () => {
    stream = build();
    const seen: OpenCodeEvent[] = [];
    stream.subscribe('ses_a', (event) => seen.push(event));
    await until(() => server!.connections() === 1);

    server!.raw(
      'data: {"type":"session.text.delta","properties":{"sessionID":"ses_a","delta":"old-shape"}}\n\n',
    );
    await until(() => seen.some((event) => event.type === 'session.text.delta'));
    expect(seen.find((event) => event.type === 'session.text.delta')?.data['delta']).toBe('old-shape');
  });

  it('ignores heartbeats and reassembles multi-line data', async () => {
    stream = build();
    const seen: OpenCodeEvent[] = [];
    stream.subscribe('ses_a', (event) => seen.push(event));
    await until(() => server!.connections() === 1);

    server!.raw(': heartbeat\n\n');
    server!.raw('data: {"type":"session.notice",\ndata: "data":{"sessionID":"ses_a"}}\n\n');
    await until(() => seen.some((event) => event.type === 'session.notice'));
    expect(seen.find((event) => event.type === 'session.notice')?.data['sessionID']).toBe('ses_a');
  });

  it('reconnects after the server ends the response and announces the new connection', async () => {
    stream = build();
    const seen: OpenCodeEvent[] = [];
    stream.subscribe('ses_a', (event) => seen.push(event));
    await until(() => server!.connections() === 1);

    server!.disconnect();
    await until(() => server!.connections() === 2);
    server!.send({ type: 'session.text.delta', data: { delta: 'after-reconnect' } }, 'ses_a');

    await until(() => seen.some((event) => event.type === 'session.text.delta'));
    expect(seen.filter((event) => event.type === 'stream.connected')).toHaveLength(2);
    expect(stream.connectionCount).toBe(2);
  });

  it('reports a death once to every open session after repeated failures, and recovers', async () => {
    stream = build({ fatalAfter: 2, reconnectBaseMs: 5 });
    const a: OpenCodeEvent[] = [];
    const b: OpenCodeEvent[] = [];
    stream.subscribe('ses_a', (event) => a.push(event));
    stream.subscribe('ses_b', (event) => b.push(event));
    await until(() => server!.connections() === 1);

    // Take the server away: reconnection starts failing.
    await server!.stop();
    await until(() => a.some((event) => event.type === 'stream.fatal'), 5_000);
    await until(() => b.some((event) => event.type === 'stream.fatal'), 5_000);
    expect(a.find((event) => event.type === 'stream.fatal')?.data['message']).toContain('unavailable');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A death is reported once, not once per retry.
    expect(a.filter((event) => event.type === 'stream.fatal')).toHaveLength(1);

    // Bring a server back at the same address: the stream reconnects and clears
    // the report, so a future death would be announced again.
    server = await startSseServerAt(server!.url);
    await until(() => a.filter((event) => event.type === 'stream.connected').length >= 2, 5_000);
  });
});

/** Restarts a fake SSE server on a fixed origin (for the reconnect-after-death case). */
async function startSseServerAt(url: string): Promise<FakeSseServer> {
  const port = Number(new URL(url).port);
  const responses = new Set<ServerResponse>();
  let connections = 0;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== AUTH) {
      response.writeHead(401);
      response.end();
      return;
    }
    connections += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"server.connected","data":{}}\n\n');
    responses.add(response);
    request.on('close', () => responses.delete(response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url,
    send(payload, sessionID) {
      const frame = {
        type: (payload as { type: string }).type,
        data: { ...(payload as { data?: object }).data, ...(sessionID ? { sessionID } : {}) },
      };
      for (const response of responses) {
        response.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
    },
    raw(text) {
      for (const response of responses) {
        response.write(text);
      }
    },
    disconnect() {
      for (const response of responses) {
        response.end();
      }
      responses.clear();
    },
    async stop() {
      for (const response of responses) {
        response.destroy();
      }
      responses.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    connections: () => connections,
  };
}
