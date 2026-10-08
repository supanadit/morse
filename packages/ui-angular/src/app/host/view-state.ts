import { Injectable, inject } from '@angular/core';
import { MORSE_TRANSPORT } from './transport.token';

/**
 * Frontend-owned state that has to outlive a reload: the half-written MCP entry,
 * a future editor's form, any surface a reader would curse to lose.
 *
 * Where it lives depends on the host, and the transport is the seam: VS Code's
 * webview exposes `getState`/`setState` (and its `WebviewPanelSerializer`
 * restores the panel with that state), the mock host keeps it in memory, and a
 * browser host falls back to `localStorage`. It is best effort — a disabled or
 * full storage simply means no persistence, never an error.
 *
 * Keys are namespaced under `morse.view.` so one namespace serves every surface.
 */
@Injectable({ providedIn: 'root' })
export class ViewState {
  private readonly transport = inject(MORSE_TRANSPORT);
  private readonly prefix = 'morse.view.';

  read<T>(key: string): T | undefined {
    const host = this.hostState();
    if (host !== undefined) {
      const value = host[this.prefix + key];
      return value === undefined ? undefined : (value as T);
    }
    try {
      const raw = globalThis.localStorage?.getItem(this.prefix + key);
      return raw === null || raw === undefined ? undefined : (JSON.parse(raw) as T);
    } catch {
      return undefined;
    }
  }

  write<T>(key: string, value: T | undefined): void {
    if (typeof this.transport.readState === 'function' && typeof this.transport.writeState === 'function') {
      const next = { ...(this.hostState() ?? {}) };
      if (value === undefined) {
        delete next[this.prefix + key];
      } else {
        next[this.prefix + key] = value;
      }
      this.transport.writeState(next);
      return;
    }
    try {
      if (value === undefined) {
        globalThis.localStorage?.removeItem(this.prefix + key);
      } else {
        globalThis.localStorage?.setItem(this.prefix + key, JSON.stringify(value));
      }
    } catch {
      // A full or disabled storage just means no persistence.
    }
  }

  /** The transport's state object, or `undefined` when the host has nowhere to keep it. */
  private hostState(): Record<string, unknown> | undefined {
    if (typeof this.transport.readState !== 'function') {
      return undefined;
    }
    const state = this.transport.readState();
    return typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {};
  }
}
