import { Injectable, computed, inject, signal } from '@angular/core';
import { WorkspaceTabs } from './workspace-tabs';

/** A tool the bottom panel can show as a chip. Adding one is a line in the registry. */
export interface PanelView {
  id: string;
  label: string;
}

/**
 * A small action the panel bar offers while a tool is open (the terminal's `+`).
 * The tool registers it, so the panel stays generic — it only renders what the
 * active tool asked for.
 */
export interface PanelAction {
  label: string;
  title: string;
  run(): void;
}

/**
 * One session's panel state: which tool it shows, whether it is open, and whether
 * it is full screen. The panel folds per session, so opening the terminal in one
 * conversation does not open it in every other one.
 */
export interface PanelOwnerSnapshot {
  view?: string;
  expanded: boolean;
  full: boolean;
}

/**
 * The panel as a saved layout keeps it: every session's own state, plus the one
 * height they share (a window preference, not a per-conversation one).
 */
export interface PanelSnapshot {
  owners: Record<string, PanelOwnerSnapshot>;
  height?: number;
}

const PANEL_HEIGHT_KEY = 'morse.panel.height';
const PANEL_OWNERS_KEY = 'morse.panel.owners';
const PANEL_MIN_HEIGHT = 120;
const PANEL_MAX_HEIGHT = 900;
/** Height when the panel has never been dragged: enough for a prompt and output. */
export const PANEL_DEFAULT_HEIGHT = 260;

function clampHeight(px: number): number {
  return Math.round(Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, px)));
}

function readHeight(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(PANEL_HEIGHT_KEY);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? clampHeight(value) : undefined;
  } catch {
    return undefined;
  }
}

function storeHeight(px: number): void {
  try {
    globalThis.localStorage?.setItem(PANEL_HEIGHT_KEY, String(px));
  } catch {
    // Storage is a nicety, not a requirement: the signal still holds the state.
  }
}

/** One owner's state, with anything that is not a boolean/string dropped. */
function asOwnerSnapshot(value: unknown): PanelOwnerSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const view = candidate['view'];
  return {
    ...(typeof view === 'string' && view.length > 0 ? { view } : {}),
    expanded: candidate['expanded'] === true,
    full: candidate['full'] === true,
  };
}

/** A whole owners map, dropping entries that are not objects. */
function asOwners(value: unknown): Record<string, PanelOwnerSnapshot> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const owners: Record<string, PanelOwnerSnapshot> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const parsed = asOwnerSnapshot(entry);
    if (parsed !== undefined) {
      owners[key] = parsed;
    }
  }
  return owners;
}

function readOwners(): Record<string, PanelOwnerSnapshot> {
  try {
    const raw = globalThis.localStorage?.getItem(PANEL_OWNERS_KEY);
    return raw === null || raw === undefined ? {} : asOwners(JSON.parse(raw));
  } catch {
    return {};
  }
}

function storeOwners(owners: Record<string, PanelOwnerSnapshot>): void {
  try {
    globalThis.localStorage?.setItem(PANEL_OWNERS_KEY, JSON.stringify(owners));
  } catch {
    // As above.
  }
}

/**
 * A saved panel state. A layout written before panel state was per-session has
 * no `owners`: its one open/collapsed choice is returned as `legacy`, to be
 * attributed to the conversation in front when it is restored.
 */
function asPanelSnapshot(
  value: unknown,
): (PanelSnapshot & { legacy?: PanelOwnerSnapshot }) | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const height = candidate['height'];
  const hasHeight = typeof height === 'number' && Number.isFinite(height);
  const owners = candidate['owners'];
  if (typeof owners === 'object' && owners !== null) {
    return { owners: asOwners(owners), ...(hasHeight ? { height: height as number } : {}) };
  }
  const legacy = asOwnerSnapshot(candidate);
  return {
    owners: {},
    ...(legacy !== undefined ? { legacy } : {}),
    ...(hasHeight ? { height: height as number } : {}),
  };
}

/**
 * The browser host's bottom panel: a VS Code-style strip below the composer that
 * starts folded to its chip row and can be dragged taller. Shell state, kept out
 * of `MorseService`, which only knows the wire protocol.
 *
 * The fold, the chosen tool and full screen are **per session** (keyed by
 * `WorkspaceTabs.composerKey`), because the terminals themselves are per session:
 * opening the terminal in one conversation must not open it in every other one.
 * The dragged height stays shared — it is a window preference, not a property of
 * the conversation.
 *
 * Only the state lives here; the registry of views (and their components) lives
 * with the panel itself, so `core` never imports a feature.
 */
@Injectable({ providedIn: 'root' })
export class PanelState {
  private readonly tabs = inject(WorkspaceTabs);
  private readonly owners = signal<Record<string, PanelOwnerSnapshot>>(readOwners());
  private readonly heightSignal = signal<number | undefined>(readHeight());
  /** Actions each tool registered for the bar, keyed by the tool id. */
  private readonly registered = signal<Record<string, PanelAction[]>>({});

  /** The conversation the panel belongs to; `''` when there is none yet. */
  private readonly ownerKey = computed(() => this.tabs.composerKey() ?? '');
  private readonly mine = computed<PanelOwnerSnapshot | undefined>(
    () => this.owners()[this.ownerKey()],
  );

  readonly activeView = computed(() => this.mine()?.view);
  readonly expanded = computed(() => this.mine()?.expanded === true);
  /** `undefined` keeps the default from `styles.css`/`PANEL_DEFAULT_HEIGHT`. */
  readonly height = this.heightSignal.asReadonly();
  /** Full screen: the panel takes the whole conversation column. Only ever with a tool open. */
  readonly full = computed(() => this.mine()?.full === true && this.expanded());
  /** The active tool's bar actions — the terminal's `+`, when it is open. */
  readonly actions = computed(() => {
    const view = this.activeView();
    return view === undefined ? [] : (this.registered()[view] ?? []);
  });

  /** A tool publishes its bar actions while it is mounted. */
  registerActions(view: string, actions: PanelAction[]): void {
    this.registered.update((map) => ({ ...map, [view]: actions }));
  }

  /** A tool takes its bar actions back when it unmounts. */
  clearActions(view: string): void {
    this.registered.update((map) => {
      if (!(view in map)) {
        return map;
      }
      const next = { ...map };
      delete next[view];
      return next;
    });
  }

  /**
   * A chip click: opens that view in the session in front, or folds it back if it
   * was already the open one — the same toggle VS Code's panel titles have.
   */
  toggle(view: string): void {
    const key = this.ownerKey();
    const current = this.owners()[key];
    if (current?.view === view && current.expanded) {
      this.patch(key, { view, expanded: false, full: false });
      return;
    }
    this.patch(key, { view, expanded: true });
  }

  collapse(): void {
    const key = this.ownerKey();
    if (this.owners()[key] === undefined) {
      return;
    }
    this.patch(key, { expanded: false, full: false });
  }

  /** The bar's full-screen button: the panel takes the whole conversation column. */
  toggleFull(): void {
    const key = this.ownerKey();
    const current = this.owners()[key];
    // Full only makes sense with a tool open; the caller opens one first.
    if (current?.expanded !== true) {
      return;
    }
    this.patch(key, { full: !current.full });
  }

  /** Drag-to-resize from the panel's top edge; clamped to a usable range. */
  setHeight(px: number, persist = true): void {
    const next = clampHeight(px);
    this.heightSignal.set(next);
    if (persist) {
      storeHeight(next);
    }
  }

  /** Double-clicking the edge restores the default height. */
  resetHeight(): void {
    this.heightSignal.set(undefined);
    try {
      globalThis.localStorage?.removeItem(PANEL_HEIGHT_KEY);
    } catch {
      // As above: the signal is the truth for this session either way.
    }
  }

  /**
   * The panel's state for the saved layout: every session's fold/tool/full, plus
   * the shared height it was dragged to. An absent height keeps the default.
   */
  snapshot(): PanelSnapshot {
    return {
      owners: this.owners(),
      ...(this.heightSignal() !== undefined ? { height: this.heightSignal() } : {}),
    };
  }

  /**
   * Applies a saved panel state. It is written through the same storage the
   * manual controls use, so a later reload without the host still sees the last
   * choice rather than jumping back to the defaults.
   */
  restore(snapshot: unknown): void {
    const parsed = asPanelSnapshot(snapshot);
    if (parsed === undefined) {
      return;
    }
    const owners = { ...parsed.owners };
    if (parsed.legacy !== undefined) {
      // A layout from before per-session panel state: attribute its one choice
      // to the conversation in front now, the one it could have meant.
      owners[this.ownerKey()] = parsed.legacy;
    }
    this.owners.set(owners);
    storeOwners(owners);
    if (parsed.height !== undefined) {
      this.setHeight(parsed.height);
    }
  }

  /** Writes one owner's state, merging over what it already had. */
  private patch(key: string, change: Partial<PanelOwnerSnapshot>): void {
    this.owners.update((map) => ({
      ...map,
      [key]: { ...(map[key] ?? { expanded: false, full: false }), ...change },
    }));
    storeOwners(this.owners());
  }
}
