import { NgTemplateOutlet } from '@angular/common';
import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { fileGlyph } from '@morse/ui-runtime';
import { MorseService } from '../../host/morse.service';
import { Dialog } from '../../ui/dialog/dialog';
import { WorkspaceTabs, type WorkspaceTab } from '../../state/workspace-tabs';

/** An open tab context menu, anchored at the pointer. */
interface TabMenu {
  x: number;
  y: number;
  /** The tab the menu belongs to. */
  id: string;
}

/**
 * The browser host's tab strip: every open session and file, one active at a
 * time. VS Code never renders it — its editor already owns the tabs, and the
 * host advertises `filePreview: false`.
 *
 * A file attached to a session (a chip in the second row) also marks its session
 * in the first row, so which session a chip belongs to is never a guess — and
 * clicking the chip once it is in front returns to that session's conversation.
 */
@Component({
  selector: 'morse-tab-strip',
  imports: [NgTemplateOutlet, CdkDropList, CdkDrag, Dialog],
  templateUrl: './tab-strip.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './tab-strip.css',
})
export class TabStrip {
  private readonly tabs = inject(WorkspaceTabs);
  private readonly morse = inject(MorseService);

  protected readonly items = this.tabs.tabs;
  protected readonly activeId = this.tabs.activeId;
  /** Two rows: sessions/Explorer files first, then files from the `@` picker. */
  protected readonly mainTabs = this.tabs.mainTabs;
  protected readonly mentionTabs = this.tabs.mentionTabs;
  /**
   * The tab in front, for the narrow window's bar. It replaces the strip there, so
   * it has to say which tab the reader is looking at without the row of tabs.
   */
  protected readonly activeTab = this.tabs.activeTab;
  /** Every open tab as one list, in strip order — the drawer's shape (narrow windows). */
  protected readonly allTabs = computed<WorkspaceTab[]>(() => [
    ...this.mainTabs(),
    ...this.mentionTabs(),
  ]);
  /** True while the narrow window's tab drawer is down. */
  protected readonly sheetOpen = signal(false);
  /** What the drawer's field narrows the tabs by; titles and paths both match. */
  protected readonly drawerQuery = signal('');
  /**
   * The rows the drawer draws: every tab, or the ones the reader typed. A
   * session's chips move up beside it, so the indent under that row says which
   * conversation the file belongs to instead of leaving it at the end.
   */
  protected readonly drawerTabs = computed<WorkspaceTab[]>(() => {
    const needle = this.drawerQuery().trim().toLowerCase();
    const tabs =
      needle.length === 0
        ? this.allTabs()
        : this.allTabs().filter((tab) =>
            `${tab.title} ${tab.kind === 'file' ? tab.path : tab.kind === 'session' ? tab.cwd ?? '' : ''}`
              .toLowerCase()
              .includes(needle),
          );
    const owner = this.tabs.contextSessionId();
    if (owner === undefined) {
      return tabs;
    }
    const chips = tabs.filter(
      (tab) => tab.kind === 'file' && tab.mention === true && tab.sessionId === owner,
    );
    if (chips.length === 0) {
      return tabs;
    }
    const roots = tabs.filter((tab) => !chips.includes(tab));
    const at = roots.findIndex((tab) => tab.id === owner);
    return at < 0
      ? [...roots, ...chips]
      : [...roots.slice(0, at + 1), ...chips, ...roots.slice(at + 1)];
  });

  private readonly menuState = signal<TabMenu | undefined>(undefined);
  protected readonly menu = this.menuState.asReadonly();
  /**
   * The session a chip in front belongs to, so the main row can mark it. `undefined`
   * unless the active tab is a chip (a file attached to a session).
   */
  protected readonly activeChipOwner = computed<string | undefined>(() => {
    const tab = this.tabs.activeTab();
    return tab?.kind === 'file' && tab.mention === true ? this.tabs.contextSessionId() : undefined;
  });

  protected glyph(tab: WorkspaceTab): string {
    if (tab.kind === 'mcp') {
      return '⚙';
    }
    if (tab.kind === 'settings') {
      return '▣';
    }
    return tab.kind === 'session' ? '✦' : fileGlyph(tab.title);
  }

  /**
   * The sessions in the strip that are delegation children. A subagent has no
   * process of its own and is steered by its parent, so its tab is tinted to read
   * as a watched child rather than another conversation. The catalog carries the
   * flag; a child spawned this turn may not be listed yet, so its tool row in the
   * open transcript is the other source.
   */
  protected readonly subagentIds = computed<ReadonlySet<string>>(() => {
    const ids = new Set(
      this.morse
        .sessions()
        .filter((session) => session.subagent === true)
        .map((session) => session.id),
    );
    for (const item of this.morse.items()) {
      if (item.kind === 'tool' && item.child !== undefined) {
        ids.add(item.child.sessionId);
      }
    }
    return ids;
  });

  protected isSubagent(tab: WorkspaceTab | undefined): boolean {
    return tab?.kind === 'session' && this.subagentIds().has(tab.id);
  }

  /**
   * True while the agent is producing a turn in that session, whatever tab is in
   * front. The tab then shows a spinner, so a run is visible even when the reader
   * is looking at another session or a file. `sessionActivity` lists every hot
   * session — opening one spawns its agent — so only `streaming` counts, not a
   * warm or idle session that merely has an agent attached.
   */
  protected isRunning(id: string): boolean {
    const activity = this.morse.sessionActivity().get(id);
    if (activity !== undefined) {
      return activity.streaming;
    }
    // A session opened before its id is known cannot match the activity key yet.
    const state = this.morse.state();
    return state.sessionId === id && state.streaming;
  }

  protected title(tab: WorkspaceTab): string {
    return tab.kind === 'file' ? tab.path : tab.title;
  }

  /**
   * Whether any file name is shared by more than one chip in the row. When one
   * is, the whole row goes two lines — a strip that mixes one-line and two-line
   * chips reads as broken alignment, not as emphasis.
   */
  private readonly namesClash = computed(() => {
    const seen = new Set<string>();
    for (const tab of this.mentionTabs()) {
      if (seen.has(tab.title)) {
        return true;
      }
      seen.add(tab.title);
    }
    return false;
  });

  /**
   * Whether a chip takes the taller two-line shape. The row is uniform: if one
   * name is shared, every chip grows its second line (a root file keeps it
   * empty and stays centred) so all chips share one height.
   */
  protected twoLineChip(tab: WorkspaceTab): boolean {
    return tab.kind === 'file' && tab.mention === true && this.namesClash();
  }

  /** Whether a two-line chip has a folder to spell out on its second line. */
  protected showsDirectory(tab: WorkspaceTab): boolean {
    return this.twoLineChip(tab) && this.directoryOf(tab).length > 0;
  }

  /** The part of a chip's path before the file name, for the second line. */
  protected directoryOf(tab: WorkspaceTab): string {
    if (tab.kind !== 'file') {
      return '';
    }
    const slash = Math.max(tab.path.lastIndexOf('/'), tab.path.lastIndexOf('\\'));
    return slash <= 0 ? '' : tab.path.slice(0, slash);
  }

  protected select(id: string): void {
    this.tabs.select(id);
  }

  protected close(id: string, event: Event): void {
    event.stopPropagation();
    this.tabs.close(id);
  }

  /** Middle-click closes a tab, the way every editor's strip does. */
  protected onAuxClick(id: string, event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
      this.tabs.close(id);
    }
  }

  /**
   * A CDK drop: the dragged tab takes the slot the placeholder is on. CDK never
   * mutates the data, so `currentIndex` still indexes the array as it was when
   * the drag started — the tab sitting there is where it landed.
   */
  protected onDrop(event: CdkDragDrop<WorkspaceTab[]>): void {
    const dragged = event.item.data as WorkspaceTab | undefined;
    const target = event.container.data[event.currentIndex];
    if (dragged !== undefined && target !== undefined) {
      this.tabs.move(dragged.id, target.id);
    }
  }

  protected openMenu(event: MouseEvent, id: string): void {
    event.preventDefault();
    event.stopPropagation();
    // Anchor at the pointer but pull back from the edges: the menu is short but
    // the strip runs the width of the window.
    const width = 190;
    const height = 150;
    this.menuState.set({
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - width)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - height)),
      id,
    });
  }

  protected closeMenu(): void {
    this.menuState.set(undefined);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    // The drawer covers the page, so it is the innermost thing Escape can close.
    if (this.sheetOpen()) {
      this.closeSheet();
      return;
    }
    this.closeMenu();
  }

  protected closeSheet(): void {
    this.sheetOpen.set(false);
    // A stale filter would make the next open look like the tabs vanished.
    this.drawerQuery.set('');
  }

  protected onDrawerQuery(event: Event): void {
    this.drawerQuery.set((event.target as HTMLInputElement).value);
  }

  /** Opens the tab the drawer row names, and gets the drawer out of the way. */
  protected pick(id: string): void {
    this.tabs.select(id);
    this.closeSheet();
  }

  /**
   * Closes a tab from the drawer. An empty drawer is a dead panel over the page,
   * so the last close folds it away.
   */
  protected closeFromSheet(id: string, event: Event): void {
    event.stopPropagation();
    this.tabs.close(id);
    if (this.allTabs().length === 0) {
      this.closeSheet();
    }
  }

  /** Where a pull on the bar began; `undefined` when no pull is in flight. */
  private pullFrom: number | undefined;
  /** Whether the last pointer-up on the bar was a pull, so its click must open. */
  private pulled = false;

  protected pullStart(event: PointerEvent): void {
    this.pullFrom = event.clientY;
    // A pull can leave this thin bar; keep its pointer, and the click that follows,
    // on the bar so a pull never vanishes into the page underneath.
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  protected pullEnd(event: PointerEvent): void {
    const from = this.pullFrom;
    this.pullFrom = undefined;
    this.pulled = from !== undefined && event.clientY - from >= 24;
  }

  /**
   * Opens on the *click*, never on pointer-up. Opening earlier mounts the dialog's
   * backdrop between pointer-up and click, so the very click that opened it lands
   * on the backdrop and dismisses it again — the drawer flashed and was gone.
   * Keyboard clicks come here too: a button's Enter/Space is a click with no pull.
   */
  protected onHandleClick(): void {
    const pulled = this.pulled;
    this.pulled = false;
    if (pulled || !this.sheetOpen()) {
      this.sheetOpen.set(true);
    } else {
      this.closeSheet();
    }
  }

  /** A file chip's menu only spans its row, so these ask the store's scope. */
  protected canCloseOthers(id: string): boolean {
    return this.tabs.canCloseOthers(id);
  }

  protected canCloseToTheRight(id: string): boolean {
    return this.tabs.canCloseToTheRight(id);
  }

  /** Menu actions read the open menu's tab, so the template needs no closure. */
  private withMenu(action: (id: string) => void): void {
    const open = this.menuState();
    this.closeMenu();
    if (open !== undefined) {
      action(open.id);
    }
  }

  protected menuClose(): void {
    this.withMenu((id) => this.tabs.close(id));
  }

  protected menuCloseOthers(): void {
    this.withMenu((id) => this.tabs.closeOthers(id));
  }

  protected menuCloseToTheRight(): void {
    this.withMenu((id) => this.tabs.closeToTheRight(id));
  }

  protected menuCloseAll(): void {
    this.withMenu((id) => this.tabs.closeAll(id));
  }
}
