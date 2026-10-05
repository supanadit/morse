import { Injectable, computed, signal } from '@angular/core';

/**
 * One terminal pane: a real PTY. A chip on the tab row can hold several of them
 * (a split), and they all share a `group`.
 */
export interface TerminalInstance {
  id: string;
  /** The session/draft id it belongs to; `undefined` is the empty draft. */
  owner: string | undefined;
  /** Split panes share a group; the first pane of a group owns its chip. */
  group: string;
  /** The label shown: the reader's name, else the shell's title, else the fallback. */
  title: string;
  /** `Terminal N`, shown until a name or a shell title arrives. */
  fallbackTitle: string;
  /** The reader's own name; while set, the shell title never replaces the label. */
  custom?: string;
  /** The shell's last OSC 0/2 title (the command it is running), when it set one. */
  auto?: string;
  /**
   * The directory the shell runs in, when it was restored from a saved layout.
   * A live terminal does not need it (the host runs it in the viewing session's
   * directory), but a restored one belongs to a session that may not be in front
   * yet, so the pane carries its own directory to open the shell in.
   */
  cwd?: string;
}

/**
 * The terminals a reader had open, written to their saved layout: the panes, the
 * terminal in front per session, the focused pane per split and the dragged pane
 * widths. The host owns the PTY itself (a server-side registry), so a restore
 * reattaches to the same shell and replays what it missed; `terminal/close` is
 * what ends one. The frontend still owns only the layout — it never stores output. */
export interface TerminalsSnapshot {
  panes: TerminalInstance[];
  activeByOwner: Record<string, string | undefined>;
  activePaneByGroup: Record<string, string | undefined>;
  sizesByGroup: Record<string, number[]>;
}

/**
 * One chip on the tab row: a terminal and the panes split from it. The chip's
 * label carries the pane count (`Terminal 1 (2)`) so a split is visible at a
 * glance, and `panes` is what the side list and the screen area render.
 */
export interface TerminalGroup {
  id: string;
  owner: string | undefined;
  /** The base name, without a split suffix; what a rename edits. */
  name: string;
  /** The chip's full label: `name`, plus `(N)` when the terminal is split. */
  title: string;
  /** How many panes the split holds; `1` for a plain terminal. */
  count: number;
  /** Each pane's share of the width (sums to 1), so a split can be resized. */
  sizes: number[];
  panes: TerminalInstance[];
  /** The pane in front inside the group; the chip follows its command. */
  activePane: string;
}

/** An even split for `count` panes. */
function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

/** The label a pane shows: a rename wins, then the shell's title, then `Terminal N`. */
function relabel(instance: TerminalInstance): TerminalInstance {
  return { ...instance, title: instance.custom ?? instance.auto ?? instance.fallbackTitle };
}

/**
 * The open terminals and which session each belongs to. Frontend state, like the
 * tab strip: a terminal is not shared across sessions, so switching to another
 * session shows that session's terminals and leaves the others running. The
 * session that opens a terminal is the composer's key (`WorkspaceTabs.composerKey`),
 * which already tracks the session in front (a draft id included).
 *
 * A terminal can be **split**: `split()` adds a pane to the group, and every pane
 * is its own shell while the group keeps one chip. Only metadata lives here; the
 * PTY itself is opened by the `Terminal` view and left running by the host when
 * the pane unmounts — closing a pane, a terminal or its session tab sends
 * `terminal/close`, which is what ends it.
 */
@Injectable({ providedIn: 'root' })
export class TerminalStore {
  private readonly items = signal<TerminalInstance[]>([]);
  /** The terminal (group) in front per owner, so each session remembers its own. */
  private readonly activeByOwner = signal<Record<string, string | undefined>>({});
  /** The pane in front per group, so a split remembers which one had focus. */
  private readonly activePaneByGroup = signal<Record<string, string | undefined>>({});
  /** Each group's pane widths, when the reader has dragged a splitter. */
  private readonly sizesByGroup = signal<Record<string, number[]>>({});
  private counter = 0;

  readonly terminals = this.items.asReadonly();

  /**
   * The chips, one per terminal: the panes of a group kept together, its label
   * carrying the split count. Derived, so closing a pane or a whole terminal
   * never leaves a stale chip behind.
   */
  readonly groups = computed<TerminalGroup[]>(() => {
    const items = this.items();
    const order: string[] = [];
    const byGroup = new Map<string, TerminalInstance[]>();
    for (const pane of items) {
      if (!byGroup.has(pane.group)) {
        byGroup.set(pane.group, []);
        order.push(pane.group);
      }
      byGroup.get(pane.group)!.push(pane);
    }
    return order.map((groupId) => {
      const panes = byGroup.get(groupId)!;
      const first = panes[0]!;
      const active = panes.find((pane) => pane.id === this.activePaneByGroup()[groupId]) ?? first;
      // The chip follows the focused pane's command; the first pane's fallback
      // keeps it from turning into a second pane's `Terminal 2`.
      const base = first.custom ?? active.auto ?? first.auto ?? first.fallbackTitle;
      return {
        id: groupId,
        owner: first.owner,
        name: base,
        title: panes.length > 1 ? `${base} (${panes.length})` : base,
        count: panes.length,
        sizes: this.sizesFor(groupId, panes.length),
        panes,
        activePane: active.id,
      };
    });
  });

  /** Opens a new terminal for `owner` and puts it in front. Returns its id. */
  open(owner: string | undefined): string {
    const pane = this.mint(owner, undefined);
    this.setActive(owner, pane.group);
    return pane.id;
  }

  /**
   * Splits a terminal: adds a pane to `groupId`'s split and puts it in front.
   * Returns the new pane's id, or `undefined` when the terminal is gone.
   */
  split(groupId: string): string | undefined {
    const group = this.groups().find((entry) => entry.id === groupId);
    if (group === undefined) {
      return undefined;
    }
    const pane = this.mint(group.owner, groupId);
    this.setActive(group.owner, groupId);
    this.setActivePane(groupId, pane.id);
    return pane.id;
  }

  /**
   * Stores a pane's shell title (OSC 0/2), which is how a running command names
   * the tab — `npm run dev`, `vim`. A reader's rename outranks it, so the label
   * only moves while the terminal has not been named by hand.
   */
  setAutoTitle(id: string, title: string): void {
    const auto = title.trim().length > 0 ? title.trim() : undefined;
    this.items.update((list) =>
      list.map((instance) => {
        if (instance.id !== id || instance.auto === auto) {
          return instance;
        }
        return relabel({ ...instance, auto });
      }),
    );
  }

  /** Renames a terminal (the whole chip); an empty name restores the shell title. */
  rename(id: string, name: string): void {
    const custom = name.trim().length > 0 ? name.trim() : undefined;
    this.items.update((list) => {
      const index = list.findIndex((instance) => instance.group === id);
      if (index < 0) {
        return list;
      }
      const next = [...list];
      next[index] = relabel({ ...next[index]!, custom });
      return next;
    });
  }

  /**
   * Closes one pane. The last pane of a group closes the terminal (and its chip),
   * so a split never leaves an empty shell behind.
   */
  closePane(id: string): void {
    const pane = this.items().find((instance) => instance.id === id);
    if (pane === undefined) {
      return;
    }
    const siblings = this.items().filter((instance) => instance.group === pane.group);
    if (siblings.length <= 1) {
      this.close(pane.group);
      return;
    }
    const index = siblings.findIndex((instance) => instance.id === id);
    this.items.update((list) => list.filter((instance) => instance.id !== id));
    if (this.activePaneFor(pane.group) === id) {
      const remaining = this.items().filter((instance) => instance.group === pane.group);
      this.setActivePane(pane.group, remaining[Math.min(index, remaining.length - 1)]?.id);
    }
  }

  /**
   * Closes a whole terminal (every pane in its split), falling back to its
   * neighbour when it was in front — the same rule the session tab strip uses.
   */
  close(id: string): void {
    const owner = this.items().find((instance) => instance.group === id)?.owner;
    const groups = this.groupIds(owner);
    const index = groups.indexOf(id);
    if (index < 0) {
      return;
    }
    this.items.update((list) => list.filter((instance) => instance.group !== id));
    this.setActivePane(id, undefined);
    if (this.activeFor(owner) === id) {
      const remaining = this.groupIds(owner);
      this.setActive(owner, remaining[Math.min(index, remaining.length - 1)]);
    }
  }

  /** Brings a pane — and the terminal it is split into — in front. */
  focus(id: string): void {
    const pane = this.items().find((instance) => instance.id === id);
    if (pane !== undefined) {
      this.setActive(pane.owner, pane.group);
      this.setActivePane(pane.group, id);
    }
  }

  /** The terminal (group) in front for a session; `undefined` when it has none. */
  activeFor(owner: string | undefined): string | undefined {
    return this.activeByOwner()[keyOf(owner)];
  }

  /** The pane in front inside a group; `undefined` when the group is gone. */
  activePaneFor(group: string): string | undefined {
    return this.activePaneByGroup()[group];
  }

  /**
   * Stores a split's pane widths after a drag. A structural change (a new pane or
   * a closed one) no longer matches the count, and `sizesFor` falls back to even.
   */
  setSizes(group: string, sizes: number[]): void {
    this.sizesByGroup.update((record) => ({ ...record, [group]: sizes }));
  }

  /** A group's stored widths, or an even split while they are unknown or stale. */
  private sizesFor(group: string, count: number): number[] {
    const stored = this.sizesByGroup()[group];
    return stored !== undefined && stored.length === count ? stored : evenSizes(count);
  }

  /** Drops every terminal of a session (its tab was closed). */
  forgetOwner(owner: string | undefined): void {
    this.items.update((list) => list.filter((instance) => instance.owner !== owner));
    this.setActive(owner, undefined);
  }

  /** A draft became the session that owns it; its terminals follow it. */
  rekey(from: string, to: string): void {
    this.items.update((list) =>
      list.map((instance) =>
        instance.owner === from ? { ...instance, owner: to } : instance,
      ),
    );
    const active = this.activeFor(from);
    if (active !== undefined) {
      this.setActive(to, active);
      this.setActive(from, undefined);
    }
  }

  /** Everything a saved layout keeps: the panes and every "which is in front" map. */
  snapshot(): TerminalsSnapshot {
    return {
      panes: this.items().map((pane) => ({ ...pane })),
      activeByOwner: { ...this.activeByOwner() },
      activePaneByGroup: { ...this.activePaneByGroup() },
      sizesByGroup: { ...this.sizesByGroup() },
    };
  }

  /**
   * Restores a saved layout. Every pane is re-minted with the id it had, so the
   * host opens the same shell under the same name, and the counter moves past
   * the highest id so a new terminal never collides with a restored one. Ids the
   * layout cannot use are dropped rather than re-opened as dead shells.
   */
  restore(snapshot: unknown): void {
    const parsed = asTerminalsSnapshot(snapshot);
    if (parsed === undefined) {
      return;
    }
    this.items.set(parsed.panes);
    this.activeByOwner.set(parsed.activeByOwner);
    this.activePaneByGroup.set(parsed.activePaneByGroup);
    this.sizesByGroup.set(parsed.sizesByGroup);
    this.counter = parsed.panes.reduce(
      (highest, pane) => Math.max(highest, numericSuffix(pane.id)),
      this.counter,
    );
  }

  /** Mints a pane; without a group it starts its own terminal. */
  private mint(owner: string | undefined, group: string | undefined): TerminalInstance {
    this.counter += 1;
    const id = `term-${this.counter}`;
    const fallbackTitle = `Terminal ${this.counter}`;
    const pane: TerminalInstance = { id, owner, group: group ?? id, title: fallbackTitle, fallbackTitle };
    this.items.update((list) => [...list, pane]);
    this.setActivePane(pane.group, id);
    return pane;
  }

  /** The terminal ids of an owner, in chip order. */
  private groupIds(owner: string | undefined): string[] {
    const order: string[] = [];
    for (const pane of this.items()) {
      if (pane.owner === owner && !order.includes(pane.group)) {
        order.push(pane.group);
      }
    }
    return order;
  }

  private setActive(owner: string | undefined, id: string | undefined): void {
    this.activeByOwner.update((record) => ({ ...record, [keyOf(owner)]: id }));
  }

  private setActivePane(group: string, id: string | undefined): void {
    this.activePaneByGroup.update((record) => ({ ...record, [group]: id }));
  }
}

function keyOf(owner: string | undefined): string {
  return owner ?? '';
}

/** The `N` in `term-N`; 0 when the id is not one this store minted. */
function numericSuffix(id: string): number {
  const match = /^term-(\d+)$/.exec(id);
  return match === null ? 0 : Number.parseInt(match[1]!, 10);
}

/**
 * Validates a saved terminals layout. A pane without an id or a group is
 * meaningless (nothing to mount, nothing to split), so it is dropped; the maps
 * are kept only where their keys still name a surviving pane or group.
 */
function asTerminalsSnapshot(value: unknown): TerminalsSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const rawPanes = candidate['panes'];
  if (!Array.isArray(rawPanes)) {
    return undefined;
  }
  const panes = rawPanes.flatMap<TerminalInstance>((entry) => {
    const pane = asTerminalInstance(entry);
    return pane === undefined ? [] : [pane];
  });
  const groups = new Set(panes.map((pane) => pane.group));
  const owners = new Set(panes.map((pane) => keyOf(pane.owner)));
  return {
    panes,
    activeByOwner: filterMap(candidate['activeByOwner'], (key) => owners.has(key)),
    activePaneByGroup: filterMap(candidate['activePaneByGroup'], (key) => groups.has(key)),
    sizesByGroup: filterSizes(candidate['sizesByGroup'], groups),
  };
}

function asTerminalInstance(value: unknown): TerminalInstance | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate['id'];
  const group = candidate['group'];
  const title = candidate['title'];
  const fallbackTitle = candidate['fallbackTitle'];
  if (
    typeof id !== 'string' ||
    typeof group !== 'string' ||
    typeof title !== 'string' ||
    typeof fallbackTitle !== 'string'
  ) {
    return undefined;
  }
  const owner = candidate['owner'];
  const custom = candidate['custom'];
  const auto = candidate['auto'];
  const cwd = candidate['cwd'];
  return {
    id,
    group,
    title,
    fallbackTitle,
    owner: typeof owner === 'string' ? owner : undefined,
    ...(typeof custom === 'string' ? { custom } : {}),
    ...(typeof auto === 'string' ? { auto } : {}),
    ...(typeof cwd === 'string' ? { cwd } : {}),
  };
}

/** A `Record<string, string|undefined>` with the entries whose key is still live. */
function filterMap(
  value: unknown,
  keep: (key: string) => boolean,
): Record<string, string | undefined> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!keep(key)) {
      continue;
    }
    result[key] = typeof entry === 'string' ? entry : undefined;
  }
  return result;
}

/** The pane widths, kept only for a group that survived, and only as numbers. */
function filterSizes(value: unknown, groups: Set<string>): Record<string, number[]> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, number[]> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!groups.has(key) || !Array.isArray(entry)) {
      continue;
    }
    const sizes = entry.filter((size): size is number => typeof size === 'number');
    if (sizes.length === entry.length && sizes.length > 0) {
      result[key] = sizes;
    }
  }
  return result;
}
