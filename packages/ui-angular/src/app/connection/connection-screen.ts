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
  template: `
    <div class="screen" role="alertdialog" aria-labelledby="morse-conn-title">
      <span class="veil" aria-hidden="true"></span>
      <span class="aura" aria-hidden="true"></span>
      <span class="grid" aria-hidden="true"></span>

      <div class="panel">
        <div class="stage" aria-hidden="true">
          <span class="halo"></span>
          <span class="wave wave-a"></span>
          <span class="wave wave-b"></span>
          <svg class="scanner" viewBox="0 0 140 140">
            <circle class="track" cx="70" cy="70" r="58" />
            <circle class="sweep" cx="70" cy="70" r="58" />
          </svg>
          <span class="mark">
            <span class="glyph dot"></span>
            <span class="glyph dot"></span>
            <span class="glyph dash"></span>
          </span>
        </div>

        <p class="eyebrow"><span class="pip" aria-hidden="true"></span>{{ eyebrow() }}</p>
        <h1 id="morse-conn-title" class="title">{{ title() }}</h1>
        <p class="body">{{ body() }}</p>
        @if (detail(); as line) {
          <p class="detail">{{ line }}</p>
        }

        <div class="actions">
          <button type="button" class="primary" (click)="retry.emit()">Retry now</button>
          <button type="button" class="ghost" (click)="explore.emit()">Explore the app</button>
        </div>

        @if (isBrowser) {
          <div class="help">
            <p class="help-title">Start a local host</p>
            <code class="help-cmd">npm run dev:server</code>
            <p class="help-or">or point this window at an existing one</p>
            <form class="server" (submit)="submit($event)">
              <input
                type="text"
                name="server"
                placeholder="ws://host:port"
                autocomplete="off"
                spellcheck="false"
                [value]="server()"
                (input)="onInput($event)"
              />
              <button type="submit" [disabled]="server().trim().length === 0">Connect</button>
            </form>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: contents;
      }

      .screen {
        position: fixed;
        inset: 0;
        z-index: 90;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        color: var(--morse-fg);
        animation: conn-fade 260ms ease-out;
      }
      .veil {
        position: absolute;
        inset: 0;
        background: var(--morse-bg);
      }
      .aura {
        position: absolute;
        width: min(620px, 92vh);
        aspect-ratio: 1;
        border-radius: 50%;
        background: radial-gradient(
          circle,
          color-mix(in srgb, var(--morse-accent) 30%, transparent) 0%,
          transparent 62%
        );
        filter: blur(10px);
        opacity: 0.85;
      }
      .grid {
        position: absolute;
        inset: 0;
        background-image: radial-gradient(
          color-mix(in srgb, var(--morse-fg) 12%, transparent) 1px,
          transparent 1px
        );
        background-size: 22px 22px;
        -webkit-mask-image: radial-gradient(circle at center, #000 0%, transparent 64%);
        mask-image: radial-gradient(circle at center, #000 0%, transparent 64%);
        opacity: 0.55;
      }

      .panel {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        max-width: 520px;
        padding: 28px 20px;
        text-align: center;
      }
      .panel > * {
        animation: conn-rise 460ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
      }
      .panel > :nth-child(2) { animation-delay: 40ms; }
      .panel > :nth-child(3) { animation-delay: 90ms; }
      .panel > :nth-child(4) { animation-delay: 140ms; }
      .panel > :nth-child(5) { animation-delay: 190ms; }
      .panel > :nth-child(6) { animation-delay: 240ms; }
      .panel > :nth-child(7) { animation-delay: 290ms; }

      /* The mark keeps pinging while the scanner sweeps for a host. */
      .stage {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 140px;
        height: 140px;
      }
      .scanner {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: visible;
      }
      .track {
        fill: none;
        stroke: var(--morse-fg-muted);
        stroke-width: 1;
        opacity: 0.35;
      }
      .sweep {
        fill: none;
        stroke: var(--morse-accent);
        stroke-width: 1.6;
        stroke-linecap: round;
        stroke-dasharray: 10 14;
        transform-box: fill-box;
        transform-origin: center;
        animation: conn-sweep 9s linear infinite;
      }
      .halo {
        position: absolute;
        width: 96px;
        height: 96px;
        border-radius: 50%;
        background: radial-gradient(
          circle,
          color-mix(in srgb, var(--morse-accent) 45%, transparent) 0%,
          transparent 68%
        );
        animation: conn-breathe 3.6s ease-in-out infinite;
      }
      .wave {
        position: absolute;
        width: 96px;
        height: 96px;
        border-radius: 50%;
        border: 1px solid color-mix(in srgb, var(--morse-fg) 40%, transparent);
        animation: conn-ping 2.8s ease-out infinite;
      }
      .wave-b {
        border-color: color-mix(in srgb, var(--morse-accent) 55%, transparent);
        animation-delay: 1.4s;
      }
      .mark {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .glyph {
        background: var(--morse-fg);
        box-shadow: 0 0 12px color-mix(in srgb, var(--morse-fg) 40%, transparent);
        animation: conn-search 1.6s ease-in-out infinite;
      }
      .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
      }
      .dash {
        width: 34px;
        height: 12px;
        border-radius: 999px;
        animation-delay: 0.36s;
      }
      .glyph:nth-child(2) {
        animation-delay: 0.18s;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 4px 0 0;
        font-size: 10.5px;
        letter-spacing: 0.28em;
        text-transform: uppercase;
        color: var(--morse-fg-muted);
      }
      .pip {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--morse-warn);
        animation: conn-pip 1.4s ease-in-out infinite;
      }
      .title {
        margin: 0;
        font-size: 19px;
        font-weight: 650;
        line-height: 1.25;
      }
      .body {
        margin: 0;
        max-width: 420px;
        color: var(--morse-fg-muted);
        line-height: 1.65;
      }
      .detail {
        margin: 2px 0 0;
        max-width: 460px;
        font-family: var(--morse-font-mono);
        font-size: 11px;
        color: var(--morse-fg-muted);
        opacity: 0.8;
        word-break: break-word;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
        margin-top: 8px;
      }
      .actions .primary,
      .actions .ghost {
        padding: 6px 16px;
        border-radius: 999px;
      }
      .actions .ghost {
        background: var(--morse-button-secondary);
        color: var(--morse-button-secondary-fg);
      }
      .actions .ghost:hover {
        background: var(--morse-hover);
        border-color: var(--morse-border);
      }

      .help {
        margin-top: 14px;
        padding: 12px 14px;
        width: 100%;
        max-width: 380px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        background: var(--morse-hover);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
      }
      .help-title {
        margin: 0;
        font-size: 11px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--morse-fg-muted);
      }
      .help-cmd {
        font-family: var(--morse-font-mono);
        font-size: 12px;
        padding: 3px 10px;
        border-radius: var(--morse-radius-sm);
        background: var(--morse-code-bg);
        border: 1px solid var(--morse-border);
      }
      .help-or {
        margin: 2px 0 0;
        font-size: 11px;
        color: var(--morse-fg-muted);
      }
      .server {
        display: flex;
        width: 100%;
        gap: 6px;
      }
      .server input {
        flex: 1;
        min-width: 0;
      }

      @keyframes conn-fade {
        from {
          opacity: 0;
        }
      }
      @keyframes conn-rise {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
      }
      @keyframes conn-sweep {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes conn-breathe {
        0%,
        100% {
          opacity: 0.6;
          transform: scale(0.94);
        }
        50% {
          opacity: 1;
          transform: scale(1.06);
        }
      }
      @keyframes conn-ping {
        0% {
          opacity: 0.5;
          transform: scale(0.5);
        }
        80%,
        100% {
          opacity: 0;
          transform: scale(2.05);
        }
      }
      @keyframes conn-search {
        0%,
        100% {
          opacity: 0.4;
          transform: translateY(0);
        }
        45% {
          opacity: 1;
          transform: translateY(-4px);
        }
      }
      @keyframes conn-pip {
        0%,
        100% {
          opacity: 0.35;
        }
        50% {
          opacity: 1;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .screen,
        .panel > *,
        .sweep,
        .halo,
        .wave,
        .glyph,
        .pip {
          animation: none;
        }
      }
    `,
  ],
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
