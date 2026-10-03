import { afterEach, describe, expect, it } from 'vitest';
import { AgentProtocolError } from '@morse/core';
import { PiRpcClient } from './rpc-client.js';

/**
 * Compaction is the one request whose duration is model-bound: summarizing the
 * whole context takes seconds to minutes, so it must be able to pass its own
 * timeout instead of riding the 30 s default that made slow setups look like a
 * hung `pi`.
 */

function childClient(options: {
  /** Constructor default for every request that does not override it. */
  requestTimeoutMs?: number;
  script: string;
}): PiRpcClient {
  const client = new PiRpcClient({
    command: process.execPath,
    args: ['-e', options.script],
    cwd: process.cwd(),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    onRecord: () => undefined,
  });
  client.start();
  return client;
}

/** Answers the first request after `delayMs`, then exits silently. */
function answeringScript(delayMs: number, success = true): string {
  const response = JSON.stringify(
    success
      ? { type: 'response', id: 'morse-1', success: true, data: { ok: 1 } }
      : { type: 'response', id: 'morse-1', success: false, error: 'boom' },
  );
  return `setTimeout(() => { process.stdout.write(${JSON.stringify(response)} + '\\n'); }, ${delayMs});\n`;
}

describe('PiRpcClient request timeouts', () => {
  let client: PiRpcClient | undefined;

  afterEach(async () => {
    if (client) {
      await client.dispose();
      client = undefined;
    }
  });

  it('the per-request override outruns the constructor default', async () => {
    client = childClient({
      requestTimeoutMs: 150,
      script: answeringScript(400),
    });
    // The child answers at 400 ms: the default (150 ms) would reject, the
    // override keeps the request alive long enough to receive it.
    const data = await client.request({ type: 'compact' }, 2_000);
    expect(data).toEqual({ ok: 1 });
  });

  it('an unanswered request still rejects under the override', async () => {
    client = childClient({ script: answeringScript(3_000) });
    await expect(client.request({ type: 'compact' }, 120)).rejects.toMatchObject({
      message: 'pi did not answer "compact" within 120 ms.',
    });
  });

  it('a compact rejection surfaces as the pi-rejected error', async () => {
    client = childClient({ script: answeringScript(0, false) });
    await expect(client.request({ type: 'compact' }, 2_000)).rejects.toBeInstanceOf(
      AgentProtocolError,
    );
  });
});