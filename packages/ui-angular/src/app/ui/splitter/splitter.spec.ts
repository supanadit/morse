import { Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutState } from '../../state/layout-state';
import { Splitter } from './splitter';

@Component({
  selector: 'morse-splitter-host',
  imports: [Splitter],
  template: `
    <div class="box">
      <div
        class="handle"
        [morseSplitter]="'explorer'"
        edge="top"
        [min]="140"
        [max]="400"
        label="Resize the explorer"
      ></div>
    </div>
  `,
})
class Host {}

/** jsdom has no `PointerEvent`; a `MouseEvent` carries everything these handlers read. */
function press(element: Element, type: string, init: MouseEventInit = {}): void {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

function render(): { host: HTMLElement; fixture: ComponentFixture<Host>; handle: HTMLElement } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return { host, fixture, handle: host.querySelector('.handle') as HTMLElement };
}

/** Frames the drag queued, painted when the test chooses — never on a clock. */
let painted: Array<() => void>;
const frame = async (): Promise<void> => {
  while (painted.length > 0) {
    painted.shift()!();
    await Promise.resolve();
  }
};

/**
 * One resize handle, whatever it resizes: the gesture is the directive's, and the size it
 * lands in is the layout's — never the pane's own template.
 */
describe('Splitter', () => {
  // The drag under test coalesces its moves with requestAnimationFrame; a leaked
  // fake-timer install once stalled a wait on it for 5 s. The frames now come from
  // a queue this spec paints itself, so the real clock decides nothing here.
  beforeEach(() => {
    localStorage.clear();
    painted = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: (now: number) => void) => painted.push(() => callback(0)),
    );
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  it('drags the size it is given, through the layout, within its own range', async () => {
    const { handle } = render();
    const layout = TestBed.inject(LayoutState);
    // jsdom measures nothing, so the drag starts from the size the layout already holds.
    layout.setSize('explorer', 300);

    press(handle, 'pointerdown', { clientY: 200 });
    press(handle, 'pointermove', { clientY: 140 });
    // The hand is on the pane's top edge, so dragging up grows it.
    expect(layout.explorerSize()).toBe(360);

    // The first move paints at once; the rest wait for the frame they share.
    press(handle, 'pointermove', { clientY: 1_000 });
    expect(layout.explorerSize()).toBe(360);
    await frame();
    expect(layout.explorerSize()).toBe(140);

    press(handle, 'pointerup');
    // Released: a later move must not reach the pane that was being sized.
    press(handle, 'pointermove', { clientY: 10 });
    // The first move after a release paints at once again.
    expect(layout.explorerSize()).toBe(140);
  });

  it('goes back to the default size on a double-click', () => {
    const { handle } = render();
    const layout = TestBed.inject(LayoutState);
    layout.setSize('explorer', 400);
    expect(localStorage.getItem('morse.explorer.height')).toBe('400');

    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(layout.explorerSize()).toBeUndefined();
    expect(localStorage.getItem('morse.explorer.height')).toBeNull();
  });

  it('says what it resizes, so a screen reader can name the separator', () => {
    const { handle } = render();

    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    expect(handle.getAttribute('aria-label')).toBe('Resize the explorer');
  });
});