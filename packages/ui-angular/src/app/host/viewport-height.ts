/**
 * The app is exactly one viewport high and every pane scrolls inside it, which is
 * what makes the chat layout stable — and what hides the composer behind a phone
 * keyboard: a soft keyboard shrinks the *visual* viewport, so a layout that keeps
 * its own height puts its bottom (the composer) under the keys, and nothing can
 * scroll it back because the document itself does not scroll.
 *
 * `interactive-widget=resizes-content` (index.html) is the declarative answer for
 * Android Chrome. This is the same answer for a browser that ignores it: the page
 * follows `visualViewport.height` through a CSS var the stylesheet reads.
 */
const HEIGHT_VAR = '--morse-vv-height';

/** Write one visual-viewport height into the document's CSS var; `null` clears it. */
export function setViewportHeight(
  height: number | null,
  root: HTMLElement = document.documentElement,
): void {
  if (height === null) {
    root.style.removeProperty(HEIGHT_VAR);
    return;
  }
  root.style.setProperty(HEIGHT_VAR, `${Math.round(height)}px`);
}

/** Follow a visual viewport for the life of the page; a no-op where there is none. */
export function followVisualViewport(
  view: VisualViewport | null | undefined = window.visualViewport,
  root: HTMLElement = document.documentElement,
): void {
  if (view === null || view === undefined) {
    return;
  }
  let written: number | null = null;
  // `scroll` fires often and usually says nothing new; only a different height is work.
  const apply = () => {
    // A pinch zoom shrinks the visual viewport too, and there the app keeps the
    // layout height: the browser's own panning is what moves it, not this.
    const height = view.scale === 1 ? Math.round(view.height) : null;
    if (height !== written) {
      written = height;
      setViewportHeight(height, root);
    }
  };
  apply();
  view.addEventListener('resize', apply);
  view.addEventListener('scroll', apply);
}
