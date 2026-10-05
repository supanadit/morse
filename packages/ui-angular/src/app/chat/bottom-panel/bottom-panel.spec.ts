import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The panel mounts the real TerminalView, which builds xterm emulators; jsdom has
// no layout or canvas, so the emulator is mocked here (see terminal.spec.ts).
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    open(): void {}
    loadAddon(): void {}
    onData() {
      return { dispose: () => undefined };
    }
    onResize() {
      return { dispose: () => undefined };
    }
    write(): void {}
    reset(): void {}
    focus(): void {}
    dispose(): void {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  },
}));

import { signal } from '@angular/core';
import { MorseService } from '../../core/morse.service';
import { PanelState } from '../../core/panel-state';
import { BottomPanel } from './bottom-panel';

/** The terminal view needs a host that exists (for the session key) and talks. */
function morseStub() {
  return {
    state: signal({ sessionId: 's1' as string | undefined, workspace: { cwd: '/w', name: 'w' } }),
    activateSession: vi.fn(),
    newSession: vi.fn(),
    requestHostCommand: vi.fn(() => Promise.resolve(undefined)),
    openTerminal: vi.fn(),
    sendTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    onTerminalOutput: () => () => undefined,
    onTerminalExit: () => () => undefined,
  };
}

function setup(): { fixture: ComponentFixture<BottomPanel>; host: HTMLElement } {
  TestBed.configureTestingModule({
    imports: [BottomPanel],
    providers: [{ provide: MorseService, useValue: morseStub() }],
  });
  const fixture = TestBed.createComponent(BottomPanel);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

describe('BottomPanel', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('starts folded to its chip row', () => {
    const { host } = setup();

    const chips = [...host.querySelectorAll('.chip')].map((chip) => chip.textContent?.trim());
    expect(chips).toEqual(['Terminal']);
    expect(host.querySelector('.panel')?.classList.contains('expanded')).toBe(false);
  });

  it('opens the chip and folds it again without killing the tool', async () => {
    const { fixture, host } = setup();

    (host.querySelector('.chip-label') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(host.querySelector('.panel')?.classList.contains('expanded')).toBe(true);
    expect(host.querySelector('morse-terminal-view')).not.toBeNull();

    (host.querySelector('.chip-label') as HTMLElement).click();
    fixture.detectChanges();

    expect(host.querySelector('.panel')?.classList.contains('expanded')).toBe(false);
    // Folded, the body is hidden but the tool stays mounted (its shells live).
    expect(host.querySelector('.body')?.classList.contains('hidden')).toBe(true);
    expect(host.querySelector('morse-terminal-view')).not.toBeNull();
  });

  it('renders the tool action next to its chip and opens a terminal', async () => {
    const { fixture, host } = setup();
    (host.querySelector('.chip-label') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();

    // "Terminal +": the action sits with the chip, not on its own row.
    const action = host.querySelector('.chips .chip-action') as HTMLButtonElement;
    expect(action?.textContent?.trim()).toBe('+');
    expect(host.querySelectorAll('.ttab')).toHaveLength(0);

    action.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(host.querySelectorAll('.ttab')).toHaveLength(1);
  });

  it('grows to the height the reader dragged', async () => {
    const { fixture, host } = setup();
    TestBed.inject(PanelState).setHeight(340);

    (host.querySelector('.chip-label') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect((host.querySelector('.panel') as HTMLElement).style.height).toBe('340px');
  });
});
