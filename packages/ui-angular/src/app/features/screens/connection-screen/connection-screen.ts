import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

/**
 * Friendly full-screen state for "there is no host to talk to".
 *
 * A red alert bar made a normal situation — the frontend is up, the backend is
 * not — look like a crash. This replaces it with a calm, animated screen that
 * says what happened, what to do about it, and lets the reader continue into the
 * app anyway (the navigation and transcript stay reachable behind it).
 *
 * All motion is CSS so it keeps running in a hidden webview, and it is skipped
 * under `prefers-reduced-motion`.
 */
@Component({
  selector: 'morse-connection-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './connection-screen.html',
  styleUrl: './connection-screen.css',
})
export class ConnectionScreen {
  /** A short state word above the title, e.g. "Offline · reconnecting". */
  readonly eyebrow = input('Offline');
  readonly title = input('Morse is waiting for a host');
  readonly body = input(
    'This window is only the frontend. The pi coding agent runs behind a Morse host — start one and this screen will clear itself.',
  );
  /** The raw transport line, kept small and technical. */
  readonly detail = input('');

  /** The browser host can be pointed at another server; VS Code cannot. */
  protected readonly isBrowser =
    typeof globalThis !== 'undefined' && typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === 'undefined';

  protected readonly server = signal('');

  /** Try the handshake again right now. */
  readonly retry = output<void>();
  /** Leave the screen up but let the app be used behind it. */
  readonly explore = output<void>();
  /** Connect to a different host, then reload. */
  readonly connect = output<string>();

  protected onInput(event: Event): void {
    this.server.set((event.target as HTMLInputElement).value);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const url = this.server().trim();
    if (url.length > 0) {
      this.connect.emit(url);
    }
  }
}
