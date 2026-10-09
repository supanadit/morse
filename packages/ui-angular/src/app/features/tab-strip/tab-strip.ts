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
  imports: [NgTemplateOutlet, CdkDropList, CdkDrag],
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
    if (tab.kind === 'prompt') {
      return '✎';
    }
    return tab.kind === 'session' ? '✦' : fileGlyph(tab.title);
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
    this.closeMenu();
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
