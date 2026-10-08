import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The panel mounts the real TerminalView, which builds xterm emulators; jsdom has
// no layout or canvas, so the emulator is mocked here (see terminal.spec.ts). The
// mocks carry the production shape — the CJS module under `default`.
vi.mock('@xterm/xterm', () => ({
  default: {
    Terminal: class {
      cols = 80;
      rows = 24;
      readonly parser = { registerOscHandler: () => ({ dispose: () => undefined }) };
      open(): void {}
      loadAddon(): void {}
      registerLinkProvider() {
        return { dispose: () => undefined };
      }
      onData() {
        return { dispose: () => undefined };
      }
      onResize() {
        return { dispose: () => undefined };
      }
      onTitleChange() {
        return { dispose: () => undefined };
      }
      write(): void {}
      reset(): void {}
      focus(): void {}
      dispose(): void {}
    },
  },
}));
vi.mock('@xterm/addon-fit', () => ({ default: { FitAddon: class { fit(): void {} } } }));
vi.mock('@xterm/addon-webgl', () => ({
  default: {
    WebglAddon: class {
      onContextLoss(): void {}
      dispose(): void {}
    },
  },
}));

import { signal } from '@angular/core';
import { MorseService } from '../../../host/morse.service';
import { PANEL_DEFAULT_HEIGHT, PanelState } from '../../../state/panel-state';
import { BottomPanel } from './bottom-panel';

/** Dispatch a pointer-like event on a handle (jsdom has no PointerEvent). */
function press(element: Element, type: string, clientY = 0): void {
  element.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY }),
  );
}

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
    hostEpoch: signal(0),
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

  it('hides without unmounting when told to, so a running shell survives', async () => {
    const { fixture, host } = setup();
    (host.querySelector('.chip-label') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelector('morse-terminal-view')).not.toBeNull();

    // Hiding is a class, not an unmount: an unmounted terminal would close its
    // host-owned shell (see `bottomPanelEnabled` in `app.ts`).
    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();

    expect(host.classList.contains('host-hidden')).toBe(true);
    expect(host.querySelector('morse-terminal-view')).not.toBeNull();

    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();

    expect(host.classList.contains('host-hidden')).toBe(false);
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

  it('reaches the top-edge handle and follows the drag', async () => {
    const { fixture, host } = setup();
    (host.querySelector('.chip-label') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();

    const handle = host.querySelector('.resize') as HTMLElement;
    expect(handle.getAttribute('aria-label')).toBe('Resize the bottom panel');

    // Pulling up from the handle grows the panel (260 default + 80).
    press(handle, 'pointerdown', 400);
    press(handle, 'pointermove', 320);
    press(handle, 'pointerup', 320);
    fixture.detectChanges();

    expect(TestBed.inject(PanelState).height()).toBe(340);
    expect((host.querySelector('.panel') as HTMLElement).style.height).toBe('340px');
  });

  it('restores the default height when the handle is double-clicked', async () => {
    const { fixture, host } = setup();
    TestBed.inject(PanelState).setHeight(340);
    (host.querySelector('.chip-label') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();

    press(host.querySelector('.resize') as HTMLElement, 'dblclick');
    fixture.detectChanges();

    expect(TestBed.inject(PanelState).height()).toBeUndefined();
    expect((host.querySelector('.panel') as HTMLElement).style.height).toBe(
      `${PANEL_DEFAULT_HEIGHT}px`,
    );
  });

  it('hands the panel the whole column in full screen, and gives it back', async () => {
    const { fixture, host } = setup();
    (host.querySelector('.toggle[aria-label="Full screen"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();

    const panel = TestBed.inject(PanelState);
    // Going full opens the tool too, so the space is not handed to an empty panel.
    expect(panel.expanded()).toBe(true);
    expect(panel.full()).toBe(true);
    expect(host.classList.contains('full')).toBe(true);
    // No inline height and no drag handle: the flex column sizes it now.
    expect((host.querySelector('.panel') as HTMLElement).style.height).toBe('');
    expect(host.querySelector('.resize')).toBeNull();

    (host.querySelector('.toggle[aria-label="Exit full screen"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(panel.full()).toBe(false);
    expect(host.classList.contains('full')).toBe(false);
    expect(host.querySelector('.resize')).not.toBeNull();
  });
});
