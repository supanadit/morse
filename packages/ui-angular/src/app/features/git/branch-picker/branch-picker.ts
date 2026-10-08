import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { GitBranches } from '@morse/protocol';

/**
 * The panel's branch switcher: a filterable list of local and remote branches,
 * plus the way to create a new one. It is a dumb picker — it names a branch and
 * the panel runs the checkout — so a wrong pick cannot silently move the tree.
 */
@Component({
  selector: 'morse-branch-picker',
  templateUrl: './branch-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        z-index: 30;
        width: min(320px, 90vw);
        display: block;
      }
      /* A click anywhere else closes the picker without moving the tree. */
      .layer {
        position: fixed;
        inset: 0;
        z-index: -1;
      }
      .menu {
        max-height: 340px;
        overflow-y: auto;
        padding: 4px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 10px 28px rgb(0 0 0 / 35%);
      }
      .filter,
      .name-input {
        width: 100%;
        box-sizing: border-box;
        padding: 5px 8px;
        border: 1px solid var(--morse-input-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-input-bg);
        color: var(--morse-input-fg);
        font: inherit;
        font-size: 12px;
      }
      .create {
        display: flex;
        gap: 6px;
      }
      .primary {
        flex: none;
        padding: 5px 10px;
        border: 1px solid var(--morse-accent);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-accent);
        color: #fff;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .primary:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .group {
        padding: 6px 8px 2px;
        color: var(--morse-fg-muted);
        font-size: 10px;
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        padding: 5px 8px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        font: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }
      .row:hover:not(:disabled),
      .row:focus-visible {
        background: var(--morse-hover);
      }
      .row.create-row {
        margin-top: 4px;
        color: var(--morse-accent);
      }
      .row.detach-row {
        color: var(--morse-fg-muted);
      }
      /* A tag's own glyph, so a tag row is not mistaken for a branch. */
      .tag-glyph {
        flex: none;
        width: 13px;
        text-align: center;
        color: var(--morse-fg-muted);
        font-size: 11px;
        line-height: 1;
      }
      .dot {
        flex: none;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        border: 1.4px solid var(--morse-fg-muted);
      }
      .dot.on {
        border-color: var(--morse-accent);
        background: var(--morse-accent);
      }
      .row .name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--morse-font-mono);
      }
      .row .remote {
        flex: none;
        max-width: 45%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-family: var(--morse-font-mono);
        font-size: 10px;
      }
      .empty {
        padding: 10px 8px;
        color: var(--morse-fg-muted);
        font-size: 11.5px;
      }
    `,
  ],
})
export class BranchPicker {
  readonly branches = input.required<GitBranches>();
  /** True while a checkout is in flight, so the rows and Create are inert. */
  readonly busy = input(false);
  readonly pick = output<string>();
  readonly create = output<string>();
  /** A tag or commit to check out detached from. */
  readonly detach = output<string>();
  readonly close = output<void>();

  /** `create` and `detach` are the same little form with a different label. */
  protected readonly mode = signal<'list' | 'create' | 'detach'>('list');
  protected readonly filter = signal('');
  protected readonly value = signal('');

  protected readonly locals = computed(() => this.rank(this.branches().local));
  protected readonly remotes = computed(() => this.rank(this.branches().remote));
  protected readonly tags = computed(() => this.rank(this.branches().tags));
  protected readonly hasHits = computed(
    () => this.locals().length > 0 || this.remotes().length > 0 || this.tags().length > 0,
  );
  protected readonly formLabel = computed(() =>
    this.mode() === 'create' ? 'New branch name' : 'Commit or tag to check out',
  );
  protected readonly confirmLabel = computed(() => (this.mode() === 'create' ? 'Create' : 'Checkout'));

  private rank(list: readonly string[]): string[] {
    const query = this.filter().trim().toLowerCase();
    const names =
      query.length === 0 ? [...list] : list.filter((name) => name.toLowerCase().includes(query));
    return names.sort((a, b) => a.localeCompare(b));
  }

  /** A remote branch's short name: what `git checkout` creates a local for. */
  protected short(remote: string): string {
    const slash = remote.indexOf('/');
    return slash === -1 ? remote : remote.slice(slash + 1);
  }

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected onValue(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }

  protected choose(branch: string): void {
    if (!this.busy()) {
      this.pick.emit(branch);
    }
  }

  /** "Create new branch…" starts with whatever the filter already holds. */
  protected startCreate(): void {
    this.value.set(this.filter().trim());
    this.mode.set('create');
  }

  protected startDetach(): void {
    this.value.set('');
    this.mode.set('detach');
  }

  protected confirm(): void {
    const value = this.value().trim();
    if (value.length === 0 || this.busy()) {
      return;
    }
    if (this.mode() === 'create') {
      this.create.emit(value);
    } else {
      this.detach.emit(value);
    }
  }
}
