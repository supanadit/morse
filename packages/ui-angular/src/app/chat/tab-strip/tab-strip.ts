import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { fileGlyph } from '../../core/file-tree';
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
  templateUrl: './tab-strip.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
        flex: none;
        min-height: var(--morse-head-height);
        border-bottom: 1px solid var(--morse-border);
        background: var(--morse-nav-bg);
      }
      .strip {
        display: flex;
        align-items: stretch;
        gap: 2px;
        height: var(--morse-head-height);
        padding: 0 6px;
        overflow-x: auto;
        scrollbar-width: none;
      }
      .strip::-webkit-scrollbar {
        display: none;
      }
      .tab {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: none;
        max-width: 200px;
        padding: 0 6px 0 10px;
        margin: 5px 0;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: none;
        color: var(--morse-fg-muted);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
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

  protected readonly items = this.tabs.tabs;
  protected readonly activeId = this.tabs.activeId;

  private readonly menuState = signal<TabMenu | undefined>(undefined);
  protected readonly menu = this.menuState.asReadonly();
  protected readonly closableOthers = computed(() => this.items().length > 1);

  protected glyph(tab: WorkspaceTab): string {
    return tab.kind === 'session' ? '✦' : fileGlyph(tab.title);
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
