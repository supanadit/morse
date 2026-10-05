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
import { fileGlyph } from '../../core/file-tree';
import { MorseService } from '../../core/morse.service';
import { WorkspaceTabs, type WorkspaceTab } from '../../core/workspace-tabs';

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
 */
@Component({
  selector: 'morse-tab-strip',
  imports: [NgTemplateOutlet, CdkDropList, CdkDrag],
  templateUrl: './tab-strip.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
        flex: none;
        min-height: 30px;
        border-bottom: 1px solid var(--morse-border);
        background: var(--morse-nav-bg);
      }
      .strip {
        display: flex;
        align-items: stretch;
        gap: 0;
        height: 30px;
        padding: 0;
        overflow-x: auto;
        scrollbar-width: none;
      }
      .strip::-webkit-scrollbar {
        display: none;
      }
      /*
       * The second row is quoted-file context for the session in front, not a peer
       * of the session tabs: chips on the panel background instead of a second
       * flush tab bar, so the two rows read as primary and secondary.
       */
      .strip + .strip {
        height: auto;
        min-height: 30px;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-top: 1px solid var(--morse-border);
        background: var(--morse-panel, var(--morse-bg));
      }
      .tab.mention {
        height: 22px;
        max-width: 190px;
        padding: 0 4px 0 8px;
        border: 1px solid var(--morse-border);
        border-radius: 999px;
        background: var(--morse-bubble, var(--morse-hover));
        font-size: 11.5px;
      }
      .tab.mention:hover {
        background: var(--morse-hover);
        border-color: var(--morse-accent);
        color: var(--morse-fg);
      }
      .tab.mention.active {
        border-color: var(--morse-accent);
        background: color-mix(in srgb, var(--morse-accent) 22%, transparent);
        color: var(--morse-fg);
        box-shadow: none;
      }
      .tab.mention .close {
        width: 15px;
        height: 15px;
        font-size: 11px;
        border-radius: 999px;
      }
      /* Flush tabs: full height, no margin, separated by a hairline. */
      .tab {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: none;
        max-width: 170px;
        padding: 0 8px 0 10px;
        margin: 0;
        border: 0;
        border-right: 1px solid var(--morse-border);
        border-radius: 0;
        background: none;
        color: var(--morse-fg-muted);
        font: inherit;
        font-size: 12px;
        cursor: grab;
        position: relative;
      }
      .tab:active {
        cursor: grabbing;
      }
      /* Angular CDK drag: the tab in hand floats in a preview, the siblings slide
         aside, and a placeholder holds the slot it will land in. */
      .strip.cdk-drop-list-dragging .tab:not(.cdk-drag-placeholder) {
        transition: transform 180ms cubic-bezier(0.2, 0, 0, 1);
      }
      .tab.cdk-drag-animating {
        transition: transform 180ms cubic-bezier(0.2, 0, 0, 1);
      }
      .tab.cdk-drag-placeholder {
        opacity: 0.3;
      }
      .cdk-drag-preview {
        display: flex;
        align-items: center;
        gap: 6px;
        box-sizing: border-box;
        max-width: 170px;
        height: 30px;
        padding: 0 8px 0 10px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-panel, var(--morse-bg));
        color: var(--morse-fg);
        font: inherit;
        font-size: 12px;
        box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
      }
      .cdk-drag-preview .close {
        opacity: 1;
      }
      .tab:hover {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .tab.active {
        background: var(--morse-panel, var(--morse-badge-bg));
        color: var(--morse-fg);
        box-shadow: inset 0 -2px 0 var(--morse-accent);
      }
      /* A session the agent is streaming in: a spinner, active or not. */
      .tab .live {
        flex: none;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        border: 1.5px solid color-mix(in srgb, var(--morse-accent) 30%, transparent);
        border-top-color: var(--morse-accent);
        animation: tab-spin 0.8s linear infinite;
      }
      @keyframes tab-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .glyph {
        flex: none;
        font-size: 11px;
        color: var(--morse-fg-muted);
      }
      .tab.active .glyph {
        color: var(--morse-accent);
      }
      .label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .close {
        flex: none;
        width: 18px;
        height: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: none;
        color: var(--morse-fg-muted);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        opacity: 0;
      }
      .tab:hover .close,
      .tab.active .close {
        opacity: 1;
      }
      .close:hover:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .empty {
        align-self: center;
        padding: 0 10px;
        font-size: 11.5px;
        color: var(--morse-fg-muted);
      }
      /* A tab menu like the one VS Code opens; "context-menu" avoids clashing
         with the shell's ".menu" (the navigation toggle). */
      .context-menu-layer {
        position: fixed;
        inset: 0;
        z-index: 40;
      }
      .context-menu {
        position: fixed;
        z-index: 41;
        width: 190px;
        max-width: min(280px, 90vw);
        padding: 4px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
      }
      .context-menu-item {
        display: block;
        width: 100%;
        padding: 5px 8px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }
      .context-menu-item:hover:not(:disabled),
      .context-menu-item:focus-visible:not(:disabled) {
        background: var(--morse-hover);
      }
      .context-menu-item:disabled {
        color: var(--morse-fg-muted);
        cursor: default;
      }
      .context-menu-item:disabled:hover {
        background: transparent;
      }
    `,
  ],
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
  protected readonly closableOthers = computed(() => this.items().length > 1);

  protected glyph(tab: WorkspaceTab): string {
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

  protected canCloseToTheRight(id: string): boolean {
    const index = this.items().findIndex((tab) => tab.id === id);
    return index !== -1 && index < this.items().length - 1;
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
    this.closeMenu();
    this.tabs.closeAll();
  }
}
