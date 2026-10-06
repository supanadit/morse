import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MorseService } from '../../core/morse.service';
import { PanelState } from '../../core/panel-state';
import { TerminalStore, type TerminalGroup, type TerminalInstance } from '../../core/terminal-store';
import { WorkspaceTabs } from '../../core/workspace-tabs';
import { Terminal } from './terminal';

/**
 * The bottom panel's terminal tool: a chip per terminal, and every pane's
 * emulator mounted behind it. Terminals belong to the session in front
 * (`WorkspaceTabs.composerKey`), so switching sessions swaps the chips while the
 * other sessions' shells keep running — a terminal is never shared, and all of
 * them are dropped when their session tab closes.
 *
 * A terminal can be split: the chip then stands for every pane in the split
 * (`Terminal 1 (2)`), the panes share the screen area side by side, and a compact
 * side list appears so each pane has a name and a close button.
 */
@Component({
  selector: 'morse-terminal-view',
  imports: [Terminal],
  templateUrl: './terminal-view.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: flex;
        flex: 1;
        min-width: 0;
        min-height: 0;
      }
      .terminal-view {
        display: flex;
        flex: 1;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
      }
      /* The terminal chips, styled like the session strip's quoted-file chips. */
      .tabbar {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: none;
        min-height: 30px;
        padding: 4px 6px 4px 8px;
        border-bottom: 1px solid var(--morse-border);
        background: var(--morse-panel, var(--morse-bg));
      }
      .tabs {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
        min-width: 0;
        overflow-x: auto;
        scrollbar-width: none;
      }
      .tabs::-webkit-scrollbar {
        display: none;
      }
      .ttab {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: none;
        height: 22px;
        max-width: 190px;
        padding: 0 4px 0 8px;
        border: 1px solid var(--morse-border);
        border-radius: 999px;
        background: var(--morse-bubble, var(--morse-hover));
        color: var(--morse-fg-muted);
        font: inherit;
        font-size: 11.5px;
        cursor: pointer;
      }
      .ttab:hover {
        background: var(--morse-hover);
        border-color: var(--morse-accent);
        color: var(--morse-fg);
      }
      .ttab.active {
        border-color: var(--morse-accent);
        background: color-mix(in srgb, var(--morse-accent) 22%, transparent);
        color: var(--morse-fg);
      }
      .ttab .glyph {
        flex: none;
        color: var(--morse-accent);
        font-size: 9px;
        line-height: 1;
      }
      .ttab .label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* The split count is its own badge, so a long title cannot ellipsize it. */
      .ttab .count {
        flex: none;
        color: var(--morse-accent);
        font-size: 10.5px;
      }
      /* The inline rename field replaces the label in place, so the tab keeps its width. */
      .ttab .rename {
        width: 90px;
        min-width: 0;
        height: 18px;
        padding: 0 4px;
        border: 1px solid var(--morse-accent);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-bg);
        color: var(--morse-fg);
        font: inherit;
        font-size: inherit;
      }
      .ttab .rename:focus {
        outline: none;
      }
      .ttab .close,
      .pane-tab .close {
        flex: none;
        width: 15px;
        height: 15px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: 999px;
        background: none;
        color: var(--morse-fg-muted);
        font-size: 11px;
        line-height: 1;
        cursor: pointer;
        opacity: 0;
      }
      .ttab:hover .close,
      .ttab.active .close,
      .pane-tab:hover .close,
      .pane-tab.active .close {
        opacity: 1;
      }
      .ttab .close:hover:not(:disabled),
      .pane-tab .close:hover:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      /* The split button: divide the terminal in front into another pane. */
      .split-button {
        flex: none;
        width: 22px;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        cursor: pointer;
      }
      .split-button:hover:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .split-button svg {
        width: 15px;
        height: 15px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.3;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      /*
       * The split's own tab row: a chip per pane of the terminal in front, under
       * the panes, so each shell has a name and a close button without a sidebar.
       */
      .pane-strip {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 28px;
        padding: 3px 8px;
        border-top: 1px solid var(--morse-border);
        background: var(--morse-panel, var(--morse-bg));
        overflow-x: auto;
        scrollbar-width: none;
      }
      .pane-strip::-webkit-scrollbar {
        display: none;
      }
      .pane-tab {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: none;
        height: 22px;
        max-width: 190px;
        padding: 0 4px 0 8px;
        border: 1px solid var(--morse-border);
        border-radius: 999px;
        background: var(--morse-bubble, var(--morse-hover));
        color: var(--morse-fg-muted);
        font-size: 11.5px;
        cursor: pointer;
      }
      .pane-tab:hover {
        background: var(--morse-hover);
        border-color: var(--morse-accent);
        color: var(--morse-fg);
      }
      .pane-tab.active {
        border-color: var(--morse-accent);
        background: color-mix(in srgb, var(--morse-accent) 22%, transparent);
        color: var(--morse-fg);
      }
      .pane-tab .glyph {
        flex: none;
        color: var(--morse-accent);
        font-size: 9px;
        line-height: 1;
      }
      .pane-tab .label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .screens {
        position: relative;
        display: flex;
        flex: 1;
        min-width: 0;
        min-height: 0;
      }
      /* One chip's panes; a hidden group keeps its shells, it only loses space. */
      .group {
        flex: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
      }
      .group.hidden {
        display: none;
      }
      /* A pane of a split; the panes of a group share the screen area. */
      .pane {
        flex: 1 1 0;
        min-width: 0;
        min-height: 0;
        display: flex;
      }
      /* The draggable seam between two panes: the width trade happens here. */
      .splitter {
        position: relative;
        flex: none;
        width: 6px;
        cursor: col-resize;
        touch-action: none;
      }
      .splitter::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: 50%;
        width: 1px;
        background: var(--morse-border);
      }
      .splitter:hover::before,
      .splitter:active::before {
        width: 2px;
        left: calc(50% - 0.5px);
        background: var(--morse-accent);
      }
      .empty {
        margin: auto;
        padding: 12px;
        color: var(--morse-fg-muted);
        font-size: 12px;
      }
    `,
  ],
})
export class TerminalView {
  private readonly store = inject(TerminalStore);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly panel = inject(PanelState);
  private readonly morse = inject(MorseService);
  private readonly destroyRef = inject(DestroyRef);

  /** The session the panel is showing; terminals belong to it, not to the app. */
  protected readonly owner = this.tabs.composerKey;
  /** The chips of the session in front. */
  protected readonly mine = computed(() =>
    this.store.groups().filter((group) => group.owner === this.owner()),
  );
  /** The terminal in front, whose panes own the screen area. */
  protected readonly activeGroup = computed(() =>
    this.mine().find((group) => group.id === this.store.activeFor(this.owner())),
  );
  /** The panes of a split terminal, or `[]` when the terminal is not split. */
  protected readonly splitPanes = computed(() => {
    const group = this.activeGroup();
    return group !== undefined && group.panes.length > 1 ? group.panes : [];
  });
  /** Every pane in every session stays mounted (its PTY lives); only one group shows. */
  protected readonly all = this.store.terminals;
  /** Every chip, across sessions: what keeps the hidden groups' shells alive. */
  protected readonly allGroups = this.store.groups;
  /** The chip whose rename field is open, if any. */
  protected readonly editingId = signal<string | undefined>(undefined);
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');

  constructor() {
    // The `+` lives in the panel bar next to the tool chip ("Terminal +"), so
    // the terminal's own row is only the chips of the terminals that are open.
    this.panel.registerActions('terminal', [
      { label: '+', title: 'New terminal', run: () => this.add() },
    ]);
    this.destroyRef.onDestroy(() => this.panel.clearActions('terminal'));
    // The rename field only exists after the render that opened it: focus and
    // select it then, so double-clicking a tab is immediately typing.
    effect(() => {
      const input = this.renameInput();
      if (input !== undefined) {
        input.nativeElement.focus();
        input.nativeElement.select();
      }
    });
  }

  protected add(): void {
    this.store.open(this.owner());
  }

  /** Splits the terminal in front: a second shell beside the first. */
  protected split(): void {
    const group = this.activeGroup();
    if (group !== undefined) {
      this.store.split(group.id);
    }
  }

  /**
   * Drags the seam after pane `index`: the two panes either side trade width and
   * keep their sum, so the rest of the split never moves. Frame-coalesced, and
   * the choice is written once when the drag ends.
   */
  protected startResize(group: TerminalGroup, index: number, event: PointerEvent): void {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const container = handle.parentElement;
    const width = container?.getBoundingClientRect().width ?? 0;
    if (container === null || width <= 0) {
      return;
    }
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic event (a test) has no pointer to capture; the listeners on
      // the handle still see the moves.
    }
    const startX = event.clientX;
    const start = [...group.sizes];
    const min = 0.08;
    let frame = 0;
    let pending = start;
    const apply = (): void => {
      frame = 0;
      this.store.setSizes(group.id, pending);
    };
    const move = (moveEvent: PointerEvent): void => {
      const pair = start[index]! + start[index + 1]!;
      const delta = (moveEvent.clientX - startX) / width;
      const left = Math.min(pair - min, Math.max(min, start[index]! + delta));
      pending = start.map((size, i) =>
        i === index ? left : i === index + 1 ? pair - left : size,
      );
      if (frame === 0) {
        frame = requestAnimationFrame(apply);
      }
    };
    const stop = (): void => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        apply();
      }
      this.store.setSizes(group.id, pending);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  /** A terminal chip was clicked: bring its active pane in front. */
  protected select(group: TerminalGroup): void {
    this.store.focus(group.activePane);
  }
  protected close(group: TerminalGroup, event: Event): void {
    event.stopPropagation();
    this.closeById(group.id);
  }

  /**
   * Ends a terminal: every pane in its split, and its host shell with it. The
   * store only holds the layout, so the `terminal/close` is sent here — never on
   * unmount, which is what lets a hidden panel or a session switch keep the shell.
   */
  private closeById(id: string): void {
    const group = this.allGroups().find((entry) => entry.id === id);
    if (group === undefined) {
      return;
    }
    for (const pane of group.panes) {
      this.morse.closeTerminal(pane.id);
    }
    this.store.close(id);
  }

  protected closePane(pane: TerminalInstance, event: Event): void {
    event.stopPropagation();
    this.morse.closeTerminal(pane.id);
    this.store.closePane(pane.id);
  }

  protected focusPane(pane: TerminalInstance): void {
    this.store.focus(pane.id);
  }

  /** Middle-click closes a terminal tab, like the session strip. */
  protected onAuxClick(id: string, event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
      this.closeById(id);
    }
  }

  /** The shell named a pane (OSC 0/2): follow it unless the chip was renamed. */
  protected onTitleChange(paneId: string, title: string): void {
    const pane = this.all().find((entry) => entry.id === paneId);
    if (pane !== undefined && this.editingId() === pane.group) {
      return;
    }
    this.store.setAutoTitle(paneId, title);
  }

  /**
   * The shell reported its directory (OSC 7): remember it on the pane, so a
   * restored shell reopens where the reader `cd`'d instead of the session root.
   */
  protected onCwdChange(paneId: string, cwd: string): void {
    this.store.setCwd(paneId, cwd);
  }

  /** Double-clicking a chip opens its rename field, like a tab strip. */
  protected beginRename(id: string, event: Event): void {
    event.stopPropagation();
    this.editingId.set(id);
  }

  protected onRenameKey(id: string, event: KeyboardEvent): void {
    const input = event.target as HTMLInputElement;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitRename(id, input.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.editingId.set(undefined);
    }
  }

  /** Enter or a blur away commits; the empty guard drops a blur that escape caused. */
  protected commitRename(id: string, name: string): void {
    if (this.editingId() !== id) {
      return;
    }
    this.editingId.set(undefined);
    this.store.rename(id, name);
  }
}
