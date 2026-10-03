import { Injectable, signal } from '@angular/core';

/**
 * Where the wide-layout preference is remembered. A webview or a browser with
 * storage disabled simply forgets it — the toggle still works for the session.
 */
const NAV_COLLAPSED_KEY = 'morse.navigation.collapsed';

function readNavCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(NAV_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function storeNavCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage is a nicety, not a requirement: the signal still holds the state.
  }
}

/**
 * Shell state that several components need (narrow layouts hide the navigation
 * behind a toggle, wide layouts keep it open). Kept out of `MorseService`, which
 * only knows about the wire protocol.
 */
@Injectable({ providedIn: 'root' })
export class ShellState {
  private readonly navigationVisible = signal(false);
  readonly navigationOpen = this.navigationVisible.asReadonly();

  /**
   * Wide layouts: the navigation column folded away, so the conversation gets the
   * whole width. The narrow drawer above is a different thing — a transient
   * overlay, not a layout preference — so the two keep separate flags, and only
   * this one is remembered across reloads.
   */
  private readonly collapsed = signal(readNavCollapsed());
  readonly navigationCollapsed = this.collapsed.asReadonly();

  /**
   * The "New session" folder browser (browser host only). It is shell state
   * because two buttons open it — the sidebar's and the header's — while it
   * overlays the whole app from one place (see `app.html`).
   */
  private readonly projectPicker = signal(false);
  readonly projectPickerOpen = this.projectPicker.asReadonly();

  /**
   * The About/credits dialog. Shell state for the same reason as the picker:
   * several places open it (the sidebar footer, `/about`) and it overlays the
   * whole app from one place (see `app.html`).
   */
  private readonly about = signal(false);
  readonly aboutOpen = this.about.asReadonly();

  toggleNavigation(): void {
    this.navigationVisible.update((open) => !open);
  }

  closeNavigation(): void {
    this.navigationVisible.set(false);
  }

  /** Folds the navigation column away (wide layouts) or brings it back. */
  toggleNavigationCollapsed(): void {
    this.collapsed.update((collapsed) => {
      storeNavCollapsed(!collapsed);
      return !collapsed;
    });
  }

  openAbout(): void {
    this.about.set(true);
  }

  closeAbout(): void {
    this.about.set(false);
  }

  openProjectPicker(): void {
    this.projectPicker.set(true);
  }

  closeProjectPicker(): void {
    this.projectPicker.set(false);
  }
}
