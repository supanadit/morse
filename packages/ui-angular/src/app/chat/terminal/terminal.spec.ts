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
  const instances: Array<{
    cols: number;
    rows: number;
    writes: string[];
    dataHandler?: DataHandler;
    resizeHandler?: ResizeHandler;
  }> = [];
  class FakeTerminal {
    cols = 100;
    rows = 30;
    writes: string[] = [];
    dataHandler: DataHandler | undefined;
    resizeHandler: ResizeHandler | undefined;
    constructor() {
      instances.push(this);
    }
    open(): void {}
    loadAddon(): void {}
    onData(handler: DataHandler) {
      this.dataHandler = handler;
      return { dispose: () => undefined };
    }
    onResize(handler: ResizeHandler) {
      this.resizeHandler = handler;
      return { dispose: () => undefined };
    }
    write(data: string): void {
      this.writes.push(data);
    }
    reset(): void {}
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

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xterm.FakeFitAddon }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: xterm.FakeWebglAddon }));

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

  it('closes the shell when the terminal goes away', async () => {
    const { fixture, morse } = setup();
    await fixture.whenStable();
    await tick();
    const id = morse.openTerminal.mock.calls[0]?.[0] as string;

    fixture.destroy();

    expect(morse.closeTerminal).toHaveBeenCalledWith(id);
  });
});
