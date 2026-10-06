import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * xterm.js needs real layout measurement and a canvas/GPU, neither of which a
 * jsdom suite has. The emulator is mocked so the test can drive its callbacks
 * (keystrokes, resize) and read what the component writes; the real terminal is
 * exercised by running the browser host.
 */
const xterm = vi.hoisted(() => {
  type DataHandler = (data: string) => void;
  type ResizeHandler = (size: { cols: number; rows: number }) => void;
  type TitleHandler = (title: string) => void;
  const instances: Array<{
    cols: number;
    rows: number;
    writes: string[];
    resets: number;
    dataHandler?: DataHandler;
    resizeHandler?: ResizeHandler;
    titleHandler?: TitleHandler;
    oscHandlers: Map<number, (data: string) => boolean>;
  }> = [];
  class FakeTerminal {
    cols = 100;
    rows = 30;
    writes: string[] = [];
    resets = 0;
    dataHandler: DataHandler | undefined;
    resizeHandler: ResizeHandler | undefined;
    titleHandler: TitleHandler | undefined;
    readonly oscHandlers = new Map<number, (data: string) => boolean>();
    readonly parser = {
      registerOscHandler: (ident: number, handler: (data: string) => boolean) => {
        this.oscHandlers.set(ident, handler);
        return { dispose: () => this.oscHandlers.delete(ident) };
      },
    };
    constructor() {
      instances.push(this);
    }
    open(): void {}
    loadAddon(): void {}
    registerLinkProvider(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    onData(handler: DataHandler) {
      this.dataHandler = handler;
      return { dispose: () => undefined };
    }
    onResize(handler: ResizeHandler) {
      this.resizeHandler = handler;
      return { dispose: () => undefined };
    }
    onTitleChange(handler: TitleHandler) {
      this.titleHandler = handler;
      return { dispose: () => undefined };
    }
    write(data: string): void {
      this.writes.push(data);
    }
    reset(): void {
      this.resets += 1;
    }
    focus(): void {}
    dispose(): void {}
  }
  class FakeFitAddon {
    fit(): void {}
  }
  class FakeWebglAddon {
    onContextLoss(): void {}
    dispose(): void {}
  }
  return { instances, FakeTerminal, FakeFitAddon, FakeWebglAddon };
});

// xterm ships CommonJS: a production bundle's lazy chunk exports the module as
// `default`, which is exactly what these mocks reproduce (see `importCjs`).
vi.mock('@xterm/xterm', () => ({ default: { Terminal: xterm.FakeTerminal } }));
vi.mock('@xterm/addon-fit', () => ({ default: { FitAddon: xterm.FakeFitAddon } }));
vi.mock('@xterm/addon-webgl', () => ({ default: { WebglAddon: xterm.FakeWebglAddon } }));

import { MorseService } from '../../core/morse.service';
import { Terminal } from './terminal';

function setup() {
  xterm.instances.length = 0;
  const outputListeners = new Set<(event: { terminalId: string; data: string }) => void>();
  const exitListeners = new Set<
    (event: { terminalId: string; code?: number; error?: string }) => void
  >();
  const morse = {
    openTerminal: vi.fn(),
    sendTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    hostEpoch: signal(0),
    onTerminalOutput: (listener: (event: { terminalId: string; data: string }) => void) => {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    onTerminalExit: (
      listener: (event: { terminalId: string; code?: number; error?: string }) => void,
    ) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
  TestBed.configureTestingModule({
    imports: [Terminal],
    providers: [{ provide: MorseService, useValue: morse }],
  });
  const fixture = TestBed.createComponent(Terminal);
  fixture.componentRef.setInput('id', 'term-1');
  fixture.detectChanges();
  return {
    fixture,
    morse,
    emitOutput: (event: { terminalId: string; data: string }) => {
      for (const listener of [...outputListeners]) {
        listener(event);
      }
    },
    emitExit: (event: { terminalId: string; code?: number; error?: string }) => {
      for (const listener of [...exitListeners]) {
        listener(event);
      }
    },
  };
}

/** The emulator is imported lazily; one tick lets that import resolve. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Terminal', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('opens a PTY sized to the emulator', async () => {
    const { fixture, morse } = setup();
    await fixture.whenStable();
    await tick();
    const id = morse.openTerminal.mock.calls[0]?.[0] as string;

    expect(typeof id).toBe('string');
    expect(morse.openTerminal).toHaveBeenCalledWith(id, { cols: 100, rows: 30 });
  });

  it('writes the host stream into the emulator untouched', async () => {
    const { fixture, morse, emitOutput } = setup();
    await fixture.whenStable();
    await tick();
    const id = morse.openTerminal.mock.calls[0]?.[0] as string;

    emitOutput({ terminalId: id, data: '\u001b[32mgreen\u001b[0m\r\n' });

    expect(xterm.instances.at(-1)?.writes).toContain('\u001b[32mgreen\u001b[0m\r\n');
  });

  it('re-attaches to a new host after a reconnect', async () => {
    const { fixture, morse, emitOutput } = setup();
    await fixture.whenStable();
    await tick();
    expect(morse.openTerminal).toHaveBeenCalledTimes(1);
    const term = xterm.instances.at(-1)!;

    // The host was replaced (a restart or a reconnect): the same socket is gone,
    // so the pane must clear the stale buffer and attach to the new host, or the
    // shell there never hears a keystroke.
    morse.hostEpoch.set(1);
    fixture.detectChanges();
    await fixture.whenStable();
    await tick();

    expect(term.resets).toBe(1);
    expect(morse.openTerminal).toHaveBeenCalledTimes(2);

    // The new host replays the scrollback it kept on disk. That is what makes a
    // `morse stop`/`start` land on the old output instead of a blank terminal.
    const id = morse.openTerminal.mock.calls[1]?.[0] as string;
    emitOutput({ terminalId: id, data: 'replayed after restart\r\n' });
    expect(term.writes).toContain('replayed after restart\r\n');
  });

  it('forwards raw keystrokes and resizes to the host', async () => {
    const { fixture, morse } = setup();
    await fixture.whenStable();
    await tick();
    const id = morse.openTerminal.mock.calls[0]?.[0] as string;
    const term = xterm.instances.at(-1)!;

    term.dataHandler?.('x');
    term.resizeHandler?.({ cols: 120, rows: 40 });

    expect(morse.sendTerminal).toHaveBeenCalledWith(id, 'x');
    expect(morse.resizeTerminal).toHaveBeenCalledWith(id, 120, 40);
  });

  it('forwards the shell title to the tab', async () => {
    const { fixture } = setup();
    await fixture.whenStable();
    await tick();
    const titles: string[] = [];
    fixture.componentInstance.titleChange.subscribe((title) => titles.push(title));

    xterm.instances.at(-1)?.titleHandler?.('npm run dev');

    expect(titles).toEqual(['npm run dev']);
  });

  it('reports the shell directory from OSC 7', async () => {
    const { fixture } = setup();
    await fixture.whenStable();
    await tick();
    const dirs: string[] = [];
    fixture.componentInstance.cwdChange.subscribe((cwd) => dirs.push(cwd));
    const osc = xterm.instances.at(-1)?.oscHandlers.get(7);

    osc?.('file://host/home/me/project%20a');
    // Not a file URL: not a directory.
    osc?.('https://example.com/x');

    expect(dirs).toEqual(['/home/me/project a']);
  });

  it('flushes output that arrived before the emulator was ready', async () => {
    const { fixture, emitOutput } = setup();
    // The lazy xterm import has not resolved yet, so the host's first flush (a
    // restart replay) has no emulator to write into. The pane's id is `term-1`.
    emitOutput({ terminalId: 'other', data: 'not mine' });
    emitOutput({ terminalId: 'term-1', data: 'the replay' });

    await fixture.whenStable();
    await tick();

    expect(xterm.instances.at(-1)?.writes).toContain('the replay');
    expect(xterm.instances.at(-1)?.writes).not.toContain('not mine');
  });

  it('offers a restart once the shell has ended', async () => {
    const { fixture, morse, emitExit } = setup();
    await fixture.whenStable();
    await tick();
    const id = morse.openTerminal.mock.calls[0]?.[0] as string;

    emitExit({ terminalId: id, code: 0 });
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const restart = host.querySelector('.restart') as HTMLButtonElement;
    expect(restart).not.toBeNull();
    restart.click();
    expect(morse.openTerminal).toHaveBeenCalledTimes(2);
  });

  it('leaves the shell running when the view goes away', async () => {
    const { fixture, morse } = setup();
    await fixture.whenStable();
    await tick();

    fixture.destroy();

    // The host owns the shell: a hidden panel, a remount or a session switch must
    // not end it, or a running command would die with the view. Only the reader
    // closing the pane/chip/session sends `terminal/close` (see `TerminalView`).
    expect(morse.closeTerminal).not.toHaveBeenCalled();
  });
});
