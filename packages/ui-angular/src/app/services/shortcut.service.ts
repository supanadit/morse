import { Injectable, computed, inject, signal } from '@angular/core';
import { ShellState } from '../state/shell-state';
import {
  SHORTCUTS,
  isEditable,
  isManagedShortcut,
  matches,
  type ActionId,
  type ManagedShortcut,
} from './shortcuts.catalog';

/** One action an owner has taken responsibility for. */
interface Handler {
  run: () => void;
  /**
   * Whether it can run *right now*. An owner that knows its own limits says so —
   * no models to choose, no projects to filter — and the help dialog greys the
   * row out instead of offering a key that does nothing.
   */
  enabled?: () => boolean;
}

/**
 * The keyboard registry. `SHORTCUTS` is what the help dialog prints and what this
 * service matches, so the two cannot drift.
 *
 * Owners bind what they own: the composer the model chooser, the sidebar its
 * search field, the thinking picker its panel. Nothing is bound in a single
 * "handler" switch, which is what makes an owner that is not on screen — the
 * composer while the agent is down — show up as an unavailable row instead of a
 * dead key.
 *
 * The document listener lives in `ui/shortcut-keys.ts`: the service decides what a
 * press means, and the adapter is what hears it.
 */
@Injectable({ providedIn: 'root' })
export class ShortcutService {
  private readonly shell = inject(ShellState);
  private readonly handlers = new Map<ActionId, Handler>();
  /**
   * Bindings appear and disappear while the app runs, and the dialog reads what
   * is available, so the map needs an edge the computed below can track.
   */
  private readonly revision = signal(0);

  /** What the help dialog lists. */
  readonly catalog = SHORTCUTS;

  /** Which rows can run right now, keyed by id; local rows are not in here. */
  readonly available = computed<ReadonlyMap<ActionId, boolean>>(() => {
    this.revision();
    const availability = new Map<ActionId, boolean>();
    for (const spec of SHORTCUTS) {
      if (!isManagedShortcut(spec)) {
        continue;
      }
      const handler = this.handlers.get(spec.id);
      availability.set(spec.id, handler !== undefined && (handler.enabled?.() ?? true));
    }
    return availability;
  });

  /**
   * Binds the action behind `id`. Returns a disposer: the composer is unmounted
   * when the agent cannot start, and a handler must not outlive it.
   */
  bind(id: ActionId, run: () => void, enabled?: () => boolean): () => void {
    const handler: Handler = { run, enabled };
    this.handlers.set(id, handler);
    this.bump();
    return () => {
      if (this.handlers.get(id) === handler) {
        this.handlers.delete(id);
        this.bump();
      }
    };
  }

  private bump(): void {
    this.revision.update((value) => value + 1);
  }

  /**
   * Runs an action for a caller that is not the keyboard — the command palette.
   * It goes through the same owner-bound handler the key would, and refuses when
   * that owner says it cannot run, so the palette offers exactly what the `?`
   * list offers and neither grows a second implementation.
   */
  run(id: ActionId): boolean {
    const handler = this.handlers.get(id);
    if (handler === undefined || (handler.enabled !== undefined && !handler.enabled())) {
      return false;
    }
    handler.run();
    return true;
  }

  /**
   * What one key press means, and whether it may run. Called by the document
   * listener in `ui/shortcut-keys.ts` for every keydown.
   */
  dispatch(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) {
      return;
    }
    // Windows reports AltGr as Ctrl+Alt, and AltGr types real characters — a
    // Polish `ź` must not start a session.
    if (event.getModifierState?.('AltGraph') === true) {
      return;
    }
    const spec = SHORTCUTS.find(
      (candidate): candidate is ManagedShortcut =>
        isManagedShortcut(candidate) && matches(candidate.binding, event),
    );
    if (spec === undefined) {
      return;
    }
    if (spec.whileTyping !== true && isEditable(event.target)) {
      return;
    }
    // `?` is the exception to standing down over a dialog: it is the one key that
    // closes the list it opened. Over somebody else's dialog it stays quiet, so
    // the list never stacks on top of About or the project filter.
    if (spec.overlay === true && this.shell.modalOpen()) {
      const ownDialog =
        (spec.id === 'help.shortcuts' && this.shell.shortcutsOpen()) ||
        (spec.id === 'command.palette' && this.shell.paletteOpen());
      if (!ownDialog) {
        return;
      }
    }
    const handler = this.handlers.get(spec.id);
    if (handler === undefined || (handler.enabled !== undefined && !handler.enabled())) {
      return;
    }
    // The field about to be focused must not also receive the character.
    event.preventDefault();
    handler.run();
  }
}
