import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The view mounts real Terminal components, which build xterm emulators; jsdom
// has no layout or canvas, so the emulator is mocked here.
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

import { MorseService } from '../../core/morse.service';
import { TerminalStore } from '../../core/terminal-store';
import { WorkspaceTabs } from '../../core/workspace-tabs';
import { TerminalView } from './terminal-view';

type SessionState = {
  sessionId: string | undefined;
  workspace: { cwd: string; name: string };
};

function setup(): {
  fixture: ComponentFixture<TerminalView>;
  host: HTMLElement;
  state: ReturnType<typeof signal<SessionState>>;
} {
  const state = signal<SessionState>({
    sessionId: 's1',
    workspace: { cwd: '/w', name: 'w' },
  });
  const morse = {
    state,
    activateSession: vi.fn(),
    newSession: vi.fn(),
    requestHostCommand: vi.fn(() => Promise.resolve(undefined)),
    sessionActivity: signal(new Map()),
    openTerminal: vi.fn(),
    sendTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    onTerminalOutput: () => () => undefined,
    onTerminalExit: () => () => undefined,
  };
  TestBed.configureTestingModule({
    imports: [TerminalView],
    providers: [{ provide: MorseService, useValue: morse }],
  });
  const fixture = TestBed.createComponent(TerminalView);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, state };
}

/** Opens a terminal the way the panel's `+` action does. */
function open(owner = 's1'): string {
  return TestBed.inject(TerminalStore).open(owner);
}

function chips(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.ttab .label')].map((node) => node.textContent?.trim() ?? '');
}

describe('TerminalView', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('starts empty for the session in front', () => {
    const { host } = setup();
    expect(chips(host)).toEqual([]);
    expect(host.querySelector('.empty')).not.toBeNull();
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(0);
  });

  it('shows one chip per terminal and keeps them all mounted', async () => {
    const { fixture, host } = setup();

    open();
    fixture.detectChanges();
    open();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(chips(host)).toEqual(['Terminal 1', 'Terminal 2']);
    expect(host.querySelector('.ttab.active .label')?.textContent?.trim()).toBe('Terminal 2');
    // Both emulators are mounted; only the active one is shown.
    const screens = [...host.querySelectorAll('morse-terminal')] as HTMLElement[];
    expect(screens).toHaveLength(2);
    expect(screens[0]!.classList.contains('hidden')).toBe(true);
    expect(screens[1]!.classList.contains('hidden')).toBe(false);
    expect(host.querySelector('.empty')).toBeNull();
  });

  it("shows only the session's terminals, and keeps the others alive", async () => {
    const { fixture, host, state } = setup();
    open();
    fixture.detectChanges();
    await fixture.whenStable();

    // Another session in front: its own (empty) chip row, but the first
    // session's shell is still mounted and running behind the scenes.
    state.set({ sessionId: 's2', workspace: { cwd: '/other', name: 'other' } });
    fixture.detectChanges();

    expect(chips(host)).toEqual([]);
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(1);
    expect((host.querySelector('morse-terminal') as HTMLElement).classList.contains('hidden')).toBe(
      true,
    );
  });

  it('closes a terminal from its chip', async () => {
    const { fixture, host } = setup();
    open();
    fixture.detectChanges();
    await fixture.whenStable();

    (host.querySelector('.ttab .close') as HTMLElement).click();
    fixture.detectChanges();

    expect(chips(host)).toEqual([]);
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(0);
  });

  it("drops the session's terminals when its session tab is closed", async () => {
    const { fixture, host } = setup();
    open();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(1);

    // Closing the session tab is what owns the shell.
    TestBed.inject(WorkspaceTabs).focusSession({ id: 's1', title: 'One' });
    TestBed.inject(WorkspaceTabs).close('s1');
    fixture.detectChanges();

    expect(host.querySelectorAll('morse-terminal')).toHaveLength(0);
    expect(host.querySelector('.empty')).not.toBeNull();
  });
});
