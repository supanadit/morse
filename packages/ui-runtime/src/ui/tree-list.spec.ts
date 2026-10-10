import { describe, expect, it } from "vitest";
import { flattenTree, treePrefix, type TreeNode } from "./tree-list.js";

/** A leaf, the way a caller builds one. */
function leaf(id: string, label = id): TreeNode<string> {
  return { id, label, data: id, kind: "leaf", children: [] };
}

/** A group over the given children. */
function group(id: string, children: TreeNode<string>[]): TreeNode<string> {
  return { id, label: id, data: id, kind: "group", children };
}

function ids(rows: ReturnType<typeof flattenTree<string>>): string[] {
  return rows.map((row) => row.node.id);
}

describe("flattenTree", () => {
  it("shows the roots, and a group only shows its children when it is open", () => {
    const tree = [group("a", [leaf("a1"), leaf("a2")]), leaf("b")];

    expect(ids(flattenTree(tree, new Set()))).toEqual(["a", "b"]);
    expect(ids(flattenTree(tree, new Set(["a"])))).toEqual([
      "a",
      "a1",
      "a2",
      "b",
    ]);
  });

  it("nests two levels and carries a depth on every row", () => {
    const tree = [group("src", [group("app", [leaf("main.ts")])])];
    const rows = flattenTree(tree, new Set(["src", "app"]));

    expect(ids(rows)).toEqual(["src", "app", "main.ts"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2]);
  });

  it("hands back the caller’s own data, not just the id", () => {
    const tree: TreeNode<{ path: string }>[] = [
      {
        id: "src",
        label: "src",
        data: { path: "src" },
        kind: "group",
        children: [
          {
            id: "main.ts",
            label: "main.ts",
            data: { path: "src/main.ts" },
            kind: "leaf",
            children: [],
          },
        ],
      },
    ];
    const rows = flattenTree(tree, new Set(["src"]));

    expect(rows[1].node.data).toEqual({ path: "src/main.ts" });
  });

  it("marks the last child at each level", () => {
    const tree = [group("a", [leaf("a1"), leaf("a2"), leaf("a3")])];
    const rows = flattenTree(tree, new Set(["a"]));

    expect(rows.map((row) => row.isLast)).toEqual([true, false, false, true]);
  });

  it("draws no ancestor line under a root, even when that root has a sibling", () => {
    // The roots sit in their own column with nothing to their left, so a child of
    // the first root must not draw a line down to the second one.
    const tree = [group("a", [leaf("a1")]), leaf("b")];
    const rows = flattenTree(tree, new Set(["a"]));

    expect(rows[0].ancestorContinues).toEqual([]);
    expect(rows[1].ancestorContinues).toEqual([false]);
    expect(rows[2].ancestorContinues).toEqual([]);
  });

  it("continues a non-root ancestor that still has a sibling below", () => {
    // `top/x` has a sibling `top/y`, so the child of `top/x` carries the line.
    const tree = [group("top", [group("x", [leaf("x1")]), leaf("y")])];
    const rows = flattenTree(tree, new Set(["top", "x"]));

    expect(ids(rows)).toEqual(["top", "x", "x1", "y"]);
    // Outermost first: `top` is a root and draws nothing, `x` is not last so it
    // draws the line down to `y`.
    expect(rows[2].ancestorContinues).toEqual([false, true]);
    // The prefix reads top-to-bottom: a gap for the root, then the line, then the corner.
    expect(treePrefix(rows[2])).toBe("  │ └─");
  });

  it("stops the line at the last root, so the branch is not joined to nothing", () => {
    const tree = [leaf("a"), group("b", [leaf("b1")])];
    const rows = flattenTree(tree, new Set(["b"]));

    // b is the last root; its child has no sibling below b to connect to.
    expect(rows[2].ancestorContinues).toEqual([false]);
  });
});

describe("treePrefix", () => {
  it("draws nothing for a root", () => {
    expect(treePrefix({ depth: 0, isLast: true, ancestorContinues: [] })).toBe(
      "",
    );
  });

  it("draws the corner for the last child and the tee otherwise", () => {
    expect(treePrefix({ depth: 1, isLast: true, ancestorContinues: [false] })).toBe(
      "  └─",
    );
    expect(treePrefix({ depth: 1, isLast: false, ancestorContinues: [false] })).toBe(
      "  ├─",
    );
  });

  it("draws a line per continuing ancestor and a gap per finished one", () => {
    expect(
      treePrefix({ depth: 2, isLast: true, ancestorContinues: [true] }),
    ).toBe("│ └─");
    expect(
      treePrefix({ depth: 2, isLast: false, ancestorContinues: [false] }),
    ).toBe("  ├─");
    expect(
      treePrefix({ depth: 3, isLast: true, ancestorContinues: [true, false] }),
    ).toBe("│   └─");
  });

  it("lines the labels up whatever the ancestors did", () => {
    const continuing = treePrefix({
      depth: 2,
      isLast: true,
      ancestorContinues: [true],
    });
    const finished = treePrefix({
      depth: 2,
      isLast: true,
      ancestorContinues: [false],
    });

    expect(continuing.length).toBe(finished.length);
  });
});
