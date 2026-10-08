import { Injectable, computed, signal } from '@angular/core';

/**
 * The regions the shell lays out, in the order it lays them out.
 *
 * `main` is the fluid one: it takes whatever the fixed regions leave. `left` is the
 * navigation column and `right` is the browser host's git panel; each of those takes a
 * width and can be folded away, and both are remembered across reloads.
 *
 * A list, and not one field per region, because the chrome this shell is growing into — a
 * toolbar, a panel, a status bar — is more entries in this list rather than more fields on
 * a type. Adding one is a change of data.
 *
 * What lives here is the reader's *preference*: the navigation column folded, the git panel
 * open, that column 520px wide. Whether a host can render a region at all is the host's
 * business (`capabilities`), and whether a region is on screen right now is the shell's
 * (there is no session in front, the column is the empty draft). Keeping those three apart
 * is what lets both hosts share this model.
 */
export type RegionId = 'left' | 'main' | 'right';

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
 * The range a side column's width is clamped into. The git panel has used it since it
 * gained a dragged edge; the navigation column wants the same one the day it can be dragged.
 */
const COLUMN_MIN = 220;
const COLUMN_MAX = 1600;

/**
 * The reader's stored layout. These are the keys the shell wrote before there was a model
 * (`morse.navigation.collapsed`, `morse.git.open`, `morse.git.width`), and they stay exactly
 * as they are: a stored layout belongs to the reader, and a rename is a migration nobody
 * asked for.
 */
const NAV_COLLAPSED_KEY = 'morse.navigation.collapsed';
const GIT_PANEL_KEY = 'morse.git.open';
const GIT_WIDTH_KEY = 'morse.git.width';

function clampWidth(px: number): number {
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

function readWidth(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(GIT_WIDTH_KEY);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? clampWidth(value) : undefined;
  } catch {
    return undefined;
  }
}

function storeWidth(px: number | undefined): void {
  try {
    if (px === undefined) {
      globalThis.localStorage?.removeItem(GIT_WIDTH_KEY);
    } else {
      globalThis.localStorage?.setItem(GIT_WIDTH_KEY, String(px));
    }
  } catch {
    // As above: the signal is the truth for this session either way.
  }
}

/** What the shell starts with when the reader has never touched the layout. */
function initialRegions(): readonly Region[] {
  return [
    { id: 'left', visible: !readFlag(NAV_COLLAPSED_KEY) },
    { id: 'main', visible: true },
    { id: 'right', visible: readFlag(GIT_PANEL_KEY), size: readWidth() },
  ];
}

@Injectable({ providedIn: 'root' })
export class LayoutState {
  private readonly layout = signal<readonly Region[]>(initialRegions());

  /** The regions, in layout order. */
  readonly regions = this.layout.asReadonly();

  /** The navigation column is folded away, so the conversation takes the whole width. */
  readonly leftCollapsed = computed(() => !this.region('left').visible);
  /** The browser host's git panel is one of the columns. */
  readonly rightVisible = computed(() => this.region('right').visible);
  /** Its dragged width, or `undefined` for the default from `styles.css`. */
  readonly rightSize = computed(() => this.region('right').size);

  /**
   * One region by id. Every region the shell lays out is always in the list — a region is
   * hidden, never absent — so an unknown id is a mistake worth throwing on rather than a
   * `undefined` that reads as "hidden".
   */
  region(id: RegionId): Region {
    const found = this.layout().find((region) => region.id === id);
    if (found === undefined) {
      throw new Error(`no region '${id}' in the layout`);
    }
    return found;
  }

  setVisible(id: RegionId, visible: boolean): void {
    this.update(id, (region) => ({ ...region, visible }));
    // Each region's facts have their own key, named by the reader's history rather than by
    // this model: the navigation column stores its fold, the git panel its open state.
    if (id === 'left') {
      storeFlag(NAV_COLLAPSED_KEY, !visible);
    }
    if (id === 'right') {
      storeFlag(GIT_PANEL_KEY, visible);
    }
  }

  toggleVisible(id: RegionId): void {
    this.setVisible(id, !this.region(id).visible);
  }

  /**
   * `undefined` goes back to the width the stylesheet gives the region. `persist` is false
   * while a drag is in flight: the width is applied on every frame, but written once, when
   * the drag ends.
   */
  setSize(id: RegionId, px: number | undefined, persist = true): void {
    const size = px === undefined ? undefined : clampWidth(px);
    this.update(id, (region) => ({ ...region, size }));
    if (!persist) {
      return;
    }
    if (id === 'right') {
      storeWidth(size);
    }
  }

  private update(id: RegionId, change: (region: Region) => Region): void {
    this.layout.update((regions) =>
      regions.map((region) => (region.id === id ? change(region) : region)),
    );
  }
}
