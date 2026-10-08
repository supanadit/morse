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
import { MorseService } from '../../../host/morse.service';
import { PanelState } from '../../../state/panel-state';
import { TerminalStore, type TerminalGroup, type TerminalInstance } from '../../../state/terminal-store';
import { WorkspaceTabs } from '../../../state/workspace-tabs';
import { startResize } from '../../../ui/resize-drag';
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
  styleUrl: './terminal-view.css',
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
    const handle = event.currentTarget as HTMLElement;
    const container = handle.parentElement;
    const width = container?.getBoundingClientRect().width ?? 0;
    if (container === null || width <= 0) {
      return;
    }
    const startX = event.clientX;
    const start = [...group.sizes];
    const min = 0.08;
    const pair = start[index]! + start[index + 1]!;
    startResize(event, {
      // The two panes either side trade width and keep their sum, so the rest of the split
      // never moves.
      value: (pointer) => {
        const delta = (pointer.clientX - startX) / width;
        const left = Math.min(pair - min, Math.max(min, start[index]! + delta));
        return start.map((size, i) => (i === index ? left : i === index + 1 ? pair - left : size));
      },
      preview: (sizes) => this.store.setSizes(group.id, sizes),
      commit: (sizes) => this.store.setSizes(group.id, sizes),
    });
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
