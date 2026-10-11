import { describe, expect, it, vi } from 'vitest';
import { createLspFrameReader, encodeLspMessage } from './lsp-protocol.js';

/**
 * `node:child_process` is mocked so a language server is a hand-driven fake: the
 * test answers `initialize`, pushes diagnostics at will, and kills the process
 * to exercise the death paths. Nothing is spawned.
 */
const cp = vi.hoisted(() => {
  /** A tiny event target: enough for `on`/`emit`, which is all the client uses. */
  class Emitter {
    private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    on(event: string, handler: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]): boolean {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
      return (this.handlers.get(event)?.length ?? 0) > 0;
    }
  }
  class FakeStdin extends Emitter {
    destroyed = false;
    readonly writes: Buffer[] = [];
    write(chunk: Buffer): boolean {
      this.writes.push(chunk);
      return true;
    }
  }
  class FakeStdout extends Emitter {}
  class FakeStderr extends Emitter {}

  class FakeChild extends Emitter {
    exitCode: number | null = null;
    readonly stdin = new FakeStdin();
    readonly stdout = new FakeStdout();
    readonly stderr = new FakeStderr();
    killed = false;
    kill(): void {
      this.killed = true;
      this.exitCode = 0;
    }
  }

  const children: FakeChild[] = [];
  return {
    FakeChild,
    children,
    spawn: (): FakeChild => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  };
});

vi.mock('node:child_process', () => ({ spawn: cp.spawn }));

import { LspClient, MAX_OPEN_DOCUMENTS } from './lsp-client.js';

type Sent = { method?: string; params?: { textDocument?: { uri?: string } } };

/** Every JSON-RPC message a fake child has written, parsed. */
function sent(child: InstanceType<typeof cp.FakeChild>): Sent[] {
  const messages: Sent[] = [];
  const read = createLspFrameReader((message) => messages.push(message as Sent));
  for (const chunk of child.stdin.writes) {
    read(chunk);
  }
  return messages;
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const options = {
  command: 'fake-ls',
  args: [],
  cwd: '/tmp/project',
  label: 'fake language server',
  logger: logger as never,
  initTimeoutMs: 500,
  requestTimeoutMs: 500,
};

/** Starts a client and answers its `initialize`, so it is ready to talk. */
async function started(): Promise<{ client: LspClient; child: InstanceType<typeof cp.FakeChild> }> {
  const pending = LspClient.start(options);
  await Promise.resolve();
  const child = cp.children.at(-1)!;
  const init = sent(child).find((message) => message.method === 'initialize');
  const id = (init as unknown as { id: number } | undefined)?.id;
  child.stdout.emit('data', encodeLspMessage({ jsonrpc: '2.0', id, result: {} }));
  const client = await pending;
  expect(client).toBeDefined();
  return { client: client!, child };
}

describe('LspClient document cap', () => {
  it('keeps at most the cap open and closes the least recently used', async () => {
    const { client, child } = await started();
    for (let i = 0; i < MAX_OPEN_DOCUMENTS + 5; i += 1) {
      client.open(`/tmp/project/f${i}.ts`, 'typescript', `const x${i} = ${i};`);
    }
    const all = sent(child);
    const opened = all.filter((message) => message.method === 'textDocument/didOpen');
    const closed = all.filter((message) => message.method === 'textDocument/didClose');
    expect(opened).toHaveLength(MAX_OPEN_DOCUMENTS + 5);
    // Five didOpen calls past the cap evicted exactly five documents.
    expect(closed).toHaveLength(5);
    expect(closed[0]?.params?.textDocument?.uri).toContain('f0.ts');
    client.dispose();
  });

  it('drops the diagnostics of an evicted document', async () => {
    const { client, child } = await started();
    const first = '/tmp/project/first.ts';
    client.open(first, 'typescript', 'const a = 1;');
    const opened = sent(child).find((message) => message.method === 'textDocument/didOpen');
    const firstUri = opened!.params!.textDocument!.uri!;
    child.stdout.emit(
      'data',
      encodeLspMessage({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: firstUri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              message: 'x',
              severity: 1,
            },
          ],
        },
      }),
    );
    // Fill past the cap so `first` is evicted.
    for (let i = 0; i < MAX_OPEN_DOCUMENTS; i += 1) {
      client.open(`/tmp/project/f${i}.ts`, 'typescript', 'const y = 1;');
    }
    expect(client.diagnosticsFor(firstUri)).toEqual([]);
    client.dispose();
  });
});

describe('LspClient death', () => {
  it('notifies onExit listeners once when the process exits', async () => {
    const { client, child } = await started();
    let exits = 0;
    client.onExit(() => {
      exits += 1;
    });
    child.emit('exit', 1, null);
    child.emit('exit', 1, null);
    expect(exits).toBe(1);
    expect(client.alive).toBe(false);
  });

  it('calls an onExit listener immediately when already dead', async () => {
    const { client, child } = await started();
    child.emit('exit', 0, null);
    let called = false;
    client.onExit(() => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
