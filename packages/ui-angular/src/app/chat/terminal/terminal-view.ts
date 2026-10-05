import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject } from '@angular/core';
import { PanelState } from '../../core/panel-state';
import { TerminalStore } from '../../core/terminal-store';
import { WorkspaceTabs } from '../../core/workspace-tabs';
import { Terminal } from './terminal';

/**
 * The bottom panel's terminal tool: one tab row per open terminal, and every
 * terminal's emulator mounted behind it. Terminals belong to the session in
 * front (`WorkspaceTabs.composerKey`), so switching sessions swaps the tab row
 * while the other sessions' shells keep running — a terminal is never shared,
 * and all of them are dropped when their session tab closes.
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
        padding: 4px 8px;
        border-bottom: 1px solid var(--morse-border);
        background: var(--morse-panel, var(--morse-bg));
        overflow-x: auto;
        scrollbar-width: none;
      }
      .tabbar::-webkit-scrollbar {
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
      .ttab .close {
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
      .ttab.active .close {
        opacity: 1;
      }
      .ttab .close:hover:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .screens {
        position: relative;
        display: flex;
        flex: 1;
        min-width: 0;
        min-height: 0;
      }
      .screen-host {
        flex: 1;
        min-width: 0;
        min-height: 0;
      }
      /* Inactive terminals keep their shell; they only lose the space. */
      .screen-host.hidden {
        display: none;
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
  private readonly destroyRef = inject(DestroyRef);

  /** The session the panel is showing; terminals belong to it, not to the app. */
  protected readonly owner = this.tabs.composerKey;
  /** The tabs of the session in front, and which of them is open. */
  protected readonly mine = computed(() =>
    this.store.terminals().filter((terminal) => terminal.owner === this.owner()),
  );
  protected readonly activeId = computed(() => this.store.activeFor(this.owner()));
  /** Every terminal stays mounted (its PTY lives); only the active one is shown. */
  protected readonly all = this.store.terminals;

  constructor() {
    // The `+` lives in the panel bar next to the tool chip ("Terminal +"), so
    // the terminal's own row is only the chips of the terminals that are open.
    this.panel.registerActions('terminal', [
      { label: '+', title: 'New terminal', run: () => this.add() },
    ]);
    this.destroyRef.onDestroy(() => this.panel.clearActions('terminal'));
  }

  protected add(): void {
    this.store.open(this.owner());
  }

  protected select(id: string): void {
    this.store.focus(id);
  }

  protected close(id: string, event: Event): void {
    event.stopPropagation();
    this.store.close(id);
  }

  /** Middle-click closes a terminal tab, like the session strip. */
  protected onAuxClick(id: string, event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
      this.store.close(id);
    }
  }
}
