import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * node-pty is a native module, so the shell is a hand-driven fake here: the test
 * writes output at will and can make a `kill` print the shutdown lines a dev
 * server emits as it stops.
 */
const pty = vi.hoisted(() => {
  type DataHandler = (data: string) => void;
  type ExitHandler = (event: { exitCode: number }) => void;
  class FakePty {
    pid = 4321;
    private readonly dataHandlers: DataHandler[] = [];
    private readonly exitHandlers: ExitHandler[] = [];
    /** Runs on the first `kill`, before the buffer is frozen. */
    onKill: (() => void) | undefined;
    private killed = false;
    onData(handler: DataHandler) {
      this.dataHandlers.push(handler);
      return { dispose: () => undefined };
    }
    onExit(handler: ExitHandler) {
      this.exitHandlers.push(handler);
      return { dispose: () => undefined };
    }
    write(): void {}
    resize(): void {}
    kill(): void {
      if (this.killed) {
        return;
      }
      this.killed = true;
      this.onKill?.();
    }
    emit(data: string): void {
      for (const handler of this.dataHandlers) {
        handler(data);
      }
    }
    exit(code = 0): void {
      for (const handler of this.exitHandlers) {
        handler({ exitCode: code });
      }
    }
  }
  const spawned: FakePty[] = [];
  return {
    FakePty,
    spawned,
    spawn: (): FakePty => {
      const shell = new FakePty();
      spawned.push(shell);
      return shell;
    },
  };
});

vi.mock('node-pty', () => ({ spawn: pty.spawn }));

import { ServerTerminalBackend } from './terminal.service.js';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const OPTIONS = { cwd: '/tmp', cols: 80, rows: 24 };

describe('ServerTerminalBackend', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'morse-terminal-'));
    pty.spawned.length = 0;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function backend(allowed = true): ServerTerminalBackend {
    return new ServerTerminalBackend(
      { canOpen: () => allowed } as never,
      logger as never,
      { dataDir, terminalIdleMs: 0 } as never,
    );
  }

  function log(terminalId: string): string {
    try {
      return readFileSync(join(dataDir, 'terminals', `${terminalId}.log`), 'utf8');
    } catch {
      return '';
    }
  }

  it('replays a scrollback a later host reads from disk', async () => {
    const first = backend();
    first.attach('term-1', OPTIONS, { output: () => undefined, exit: () => undefined });
    pty.spawned.at(-1)!.emit('earlier output\r\n');
    await first.onModuleDestroy();

    const second = backend();
    const session = second.attach('term-1', OPTIONS, {
      output: () => undefined,
      exit: () => undefined,
    });

    expect(session.replay).toContain('earlier output');
    await second.onModuleDestroy();
  });

  it("keeps the shell's shutdown log, which it prints only after the signal", async () => {
    const host = backend();
    host.attach('term-1', OPTIONS, { output: () => undefined, exit: () => undefined });
    const shell = pty.spawned.at(-1)!;
    shell.emit('running\r\n');
    // A dev server prints this as it stops — after SIGTERM, before the host is
    // done. Persisting before the kill would drop exactly these lines.
    shell.onKill = () => shell.emit('Worker events consumer stopped\r\n');

    await host.onModuleDestroy();

    expect(log('term-1')).toContain('running');
    expect(log('term-1')).toContain('Worker events consumer stopped');
  });

  it('forgets the scrollback when the reader closes the terminal', () => {
    const host = backend();
    host.attach('term-1', OPTIONS, { output: () => undefined, exit: () => undefined });
    pty.spawned.at(-1)!.emit('bye\r\n');

    host.close('term-1');

    expect(log('term-1')).toBe('');
  });

  it('refuses a directory the project policy blocks, and spawns nothing', () => {
    const host = backend(false);

    expect(() =>
      host.attach('term-1', { ...OPTIONS, cwd: '/etc' }, {
        output: () => undefined,
        exit: () => undefined,
      }),
    ).toThrow(/not allowed/);
    expect(pty.spawned).toHaveLength(0);
  });
});
