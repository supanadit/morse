import { parseHostMessage, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from './host-transport.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}

let acquired: VsCodeApi | undefined;
let acquisitionAttempted = false;

/**
 * Whether this document is a VS Code webview.
 *
 * Detection must not acquire: the injected `acquireVsCodeApi` throws
 * "An instance of the VS Code API has already been acquired" when it is called
 * a second time, so probing with a call and then constructing the transport used
 * to fail the whole bootstrap — a blank panel.
 */
export function hasVsCodeApi(): boolean {
  const candidate = (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  return typeof candidate === 'function';
}

/** Returns the one API instance a webview is allowed to acquire. */
export function acquireVsCodeApi(): VsCodeApi | undefined {
  const candidate = (globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi;
  if (typeof candidate !== 'function') {
    return undefined;
  }
  if (!acquisitionAttempted) {
    acquisitionAttempted = true;
    acquired = candidate();
  }
  return acquired;
}

/** Talks to the VS Code extension host over the webview `postMessage` channel. */
export class VsCodeHostTransport extends BaseHostTransport {
  readonly kind = 'vscode' as const;

  private readonly api = acquireVsCodeApi();
  private readonly listener = (event: MessageEvent): void => {
    const message = parseHostMessage(event.data);
    if (message) {
      this.emitMessage(message);
    }
  };

  connect(): void {
    if (!this.api) {
      this.emitStatus('error', 'Not running inside a VS Code webview.');
      return;
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.listener);
    }
    this.emitStatus('open');
  }

  send(message: ClientToHostMessage): void {
    this.api?.postMessage(message);
  }

  readState(): unknown {
    return this.api?.getState?.();
  }

  writeState(state: unknown): void {
    this.api?.setState?.(state);
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.listener);
    }
    this.emitStatus('closed');
  }
}
