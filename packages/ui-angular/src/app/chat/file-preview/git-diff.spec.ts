import { describe, expect, it } from 'vitest';
import { addedFileDiff, parseUnifiedDiff, splitRows, unifiedRows } from './git-diff';

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
