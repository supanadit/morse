import type { AgentInteractionRequest } from '@morse/agent';

/**
 * The questions a host is waiting on the reader to answer, shared by every
 * device attached to it.
 *
 * They used to live in each connection's controller: the request reached every
 * browser through the shared agent stream, but the answer only dismissed the
 * form on the device that sent it. One hub here owns the pending map and tells
 * every controller when it changes; each controller still decides which of its
 * own sessions is in front and therefore which request to show.
 */
export class InteractionHub {
  private readonly pending = new Map<
    string,
    { sessionKey: string; request: AgentInteractionRequest }
  >();
  private readonly listeners = new Set<() => void>();

  /** One subscriber per connection; the caller unsubscribes on disconnect. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Records a request. Every controller sees the same event, so only the first
   * to add it announces the change.
   */
  add(sessionKey: string, request: AgentInteractionRequest): void {
    if (this.pending.has(request.requestId)) {
      return;
    }
    this.pending.set(request.requestId, { sessionKey, request });
    this.notify();
  }

  /** The pending request of one session, for the controller's single dialog slot. */
  pendingFor(sessionKey: string | undefined): AgentInteractionRequest | undefined {
    if (sessionKey === undefined) {
      return undefined;
    }
    for (const entry of this.pending.values()) {
      if (entry.sessionKey === sessionKey) {
        return entry.request;
      }
    }
    return undefined;
  }

  /** The session that owns a request, so an answer reaches the right agent. */
  ownerOf(requestId: string): string | undefined {
    return this.pending.get(requestId)?.sessionKey;
  }

  /** Removes a settled request and tells every device to drop its form. */
  settle(requestId: string): string | undefined {
    const entry = this.pending.get(requestId);
    if (entry === undefined) {
      return undefined;
    }
    this.pending.delete(requestId);
    this.notify();
    return entry.sessionKey;
  }

  /** A session that went away cannot be asked anything else. */
  forget(sessionKey: string): void {
    let removed = false;
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionKey === sessionKey) {
        this.pending.delete(requestId);
        removed = true;
      }
    }
    if (removed) {
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
