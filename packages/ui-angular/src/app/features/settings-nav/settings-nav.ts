import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { TreeNode } from '@morse/ui-runtime';
import {
  WorkspaceTabs,
  SETTINGS_ACCESS_TAB_ID,
  SETTINGS_GIT_TAB_ID,
  SETTINGS_GPG_TAB_ID,
  SETTINGS_MEMBERS_TAB_ID,
  SETTINGS_OIDC_TAB_ID,
  SETTINGS_PROVIDERS_TAB_ID,
} from '../../state/workspace-tabs';
import { Pane } from '../../ui/pane/pane';
import { TreeList } from '../../ui/tree-list/tree-list';

/** Which settings page a leaf opens. Groups carry none — they only fold. */
type SettingsPage = 'members' | 'oidc' | 'access' | 'gpg' | 'git' | 'providers';

/**
 * The settings menu: the left column's third face, in front while the rail's
 * cog is. Drawn with the same pane + tree as the session list, so a section
 * here folds exactly like a project there.
 *
 * Sections are groups, pages are leaves, and groups nest without limit — a new
 * page is a leaf under its section, a new subsection a group under a group:
 * Personalization → Profile → XXXX needs no new component, only more nodes.
 *
 * Visibility is per leaf, not per section: each leaf declares whether it
 * needs an admin, the tree keeps only the leaves this reader may open, and a
 * section left with none is dropped. So a future `Management → Profile` (for
 * everyone) keeps the Management header for regulars while `Members` (admins
 * only) vanishes — no component change, only more nodes with the right flag.
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
  /** True for single-user hosts and admin logins: the admin-only leaves show. */
  readonly admin = input(false);

  /** Groups the reader folded, by node id; absent means open. */
  private readonly folded = signal<ReadonlySet<string>>(new Set());

  /** One leaf's menu row and who may open it. */
  private leaf(
    id: string,
    label: string,
    data: SettingsPage,
    icon: 'admin' | 'plug' | 'lock' | 'tag' | 'git' | 'key',
    adminOnly: boolean,
  ): TreeNode<SettingsPage> & { adminOnly: boolean } {
    return { id, label, data, icon, kind: 'leaf', children: [], adminOnly };
  }

  protected readonly treeNodes = computed<TreeNode<SettingsPage>[]>(() => {
    const admin = this.admin();
    const groups: { node: TreeNode<SettingsPage>; leaves: ({ adminOnly: boolean } & TreeNode<SettingsPage>)[] }[] = [];
    if (this.multiuser()) {
      groups.push({
        node: {
          id: 'settings:management',
          label: 'Management',
          data: undefined as unknown as SettingsPage,
          icon: 'folder',
          kind: 'group',
          children: [],
        },
        // Members stays admin-only under Management; a future Profile leaf
        // for everyone would sit beside it with `false` and keep this header
        // for regulars too.
        leaves: [
          this.leaf(SETTINGS_MEMBERS_TAB_ID, 'Members', 'members', 'admin', true),
          this.leaf(SETTINGS_OIDC_TAB_ID, 'Authentication', 'oidc', 'key', true),
        ],
      });
    }
    // Every member manages their own SSH/GPG keys — admins and regulars
    // alike, single-user hosts included — so Access is its own section,
    // always shown.
    groups.push({
      node: {
        id: 'settings:access',
        label: 'Access',
        data: undefined as unknown as SettingsPage,
        icon: 'folder',
        kind: 'group',
        children: [],
      },
      leaves: [
        this.leaf(SETTINGS_ACCESS_TAB_ID, 'SSH keys', 'access', 'lock', false),
        this.leaf(SETTINGS_GPG_TAB_ID, 'GPG keys', 'gpg', 'tag', false),
        this.leaf(SETTINGS_GIT_TAB_ID, 'Git identity', 'git', 'git', false),
      ],
    });
    groups.push({
      node: {
        id: 'settings:engine',
        label: 'Engine',
        data: undefined as unknown as SettingsPage,
        icon: 'folder',
        kind: 'group',
        children: [],
      },
      // Provider credentials are host-wide and admin-managed in multi-user
      // mode (the host refuses non-admins), so the page is admin-only.
      leaves: [this.leaf(SETTINGS_PROVIDERS_TAB_ID, 'Providers', 'providers', 'plug', true)],
    });
    // A section with no visible pages is gone, not an empty header. Every
    // page always sits under its section, so the tree keeps one shape
    // everywhere — only the leaves differ by role.
    return groups.flatMap(({ node, leaves }) => {
      const visible = leaves.filter((leaf) => !leaf.adminOnly || admin);
      if (visible.length === 0) {
        return [];
      }
      return [{ ...node, children: visible.map(({ adminOnly, ...row }) => row) }];
    });
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
    } else if (node.data === 'oidc') {
      this.tabs.openOidcPage();
    } else if (node.data === 'access') {
      this.tabs.openAccessPage();
    } else if (node.data === 'gpg') {
      this.tabs.openGpgPage();
    } else if (node.data === 'git') {
      this.tabs.openGitPage();
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
