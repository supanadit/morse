import type { ClientToHostMessage, HostToClientMessage } from '@morse/protocol';

export type TransportStatus = 'connecting' | 'open' | 'closed' | 'error';

export type TransportKind = 'vscode' | 'websocket' | 'memory';

/**
 * Port (R2) the frontend core owns: every host connection is one implementation
 * of this interface, so the same Angular/React/Svelte app runs inside a VS Code
 * webview or a browser talking to the NestJS host.
 */
export interface HostTransport {
  readonly kind: TransportKind;
  connect(): void;
  send(message: ClientToHostMessage): void;
  onMessage(listener: (message: HostToClientMessage) => void): () => void;
  onStatus(listener: (status: TransportStatus, detail?: string) => void): () => void;
  dispose(): void;
}

export abstract class BaseHostTransport implements HostTransport {
  abstract readonly kind: TransportKind;

  private readonly messageListeners = new Set<(message: HostToClientMessage) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus, detail?: string) => void>();

  abstract connect(): void;
  abstract send(message: ClientToHostMessage): void;
  abstract dispose(): void;

  onMessage(listener: (message: HostToClientMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onStatus(listener: (status: TransportStatus, detail?: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  protected emitMessage(message: HostToClientMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  protected emitStatus(status: TransportStatus, detail?: string): void {
    for (const listener of [...this.statusListeners]) {
      listener(status, detail);
    }
  }
}
