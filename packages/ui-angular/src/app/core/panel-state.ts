import { Injectable, computed, signal } from '@angular/core';

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

/** Where the panel's height, open state and chosen chip are remembered. */
const PANEL_HEIGHT_KEY = 'morse.panel.height';
const PANEL_EXPANDED_KEY = 'morse.panel.expanded';
const PANEL_VIEW_KEY = 'morse.panel.view';
const PANEL_MIN_HEIGHT = 120;
const PANEL_MAX_HEIGHT = 900;
/** Height when the panel has never been dragged: enough for a prompt and output. */
export const PANEL_DEFAULT_HEIGHT = 260;

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

function readView(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(PANEL_VIEW_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeView(view: string): void {
  try {
    globalThis.localStorage?.setItem(PANEL_VIEW_KEY, view);
  } catch {
    // As above.
  }
}

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
    // As above.
  }
}

/**
 * The browser host's bottom panel: a VS Code-style strip below the composer that
 * starts folded to its chip row and can be dragged taller. Shell state, kept out
 * of `MorseService`, which only knows the wire protocol.
 *
 * Only the state lives here; the registry of views (and their components) lives
 * with the panel itself, so `core` never imports a feature.
 */
@Injectable({ providedIn: 'root' })
export class PanelState {
  private readonly active = signal<string | undefined>(readView());
  private readonly open = signal(readFlag(PANEL_EXPANDED_KEY));
  private readonly heightSignal = signal<number | undefined>(readHeight());
  /** Actions each tool registered for the bar, keyed by the tool id. */
  private readonly registered = signal<Record<string, PanelAction[]>>({});

  readonly activeView = this.active.asReadonly();
  readonly expanded = this.open.asReadonly();
  /** `undefined` keeps the default from `styles.css`/`PANEL_DEFAULT_HEIGHT`. */
  readonly height = this.heightSignal.asReadonly();
  /** The active tool's bar actions — the terminal's `+`, when it is open. */
  readonly actions = computed(() => {
    const view = this.active();
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
   * A chip click: opens that view, or folds the panel back if it was already the
   * open one — the same toggle VS Code's panel titles have.
   */
  toggle(view: string): void {
    if (this.active() === view && this.open()) {
      this.setExpanded(false);
      return;
    }
    this.active.set(view);
    storeView(view);
    this.setExpanded(true);
  }

  collapse(): void {
    this.setExpanded(false);
  }

  /** Drag-to-resize from the panel's top edge; clamped to a usable range. */
  setHeight(px: number): void {
    const next = clampHeight(px);
    this.heightSignal.set(next);
    storeHeight(next);
  }

  private setExpanded(expanded: boolean): void {
    this.open.set(expanded);
    storeFlag(PANEL_EXPANDED_KEY, expanded);
  }
}
