/**
 * The shape of a tree, as pure arithmetic so both trees in the sidebar can share
 * one set of rules.
 *
 * The Explorer (project → folders → files) and the session list (project →
 * sessions) are the same list twice: rows with a depth, a row that opens or folds,
 * a connector drawn against the rows above it, and a marked row that follows what
 * is in front. Each had, or would have grown, its own flattening and its own
 * prefix builder — so the two trees drifted the moment either changed. Here the
 * hierarchy is turned into rows once, and a frontend only renders what it is
 * handed.
 *
 * The tree is generic over the caller's own object (`T`): a node carries the value
 * it stands for, so a click handler is handed the `FileNode` or the
 * `SessionSummary` itself and never has to look an id back up.
 */

/** One node of a tree: what it stands for, what to show, and how it nests. */
export interface TreeNode<T> {
  /** Stable identity, used for the fold set and for `track` in the template. */
  readonly id: string;
  /** The row's text. */
  readonly label: string;
  /** The caller's own object, handed back on a click. */
  readonly data: T;
  /** A second, muted line under the label (the session's activity, a file's folder). */
  readonly detail?: string;
  /** A short mark at the row's end (the git badge, a count). */
  readonly badge?: string;
  /**
   * What colour the badge is, in the theme's own vocabulary rather than a hex. A
   * git `M` is `warn` and an `A` is `success`; a count is plain. The caller keeps
   * the meaning, the tree only paints it.
   */
  readonly badgeTone?:
    "plain" | "muted" | "info" | "success" | "warn" | "error";
  /** Drawn bold, and clicking it folds rather than activates. */
  readonly kind: "group" | "leaf";
  /**
   * An action offered on the row's end, as data rather than markup — the way
   * `PaneAction` works for a title bar. The session list uses it for the per-project
   * “+”; a leaf never has one. It is the row's own button, so it does not take the
   * row's click with it.
   */
  readonly action?: {
    readonly glyph: string;
    readonly label: string;
    readonly run: () => void;
  };
  /** The children, when this node can open. Empty for a leaf. */
  readonly children: readonly TreeNode<T>[];
}

/** A row flattened for rendering, with everything it needs to draw itself. */
export interface TreeListRow<T> {
  readonly node: TreeNode<T>;
  /** How far the row is indented; `0` is a root. */
  readonly depth: number;
  /** The last child at its level, so the connector turns the corner (`└─`). */
  readonly isLast: boolean;
  /**
   * One flag per ancestor above this row: whether that ancestor still has a
   * sibling below it. A `true` draws the vertical line (`│`), a `false` a gap —
   * the rule that keeps a folded branch from looking joined to the next one.
   */
  readonly ancestorContinues: readonly boolean[];
}

/**
 * Flattens a tree into the rows to draw, honouring the fold set.
 *
 * A group's children are only walked when its id is in `expanded`; leaves have no
 * children to walk anyway. The `ancestorContinues` list is built as the walk
 * descends, so a row can draw its own prefix without knowing the tree.
 */
export function flattenTree<T>(
  nodes: readonly TreeNode<T>[],
  expanded: ReadonlySet<string>,
): TreeListRow<T>[] {
  const rows: TreeListRow<T>[] = [];
  const walk = (
    list: readonly TreeNode<T>[],
    depth: number,
    ancestorContinues: readonly boolean[],
  ): void => {
    for (let index = 0; index < list.length; index += 1) {
      const node = list[index];
      const isLast = index === list.length - 1;
      rows.push({ node, depth, isLast, ancestorContinues });
      if (node.kind !== "group" || !expanded.has(node.id)) {
        continue;
      }
      // Only a non-root ancestor draws a continuation line; a root has nothing to
      // its left to connect to.
      const continues = depth > 0 ? !isLast : false;
      walk(node.children, depth + 1, [...ancestorContinues, continues]);
    }
  };
  walk(nodes, 0, []);
  return rows;
}

/**
 * The connector a row draws to its left: the vertical lines of the ancestors that
 * still have siblings below, then the corner or the tee for this row itself.
 *
 * A root carries none — there is no branch above it to connect to. Deeper rows get
 * `│ ` per continuing ancestor, `  ` per finished one, and `├─`/`└─` for the row.
 * Each column is two characters: one for the line and one of air, so the tree reads
 * as a tree without the channel of space three characters made.
 */
export function treePrefix(row: {
  readonly depth: number;
  readonly isLast: boolean;
  readonly ancestorContinues: readonly boolean[];
}): string {
  if (row.depth === 0) {
    return "";
  }
  const lines = row.ancestorContinues.map((continues) =>
    continues ? "│ " : "  ",
  );
  return lines.join("") + (row.isLast ? "└─" : "├─");
}
