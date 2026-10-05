import { Injectable, signal } from '@angular/core';

/** One open terminal, owned by the session (or draft) that opened it. */
export interface TerminalInstance {
  id: string;
  /** The session/draft id it belongs to; `undefined` is the empty draft. */
  owner: string | undefined;
  title: string;
}

/**
 * The open terminals and which session each belongs to. Frontend state, like the
 * tab strip: a terminal is not shared across sessions, so switching to another
 * session shows that session's terminals and leaves the others running. The
 * session that opens a terminal is the composer's key (`WorkspaceTabs.composerKey`),
 * which already tracks the session in front (a draft id included).
 *
 * Only metadata lives here; the PTY itself is opened by the `Terminal` view and
 * killed when its component unmounts — which is what closing a terminal, or
 * closing its session tab, does.
 */
@Injectable({ providedIn: 'root' })
export class TerminalStore {
  private readonly items = signal<TerminalInstance[]>([]);
  /** The terminal in front per owner, so each session remembers its own. */
  private readonly activeByOwner = signal<Record<string, string | undefined>>({});
  private counter = 0;

  readonly terminals = this.items.asReadonly();

  /** Opens a new terminal for `owner` and puts it in front. Returns its id. */
  open(owner: string | undefined): string {
    this.counter += 1;
    const id = `term-${this.counter}`;
    this.items.update((list) => [
      ...list,
      { id, owner, title: `Terminal ${this.counter}` },
    ]);
    this.setActive(owner, id);
    return id;
  }

  /**
   * Closes one terminal, falling back to its neighbour when it was in front —
   * the same rule the session tab strip uses.
   */
  close(id: string): void {
    const instance = this.items().find((terminal) => terminal.id === id);
    if (instance === undefined) {
      return;
    }
    const siblings = this.items().filter((terminal) => terminal.owner === instance.owner);
    const index = siblings.findIndex((terminal) => terminal.id === id);
    this.items.update((list) => list.filter((terminal) => terminal.id !== id));
    if (this.activeFor(instance.owner) === id) {
      const remaining = this.items().filter((terminal) => terminal.owner === instance.owner);
      const neighbour = remaining[Math.min(index, remaining.length - 1)];
      this.setActive(instance.owner, neighbour?.id);
    }
  }

  /** Brings a terminal in front within its own session. */
  focus(id: string): void {
    const instance = this.items().find((terminal) => terminal.id === id);
    if (instance !== undefined) {
      this.setActive(instance.owner, id);
    }
  }

  /** The terminal in front for a session; `undefined` when it has none. */
  activeFor(owner: string | undefined): string | undefined {
    return this.activeByOwner()[keyOf(owner)];
  }

  /** Drops every terminal of a session (its tab was closed). */
  forgetOwner(owner: string | undefined): void {
    this.items.update((list) => list.filter((terminal) => terminal.owner !== owner));
    this.setActive(owner, undefined);
  }

  /** A draft became the session that owns it; its terminals follow it. */
  rekey(from: string, to: string): void {
    this.items.update((list) =>
      list.map((terminal) =>
        terminal.owner === from ? { ...terminal, owner: to } : terminal,
      ),
    );
    const active = this.activeFor(from);
    if (active !== undefined) {
      this.setActive(to, active);
      this.setActive(from, undefined);
    }
  }

  private setActive(owner: string | undefined, id: string | undefined): void {
    this.activeByOwner.update((record) => ({ ...record, [keyOf(owner)]: id }));
  }
}

function keyOf(owner: string | undefined): string {
  return owner ?? '';
}
