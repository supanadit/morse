import { describe, expect, it } from 'vitest';
import { followVisualViewport, setViewportHeight } from './viewport-height';

/** A stand-in for `window.visualViewport`, which jsdom does not have. */
function fakeViewport(
  height: number,
  scale = 1,
): { view: VisualViewport; fire: (type: string) => void } {
  const listeners = new Map<string, () => void>();
  const view = {
    height,
    scale,
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  } as unknown as VisualViewport;
  return { view, fire: (type) => listeners.get(type)?.() };
}

const height = (root: HTMLElement) => root.style.getPropertyValue('--morse-vv-height');

describe('viewport height', () => {
  it('writes a rounded height into the CSS var', () => {
    const root = document.createElement('div');

    setViewportHeight(412.6, root);

    expect(height(root)).toBe('413px');
  });

  it('follows the keyboard opening and closing', () => {
    const root = document.createElement('div');
    const { view, fire } = fakeViewport(800);
    followVisualViewport(view, root);
    expect(height(root)).toBe('800px');

    // The keyboard opens: the visual viewport shrinks and the composer must move up.
    (view as { height: number }).height = 312;
    fire('resize');
    expect(height(root)).toBe('312px');

    (view as { height: number }).height = 800;
    fire('resize');
    expect(height(root)).toBe('800px');
  });

  it('leaves a pinched page its own height', () => {
    const root = document.createElement('div');
    const { view, fire } = fakeViewport(800, 2);
    followVisualViewport(view, root);
    // Zoomed in, the browser's own panning moves the page; pinning it to the
    // visual viewport would leave a strip of nothing at the bottom.
    expect(height(root)).toBe('');

    (view as VisualViewport & { scale: number }).scale = 1;
    fire('resize');
    expect(height(root)).toBe('800px');
  });

  it('does nothing where the browser has no visual viewport', () => {
    const root = document.createElement('div');

    followVisualViewport(undefined, root);

    expect(height(root)).toBe('');
  });
});
