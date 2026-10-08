import { describe, expect, it } from 'vitest';
import { addedFileDiff, parseUnifiedDiff, splitRows, unifiedRows } from './diff.js';

const DIFF = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;

describe('parseUnifiedDiff', () => {
  it('keeps line numbers and counts the changes', () => {
    const parsed = parseUnifiedDiff(DIFF);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
    const rows = parsed.hunks[0]!.rows;
    expect(rows.map((row) => row.kind)).toEqual(['context', 'del', 'add', 'add', 'context']);
    expect(rows[0]).toMatchObject({ oldLine: 1, newLine: 1 });
    expect(rows[1]).toMatchObject({ kind: 'del', oldLine: 2 });
    expect(rows[2]).toMatchObject({ kind: 'add', newLine: 2 });
  });

  it('ignores the file headers and a no-newline marker', () => {
    const parsed = parseUnifiedDiff(
      '--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n',
    );
    expect(parsed.hunks[0]!.rows.map((row) => row.kind)).toEqual(['del', 'add']);
  });

  it('marks a binary diff', () => {
    expect(parseUnifiedDiff('Binary files a/x and b/x differ\n').binary).toBe(true);
  });

  it('tags a change block with the new-file range it occupies', () => {
    const rows = parseUnifiedDiff(DIFF).hunks[0]!.rows;
    // Old line 2 became new lines 2–3, so the whole block is clickable as one.
    const range = { start: 2, end: 3 };
    expect(rows[1]).toMatchObject({ kind: 'del', newAnchor: 2, change: range });
    expect(rows[2]).toMatchObject({ kind: 'add', newAnchor: 2, change: range });
    expect(rows[3]).toMatchObject({ kind: 'add', newAnchor: 3, change: range });
    // Context rows belong to no change block.
    expect(rows[0]!.change).toBeUndefined();
  });

  it('gives a pure deletion the line it left behind', () => {
    const rows = parseUnifiedDiff('@@ -1,3 +1,2 @@\n a\n-b\n c\n').hunks[0]!.rows;
    expect(rows[1]).toMatchObject({
      kind: 'del',
      newAnchor: 2,
      change: { start: 2, end: 2 },
    });
  });
});

describe('unifiedRows', () => {
  it('puts a hunk header before its lines', () => {
    const rows = unifiedRows(parseUnifiedDiff(DIFF));
    expect(rows[0]).toMatchObject({ kind: 'hunk' });
    expect(rows).toHaveLength(6);
  });
});

describe('splitRows', () => {
  it('pairs a deletion with an addition and pads the shorter side', () => {
    const rows = splitRows(parseUnifiedDiff(DIFF)).filter((row) => row.hunk === undefined);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ left: { kind: 'del' }, right: { kind: 'add' } });
    expect(rows[2]!.left).toBeUndefined();
    expect(rows[2]!.right).toMatchObject({ kind: 'add' });
  });
});

describe('addedFileDiff', () => {
  it("turns an untracked file's content into an all-added hunk", () => {
    const diff = parseUnifiedDiff(addedFileDiff('one\ntwo\n'));
    expect(diff.additions).toBe(2);
    expect(diff.hunks[0]!.rows.every((row) => row.kind === 'add')).toBe(true);
  });
});
