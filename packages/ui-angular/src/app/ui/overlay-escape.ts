import { DestroyRef, Injectable, inject } from '@angular/core';
import { OverlayStack } from '../state/overlay-stack';

/**
 * The DOM half of dismissing an overlay: one capture-phase `keydown` listener on
 * the document, which hands Escape to `OverlayStack.closeTop`.
 *
 * Capture, so a panel that handles Escape on its own element (a picker's list, the
 * palette's search field) cannot take the press out from under the dialog that is
 * on top of it. Every dialog used to add this listener itself, which is how one
 * press closed all the open ones at once. The listener is attached when this is
 * constructed, which is why the app injects it once — the stack itself never
 * touches `document`.
 */
@Injectable({ providedIn: 'root' })
export class OverlayEscape {
  constructor() {
    const stack = inject(OverlayStack);
    const target = (globalThis as { document?: Document }).document;
    if (!target) {
      return;
    }
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }
      // Only a press that actually dismissed something is consumed: with nothing
      // open, a field or a view keeps its own Escape.
      if (stack.closeTop()) {
        // The press belonged to that dialog. `preventDefault` alone would not stop
        // it: the file preview and the transcript close on Escape themselves, and a
        // press that closed a dialog must not close them too.
        event.stopPropagation();
        event.preventDefault();
      }
    };
    target.addEventListener('keydown', onKeydown, true);
    inject(DestroyRef).onDestroy(() => target.removeEventListener('keydown', onKeydown, true));
  }
}
