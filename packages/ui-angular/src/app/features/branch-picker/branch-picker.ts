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
  styleUrl: './branch-picker.css',
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
