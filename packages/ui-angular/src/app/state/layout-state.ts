import { Injectable, computed, signal } from '@angular/core';

/**
 * The regions the shell lays out. A region is a band of the window or a column in one.
 */
export type RegionId = 'toolbar' | 'left' | 'main' | 'right' | 'status';

/**
 * A pane that stays where it is but can be made taller: the Explorer, and the git panel's
 * Changes section. Not regions — they are sized, never placed — but they are dragged the
 * same way, so their size is remembered in the same place (`setSize`, `size`).
 */
export type PaneId = 'explorer' | 'changes';

/** Everything whose size the reader can drag: a column's width, a pane's height. */
export type SizeId = RegionId | PaneId;

export interface Region {
  readonly id: RegionId;
  /**
   * Whether the region is taking space. A hidden region keeps its place in the order and
   * its size, so showing it again is what it was.
   */
  readonly visible: boolean;
  /** The width the reader dragged the region to, in px; `undefined` is the CSS default. */
  readonly size?: number;
}

/**
 * The shell's layout, as three bands of regions.
 *
 * The bands are what the window is: chrome above the columns (a toolbar), the columns
 * themselves, chrome below them (a status bar, and the panel that VS Code puts there).
 * They are not more fields on a type — the columns are a list, so a fourth one is data,
 * and so is a band's own contents.
 *
 * A dockable split tree (what a docking library stores: a split holds its children and
 * their fractions) is where this goes once a pane can be dragged from one region to
 * another; until then it would be a shape with one instance of it.
 */
export interface Layout {
  /** Chrome above the columns, left to right: the toolbar. */
  readonly top: readonly Region[];
  /** The columns that share the window's width, left to right. */
  readonly columns: readonly Region[];
  /** Chrome below the columns, left to right: the status bar. */
  readonly bottom: readonly Region[];
}

/**
 * The range a side column's width is clamped into. The git panel has used it since it
 * gained a dragged edge; the navigation column wants the same one the day it can be dragged.
 */
const COLUMN_MIN = 220;
const COLUMN_MAX = 1600;

/** The range each pane's height is clamped into, in px. */
const PANE_MIN: Record<PaneId, number> = { explorer: 140, changes: 48 };
const PANE_MAX: Record<PaneId, number> = { explorer: 720, changes: 1200 };

/**
 * The reader's stored layout. These are the keys the shell wrote before there was a model
 * (`morse.navigation.collapsed`, `morse.git.open`, `morse.git.width`, `morse.explorer.height`,
 * `morse.git.changesHeight`), and they stay exactly as they are: a stored layout belongs to
 * the reader, and a rename is a migration nobody asked for.
 */
const NAV_COLLAPSED_KEY = 'morse.navigation.collapsed';
const GIT_PANEL_KEY = 'morse.git.open';

/**
 * Where each region's own facts are remembered. The keys are the ones the shell wrote
 * before there was a model, plus the navigation column's width, which it never had; a
 * stored layout belongs to the reader, so nothing is renamed.
 */
const VISIBLE_KEYS: Partial<Record<RegionId, string>> = {
  left: NAV_COLLAPSED_KEY,
  right: GIT_PANEL_KEY,
};

/** One key per draggable size, region or pane — the reader's stored layout. */
const SIZE_KEYS: Partial<Record<SizeId, string>> = {
  left: 'morse.nav.width',
  right: 'morse.git.width',
  explorer: 'morse.explorer.height',
  changes: 'morse.git.changesHeight',
};

function clampSize(id: SizeId, px: number): number {
  if (id === 'explorer' || id === 'changes') {
    return Math.round(Math.min(PANE_MAX[id], Math.max(PANE_MIN[id], px)));
  }
  return Math.round(Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, px)));
}

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function storeFlag(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? '1' : '0');
  } catch {
    // Storage is a nicety, not a requirement: the signal still holds the state.
  }
}

/** A stored size, clamped to what its kind of box allows. `undefined` is "never dragged". */
function readSize(id: SizeId): number | undefined {
  const key = SIZE_KEYS[id];
  if (key === undefined) {
    return undefined;
  }
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? clampSize(id, value) : undefined;
  } catch {
    return undefined;
  }
}

function storeSize(key: string, px: number | undefined): void {
  try {
    if (px === undefined) {
      // Back to the stylesheet's default: forget, do not remember a default.
      globalThis.localStorage?.removeItem(key);
    } else {
      globalThis.localStorage?.setItem(key, String(px));
    }
  } catch {
    // As above: the signal is the truth for this session either way.
  }
}

/** What the shell starts with when the reader has never touched the layout. */
function initialLayout(): Layout {
  return {
    top: [{ id: 'toolbar', visible: true }],
    columns: [
      { id: 'left', visible: !readFlag(NAV_COLLAPSED_KEY), size: readSize('left') },
      { id: 'main', visible: true },
      { id: 'right', visible: readFlag(GIT_PANEL_KEY), size: readSize('right') },
    ],
    bottom: [{ id: 'status', visible: true }],
  };
}

@Injectable({ providedIn: 'root' })
export class LayoutState {
  private readonly layout = signal<Layout>(initialLayout());
  /**
   * The panes that are sized but never placed. One signal for all of them: they are the
   * same kind of fact, and a pane that never moved does not need a home of its own.
   */
  private readonly panes = signal<Record<PaneId, number | undefined>>({
    explorer: readSize('explorer'),
    changes: readSize('changes'),
  });

  /** Chrome above the columns, left to right: the toolbar. */
  readonly top = computed(() => this.layout().top);
  /** The columns that share the window's width, left to right. */
  readonly columns = computed(() => this.layout().columns);
  /** Chrome below the columns, left to right: the status bar. */
  readonly bottom = computed(() => this.layout().bottom);
  /** Every region, in the order the shell lays them out. */
  readonly regions = computed(() => [
    ...this.layout().top,
    ...this.layout().columns,
    ...this.layout().bottom,
  ]);

  /** The navigation column is folded away, so the conversation takes the whole width. */
  readonly leftCollapsed = computed(() => !this.region('left').visible);
  /** Its dragged width, or `undefined` for the default from `styles.css`. */
  readonly leftSize = computed(() => this.region('left').size);
  /** The browser host's git panel is one of the columns. */
  readonly rightVisible = computed(() => this.region('right').visible);
  /** Its dragged width, or `undefined` for the default from `styles.css`. */
  readonly rightSize = computed(() => this.region('right').size);
  /** The Explorer pane's dragged height, or `undefined` for the CSS default. */
  readonly explorerSize = computed(() => this.panes().explorer);
  /** The git panel's Changes section height, or `undefined` for the CSS default. */
  readonly changesSize = computed(() => this.panes().changes);

  /**
   * One region by id. Every region the shell lays out is always in the list — a region is
   * hidden, never absent — so an unknown id is a mistake worth throwing on rather than a
   * `undefined` that reads as "hidden".
   */
  region(id: RegionId): Region {
    const found = this.layout()
      .top.concat(this.layout().columns, this.layout().bottom)
      .find((region) => region.id === id);
    if (found === undefined) {
      throw new Error(`no region '${id}' in the layout`);
    }
    return found;
  }

  /** One size, region or pane, as the reader left it. `undefined` is the CSS default. */
  size(id: SizeId): number | undefined {
    return id === 'explorer' || id === 'changes' ? this.panes()[id] : this.region(id).size;
  }

  setVisible(id: RegionId, visible: boolean): void {
    this.update(id, (region) => ({ ...region, visible }));
    const key = VISIBLE_KEYS[id];
    // The navigation column stores the opposite: it is remembered as folded.
    if (key !== undefined) {
      storeFlag(key, id === 'left' ? !visible : visible);
    }
  }

  toggleVisible(id: RegionId): void {
    this.setVisible(id, !this.region(id).visible);
  }

  /**
   * `undefined` goes back to the size the stylesheet gives the box — a double-click on a
   * handle asks for exactly that. `persist` is false while a drag is in flight: the size is
   * applied on every frame, but written once, when the drag ends.
   */
  setSize(id: SizeId, px: number | undefined, persist = true): void {
    const size = px === undefined ? undefined : clampSize(id, px);
    if (id === 'explorer' || id === 'changes') {
      this.panes.update((panes) => ({ ...panes, [id]: size }));
    } else {
      this.update(id, (region) => ({ ...region, size }));
    }
    if (!persist) {
      return;
    }
    const key = SIZE_KEYS[id];
    if (key !== undefined) {
      storeSize(key, size);
    }
  }

  private update(id: RegionId, change: (region: Region) => Region): void {
    const band = (regions: readonly Region[]): readonly Region[] =>
      regions.map((region) => (region.id === id ? change(region) : region));
    this.layout.update((layout) => ({
      top: band(layout.top),
      columns: band(layout.columns),
      bottom: band(layout.bottom),
    }));
  }
}
