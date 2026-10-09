import { Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
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

/** One animation frame: the drag coalesces its moves into one layout per paint. */
const frame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

function render(): { host: HTMLElement; fixture: ComponentFixture<Host>; handle: HTMLElement } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return { host, fixture, handle: host.querySelector('.handle') as HTMLElement };
}

/**
 * One resize handle, whatever it resizes: the gesture is the directive's, and the size it
 * lands in is the layout's — never the pane's own template.
 */
describe('Splitter', () => {
  beforeEach(() => {
    localStorage.clear();
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
    await frame();
    expect(layout.explorerSize()).toBe(140);

    press(handle, 'pointerup');
    // Released: a later move must not reach the pane that was being sized.
    press(handle, 'pointermove', { clientY: 10 });
    await frame();
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
