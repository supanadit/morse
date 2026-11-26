import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { TreeNode } from '@morse/ui-runtime';
import {
  WorkspaceTabs,
  SETTINGS_MEMBERS_TAB_ID,
  SETTINGS_PROVIDERS_TAB_ID,
} from '../../state/workspace-tabs';
import { Pane } from '../../ui/pane/pane';
import { TreeList } from '../../ui/tree-list/tree-list';

/** Which settings page a leaf opens. Groups carry none — they only fold. */
type SettingsPage = 'members' | 'providers';

/**
 * The settings menu: the left column's third face, in front while the rail's
 * cog is. Drawn with the same pane + tree as the session list, so a section
 * here folds exactly like a project there.
 *
 * Sections are groups, pages are leaves, and groups nest without limit — a new
 * page is a leaf under its section, a new subsection a group under a group:
 * Personalization → Profile → XXXX needs no new component, only more nodes.
 */
@Component({
  selector: 'morse-settings-nav',
  templateUrl: './settings-nav.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './settings-nav.css',
  imports: [Pane, TreeList],
})
export class SettingsNav {
  private readonly tabs = inject(WorkspaceTabs);
  /** Single-user hosts have no accounts to manage; only Engine applies. */
  readonly multiuser = input(false);

  /** Groups the reader folded, by node id; absent means open. */
  private readonly folded = signal<ReadonlySet<string>>(new Set());

  protected readonly treeNodes = computed<TreeNode<SettingsPage>[]>(() => {
    const groups: TreeNode<SettingsPage>[] = [];
    if (this.multiuser()) {
      groups.push({
        id: 'settings:management',
        label: 'Management',
        data: undefined as unknown as SettingsPage,
        icon: 'folder',
        kind: 'group',
        children: [
          {
            id: SETTINGS_MEMBERS_TAB_ID,
            label: 'Members',
            data: 'members',
            icon: 'admin',
            kind: 'leaf',
            children: [],
          },
        ],
      });
    }
    groups.push({
      id: 'settings:engine',
      label: 'Engine',
      data: undefined as unknown as SettingsPage,
      icon: 'folder',
      kind: 'group',
      children: [
        {
          id: SETTINGS_PROVIDERS_TAB_ID,
          label: 'Providers',
          data: 'providers',
          icon: 'plug',
          kind: 'leaf',
          children: [],
        },
      ],
    });
    // A section with no pages is gone, not an empty header — a host without
    // Members has no Users section. Every page always sits under its section,
    // single- or multi-user alike, so the tree keeps one shape everywhere.
    const kept = groups.filter((group) => group.children.length > 0);
    return kept;
  });

  protected readonly expanded = computed<ReadonlySet<string>>(() => {
    const shut = this.folded();
    const open = new Set<string>();
    const walk = (nodes: readonly TreeNode<SettingsPage>[]): void => {
      for (const node of nodes) {
        if (node.kind === 'group' && !shut.has(node.id)) {
          open.add(node.id);
        }
        walk(node.children);
      }
    };
    walk(this.treeNodes());
    return open;
  });

  /** The page in front, so its row reads as selected. */
  protected readonly selected = computed(() => this.tabs.activeId());

  protected onActivate(node: TreeNode<SettingsPage>): void {
    if (node.kind === 'group') {
      this.toggle(node.id);
      return;
    }
    if (node.data === 'members') {
      this.tabs.openSettingsPage();
    } else if (node.data === 'providers') {
      this.tabs.openProvidersPage();
    }
  }

  /** The caret only folds, so a group is opened by its own name. */
  protected onToggle(node: TreeNode<SettingsPage>): void {
    if (node.kind === 'group') {
      this.toggle(node.id);
    }
  }

  private toggle(id: string): void {
    this.folded.update((shut) => {
      const next = new Set(shut);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }
}
