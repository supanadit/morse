import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { flattenTree, treePrefix, type TreeListRow, type TreeNode } from '@morse/ui-runtime';

/**
 * One tree, drawn once.
 *
 * The Explorer (project → folders → files) and the session list (project →
 * sessions) are the same list twice: roots, a fold chevron, a connector drawn
 * against the rows above, a nested indent and a marked row. Drawn separately they
 * drifted — a change to the row meant two edits, and the second was the one that
 * got forgotten. Here the caller hands over a tree and the component draws it, so
 * one change to a row reaches both.
 *
 * The component owns the *drawing* and nothing else: the caller keeps the fold
 * set, the marked row and the click, because what a row does (open a file, switch
 * a session) is the caller's business. A click reports the row's own object back,
 * so the handler never looks an id up again.
 *
 * `role="tree"` and each row's `aria-level`/`aria-expanded` are the accessibility
 * half: a screen reader hears the same nesting a sighted reader sees.
 */
@Component({
  selector: 'morse-tree',
  templateUrl: './tree-list.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './tree-list.css',
})
export class TreeList<T> {
  /** The tree to draw, already shaped into nodes by the caller. */
  readonly nodes = input.required<readonly TreeNode<T>[]>();
  /** The group ids that are open. The caller owns this, so it can open a path on demand. */
  readonly expanded = input.required<ReadonlySet<string>>();
  /** The row drawn as "in front", by node id. */
  readonly selected = input<string | undefined>(undefined);
  /** The empty state, when the tree has no rows (a project with no sessions). */
  readonly empty = input<string>('Nothing to show.');

  /** A row was clicked — the caller decides whether that folds or opens. */
  readonly activate = output<TreeNode<T>>();
  /** A row's caret was clicked: fold or unfold it, without opening the row. */
  readonly toggle = output<TreeNode<T>>();
  /** A row was right-clicked, with the pointer's spot — the caller anchors a menu there. */
  readonly context = output<{ node: TreeNode<T>; event: MouseEvent }>();

  protected readonly rows = computed(() => flattenTree(this.nodes(), this.expanded()));

  protected onContext(event: MouseEvent, node: TreeNode<T>): void {
    event.preventDefault();
    this.context.emit({ node, event });
  }

  protected prefix(row: TreeListRow<T>): string {
    return treePrefix(row);
  }

  protected isOpen(node: TreeNode<T>): boolean {
    return this.expanded().has(node.id);
  }

  /**
   * The caret every group draws. One glyph, turned by CSS when the group is open, so
   * the mark is the same shape whether it points right or down — a `▸`/`▾` pair
   * changes the glyph's ink and jumps as it swaps.
   */
  protected chevron(node: TreeNode<T>): string {
    return node.kind === 'group' ? '›' : '';
  }

  protected onRow(node: TreeNode<T>): void {
    this.activate.emit(node);
  }

  /** The caret only folds. The event stops so the row behind it does not also open. */
  protected onToggle(event: Event, node: TreeNode<T>): void {
    event.stopPropagation();
    this.toggle.emit(node);
  }

  /**
   * A row's own action (the session list's per-project “+”). It stops the event, so
   * the click does not also fold the group the button sits in.
   */
  protected onAction(event: Event, node: TreeNode<T>): void {
    event.stopPropagation();
    node.action?.run();
  }
}
