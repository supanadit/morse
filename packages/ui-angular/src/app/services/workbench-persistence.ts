import { DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { ComposerDrafts, type DraftsSnapshot } from '../state/composer-drafts';
import { MorseService } from '../host/morse.service';
import { PanelState, type PanelSnapshot } from '../state/panel-state';
import { TerminalStore, type TerminalsSnapshot } from '../state/terminal-store';
import { WorkspaceTabs, type TabsSnapshot } from '../state/workspace-tabs';

/**
 * The schema version of the layout this frontend writes (`workbench.json`). It
 * must match the `version` the host stored; a mismatch is ignored (the frontend
 * starts clean and overwrites it), which is what lets a later build change the
 * inner shape without a migration it cannot trust.
 */
export const WORKBENCH_VERSION = 1;
/** The schema version of the drafts this frontend writes (`drafts.json`). */
export const DRAFTS_VERSION = 1;

/** The frontend's own layout shape, opaque to the host (see `WorkbenchSnapshot`). */
export interface WorkbenchData {
  tabs: TabsSnapshot;
  terminals: TerminalsSnapshot;
  panel: PanelSnapshot;
}

/** How long a change waits before it is written: a burst of tab edits is one save. */
const SAVE_DEBOUNCE_MS = 350;
/**
 * A draft is rewritten as the reader types, so it waits a longer beat — a draft
 * can carry inline images, and one save per pause is plenty.
 */
const DRAFTS_DEBOUNCE_MS = 700;
/** How long after a restore the front tab stays the restored one without a host session. */
const RESTORE_GRACE_MS = 2_500;

type Slot = 'layout' | 'drafts';

/**
 * Persists the host's shell state under its own data directory: the open/focused
 * tabs, the bottom panel and its terminals (`workbench.json`), and the half-written
 * prompts — text, pins and attachments — per tab (`drafts.json`), so opening the
 * shell again lands the reader on the tab they left, with their words intact and a
 * `morse stop`, a closed laptop or a VS Code restart losing nothing.
 *
 * The frontend owns the schema, the host only stores the envelope (see
 * `capabilities.workbench`). The browser host points it at `<MORSE_HOME>`, the VS
 * Code extension at its per-workspace `storageUri`, so a reopened window restores
 * the session that was in front instead of starting empty.
 *
 * A restore is applied before the write watches start, and the state just written
 * is remembered so the first effect run does not immediately save it back.
 */
@Injectable({ providedIn: 'root' })
export class WorkbenchPersistence {
  private readonly morse = inject(MorseService);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly terminals = inject(TerminalStore);
  private readonly panel = inject(PanelState);
  private readonly drafts = inject(ComposerDrafts);
  private readonly destroyRef = inject(DestroyRef);

  /** False until the first load has been attempted (successful or not). */
  private readonly ready = signal(false);
  /** True while a load is in flight, so the write watches stay quiet. */
  private readonly loading = signal(false);
  private started = false;
  /** The last state written per slot, so an unchanged one is not re-sent. */
  private readonly lastWritten = new Map<Slot, string>();
  private readonly timers = new Map<Slot, ReturnType<typeof setTimeout>>();
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Capabilities arrive with the handshake: a host that persists shell state
    // announces it, and only then is there a file to read or write.
    effect(() => {
      const connected = this.morse.connection() === 'ready';
      const capable = this.morse.capabilities()?.workbench === true;
      if (connected && capable && !this.started) {
        this.started = true;
        void this.load();
      }
    });

    // The write watches. Building a snapshot reads every signal that slot is made
    // of, so any change — a tab opened, a terminal renamed, the panel dragged, a
    // prompt typed — schedules one debounced save for its slot.
    effect(() => {
      const snapshot = this.buildLayout();
      if (!this.ready() || this.loading()) {
        return;
      }
      this.schedule('layout', snapshot);
    });
    effect(() => {
      const snapshot = this.buildDrafts();
      if (!this.ready() || this.loading()) {
        return;
      }
      this.schedule('drafts', snapshot);
    });

    if (typeof document !== 'undefined') {
      // A tab switched and the page closed before the debounce fired still has to
      // be remembered: flush when the page is hidden or unloaded.
      const flush = (): void => this.flush();
      const onVisibility = (): void => {
        if (document.visibilityState === 'hidden') {
          flush();
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', flush);
      this.destroyRef.onDestroy(() => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', flush);
      });
    }
    this.destroyRef.onDestroy(() => this.clearTimers());
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const [layout, drafts] = await Promise.all([
        this.morse.requestHostCommand('readWorkbench'),
        this.morse.requestHostCommand('readDrafts'),
      ]);
      const layoutData = asWorkbenchData(layout);
      if (layoutData !== undefined) {
        this.apply(layoutData);
      }
      const draftsData = asDraftsData(drafts);
      if (draftsData !== undefined) {
        this.drafts.restore(draftsData);
      }
      // The state now on screen *is* what a save would write; remember it so the
      // first write-watch run does not send it straight back.
      this.remember('layout', this.buildLayout());
      this.remember('drafts', this.buildDrafts());
    } finally {
      this.loading.set(false);
      this.ready.set(true);
    }
  }

  private apply(data: WorkbenchData): void {
    // The panel first: it decides whether the terminal tool is mounted at all,
    // and a restored terminal only opens a shell once that tool is on screen.
    this.panel.restore(data.panel);
    // A restored shell opens where the session it belongs to works, even when the
    // saved pane predates the directory being written on it.
    this.terminals.restore(terminalsWithOwnerCwd(data.terminals, data.tabs));
    this.tabs.restore(data.tabs);
    // The session the host reattached may not have been in the saved layout (a
    // session opened on another browser, say). It stays a tab — without stealing
    // the restored front — so the strip never loses the session it is showing.
    const host = this.morse.state();
    if (
      host.sessionId !== undefined &&
      !this.tabs
        .tabs()
        .some((tab) => tab.kind === 'session' && tab.id === host.sessionId)
    ) {
      this.tabs.ensureSession({
        id: host.sessionId,
        title: host.sessionTitle ?? 'New session',
        cwd: host.workspace?.cwd,
      });
    }
    // A session the layout left in front is not necessarily the one the host
    // reattached (or the host may have no session at all), so ask for it.
    const active = this.tabs.activeTab();
    if (active?.kind === 'session' && active.draft !== true) {
      if (active.id !== this.morse.state().sessionId) {
        this.morse.activateSession(active.id, active.cwd);
      }
    }
    // A restored *file* tab has no session of its own to activate, so the hold on
    // the front tab is released after a short grace instead of waiting forever
    // for a `showSession` that a host with no open session will never send.
    this.graceTimer = setTimeout(() => this.tabs.endRestore(), RESTORE_GRACE_MS);
  }

  /**
   * The layout as it is right now. A terminal pane gains its session's directory
   * here (a live pane does not carry one), so the restored shell opens where the
   * session it belongs to works, even before that session is in front.
   */
  private buildLayout(): { version: number; data: WorkbenchData } {
    const tabs = this.tabs.snapshot();
    const terminals = this.terminals.snapshot();
    return {
      version: WORKBENCH_VERSION,
      data: {
        tabs,
        terminals: terminalsWithOwnerCwd(terminals, tabs),
        panel: this.panel.snapshot(),
      },
    };
  }

  /** The half-written prompts of every tab, exactly as the composer stores them. */
  private buildDrafts(): { version: number; data: DraftsSnapshot } {
    return { version: DRAFTS_VERSION, data: this.drafts.snapshot() };
  }

  private schedule(slot: Slot, snapshot: { version: number; data: unknown }): void {
    const pending = this.timers.get(slot);
    if (pending !== undefined) {
      clearTimeout(pending);
    }
    const delay = slot === 'drafts' ? DRAFTS_DEBOUNCE_MS : SAVE_DEBOUNCE_MS;
    this.timers.set(
      slot,
      setTimeout(() => {
        this.timers.delete(slot);
        this.writeNow(slot, snapshot);
      }, delay),
    );
  }

  private writeNow(slot: Slot, snapshot: { version: number; data: unknown }): void {
    const serialized = JSON.stringify(snapshot.data);
    if (serialized === this.lastWritten.get(slot)) {
      return;
    }
    this.lastWritten.set(slot, serialized);
    const command = slot === 'drafts' ? 'saveDrafts' : 'saveWorkbench';
    void this.morse.requestHostCommand(command, {
      version: snapshot.version,
      data: snapshot.data,
    });
  }

  /** Remembers the state on screen as the last written one, without writing it. */
  private remember(slot: Slot, snapshot: { version: number; data: unknown }): void {
    this.lastWritten.set(slot, JSON.stringify(snapshot.data));
  }

  private flush(): void {
    if (!this.ready() || this.loading()) {
      return;
    }
    // A pending debounce captured an older state; writing the current one must
    // cancel it, or it would fire later and regress the file.
    this.clearTimers();
    this.writeNow('layout', this.buildLayout());
    this.writeNow('drafts', this.buildDrafts());
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }
}

/**
 * A terminal pane keeps its own directory when it has one — the shell reported
 * it with OSC 7, so it is where the reader actually `cd`'d — and falls back to
 * its owner session's directory for a pane saved before that was tracked.
 */
function terminalsWithOwnerCwd(
  terminals: TerminalsSnapshot,
  tabs: TabsSnapshot,
): TerminalsSnapshot {
  const cwdByOwner = new Map<string, string | undefined>();
  for (const tab of tabs.tabs) {
    if (tab.kind === 'session') {
      cwdByOwner.set(tab.id, tab.cwd);
    }
  }
  return {
    ...terminals,
    panes: terminals.panes.map((pane) => {
      if (pane.owner === undefined) {
        return pane;
      }
      const cwd = pane.cwd ?? cwdByOwner.get(pane.owner);
      return cwd === undefined ? pane : { ...pane, cwd };
    }),
  };
}

/**
 * Validates the layout envelope the host stored. A version this build cannot read
 * is discarded rather than guessed at; the next save replaces it.
 */
function asWorkbenchData(value: unknown): WorkbenchData | undefined {
  const data = unwrap(value, WORKBENCH_VERSION);
  if (data === undefined) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (
    typeof record['tabs'] !== 'object' ||
    record['tabs'] === null ||
    typeof record['terminals'] !== 'object' ||
    record['terminals'] === null ||
    typeof record['panel'] !== 'object' ||
    record['panel'] === null
  ) {
    return undefined;
  }
  return data as WorkbenchData;
}

/**
 * Validates the drafts envelope enough to hand it to `ComposerDrafts.restore`,
 * which does the field-level validation itself. A version mismatch is ignored.
 */
function asDraftsData(value: unknown): DraftsSnapshot | undefined {
  const data = unwrap(value, DRAFTS_VERSION);
  return data === undefined ? undefined : (data as DraftsSnapshot);
}

/** The `data` of a `{ version, data }` envelope, when the version matches. */
function unwrap(value: unknown, version: number): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope['version'] !== version) {
    return undefined;
  }
  const data = envelope['data'];
  return typeof data === 'object' && data !== null ? data : undefined;
}
