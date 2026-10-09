import { describe, expect, it, vi } from 'vitest';
import { startResize, type ResizeDrag } from './resize-drag';

/** jsdom has no `PointerEvent`; a `MouseEvent` carries everything these handlers read. */
function press(element: Element, type: string, init: MouseEventInit = {}): void {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

function handle(): HTMLElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

/** One animation frame: the drag coalesces its moves into one layout per paint. */
const frame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

/** A handle that starts a drag on pointerdown, with the site's own value formula. */
function resizable(element: HTMLElement, drag: ResizeDrag<number>): void {
  element.addEventListener('pointerdown', (event) => startResize(event, drag));
}

describe('startResize', () => {
  it('paints the first move at once, coalesces the rest, and commits once on release', async () => {
    const element = handle();
    const preview = vi.fn();
    const commit = vi.fn();
    resizable(element, { value: (pointer) => pointer.clientY, preview, commit });

    press(element, 'pointerdown', { clientY: 100 });
    press(element, 'pointermove', { clientY: 140 });
    // The drag shows something the moment the pointer moves, without waiting for a paint.
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenLastCalledWith(140);

    press(element, 'pointermove', { clientY: 180 });
    expect(preview).toHaveBeenCalledTimes(1);
    await frame();

    // One layout for the moves that shared a frame.
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenLastCalledWith(180);
    expect(commit).not.toHaveBeenCalled();

    press(element, 'pointerup');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(180);

    // The drag is over: a later move must not reach it.
    press(element, 'pointermove', { clientY: 900 });
    await frame();
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it('commits nothing when the pointer went down and up without moving', () => {
    const element = handle();
    const commit = vi.fn();
    resizable(element, { value: () => 400, preview: vi.fn(), commit });

    press(element, 'pointerdown');
    press(element, 'pointerup');

    expect(commit).not.toHaveBeenCalled();
  });

  it('brackets the drag with begin and end, cancelled drags included', () => {
    const element = handle();
    const events: string[] = [];
    resizable(element, {
      value: () => 400,
      preview: vi.fn(),
      commit: vi.fn(),
      begin: () => events.push('begin'),
      end: () => events.push('end'),
    });

    press(element, 'pointerdown');
    expect(events).toEqual(['begin']);
    press(element, 'pointermove', { clientY: 10 });
    press(element, 'pointercancel');
    expect(events).toEqual(['begin', 'end']);

    // Cancelled is over too, and a cancelled drag still applies the last value it had.
    press(element, 'pointermove', { clientY: 20 });
    expect(events).toEqual(['begin', 'end']);
  });

  it('takes the value the drag computes, whatever it is measuring', async () => {
    const element = handle();
    const commit = vi.fn();
    resizable(element, {
      value: (pointer) => 1000 - pointer.clientX,
      preview: vi.fn(),
      commit,
    });

    press(element, 'pointerdown', { clientX: 500 });
    press(element, 'pointermove', { clientX: 700 });
    press(element, 'pointerup');

    expect(commit).toHaveBeenCalledWith(300);
  });
});
