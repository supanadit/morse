import { DestroyRef, Injectable, inject } from '@angular/core';
import { ShortcutService } from '../services/shortcut.service';

/**
 * The DOM half of the keyboard: one capture-phase `keydown` listener on the
 * document, forwarding every press to `ShortcutService.dispatch`.
 *
 * Capture, so a panel that stops propagation on its own key (the palette does,
 * for the arrows) cannot swallow a shortcut on the way past. The listener is
 * attached when this is constructed, which is why the app injects it once — the
 * registry itself never touches `document`.
 */
@Injectable({ providedIn: 'root' })
export class ShortcutKeys {
  constructor() {
    const shortcuts = inject(ShortcutService);
    const target = (globalThis as { document?: Document }).document;
    if (!target) {
      return;
    }
    const onKeydown = (event: KeyboardEvent): void => shortcuts.dispatch(event);
    target.addEventListener('keydown', onKeydown, true);
    inject(DestroyRef).onDestroy(() => target.removeEventListener('keydown', onKeydown, true));
  }
}
