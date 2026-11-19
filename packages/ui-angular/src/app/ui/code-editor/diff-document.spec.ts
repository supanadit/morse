import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '@morse/ui-runtime';
import {
  bandCandidates,
  type BandCandidate,
  blockPinned,
  changePinned,
  docLineForNew,
  docLineForOld,
  documentText,
  revealDocLine,
  splitDocuments,
  unifiedDocument,
} from './diff-document';

/** One hunk: a context line, a rewritten line, and an added line. */
const PARSED = parseUnifiedDiff(
  '@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n',
);

/** The candidate a pair would actually ride: the first, highest-ranked one. */
function best(candidates: readonly BandCandidate[]): BandCandidate | undefined {
  return candidates[0];
}

describe('the unified diff document', () => {
  it('drops hunk headers out of the document and keeps their row', () => {
    const document = unifiedDocument(PARSED);

    // Four rows, no `@@` among them: a hunk header is not a line of a file.
    expect(document.lines.map((line) => line.kind)).toEqual(['context', 'del', 'add', 'add']);
    expect(document.lines.map((line) => line.text)).toEqual([
      'const a = 1;',
      'const b = 2;',
      'const b = 3;',
      'const c = 4;',
    ]);
    // The header sits above the first row (0-based), and is drawn from there.
    expect(document.hunks).toEqual([{ line: 0, text: '@@ -1,2 +1,3 @@' }]);
  });

  it('draws the document text without trailing noise', () => {
    // One line per row: a trailing newline would be a row no file has.
    expect(documentText(unifiedDocument(PARSED))).toBe(
      'const a = 1;\nconst b = 2;\nconst b = 3;\nconst c = 4;',
    );
    expect(documentText({ lines: [], hunks: [] })).toBe('');
  });

  it('maps a new-file line to the row it sits on, and never past the document', () => {
    const document = unifiedDocument(PARSED);

    expect(docLineForNew(document, 1)).toBe(1);
    expect(docLineForNew(document, 3)).toBe(4);
    // A line the hunk does not show has no row of its own.
    expect(docLineForNew(document, 99)).toBeUndefined();
  });

  it('maps an old-file line to the row it sits on, deletions included', () => {
    const document = unifiedDocument(PARSED);

    expect(docLineForOld(document, 2)).toBe(2);
    // Old line 3 was rewritten into new line 3; the old side never shows it.
    expect(docLineForOld(document, 3)).toBeUndefined();
  });

  it('reveals the new file’s line first and the old one only when it must', () => {
    const document = unifiedDocument(parseUnifiedDiff('@@ -1,1 +1,1 @@\n-old only\n'));

    // The row is a deletion: no new line, so a jump for its old number lands there.
    expect(revealDocLine(document, 1)).toBe(1);
    expect(revealDocLine(unifiedDocument(PARSED), 3)).toBe(4);
  });

  it('puts a pin’s pair on the bottom-most changed row of its band', () => {
    const document = unifiedDocument(PARSED);

    // The pin ends on new line 3, where the two additions land: the last of them.
    expect(best(bandCandidates(document, { startLine: 2, endLine: 3 }))).toEqual({
      line: 4,
      rank: 0,
    });
    // A pin over unchanged lines can only ride the context row that shows them.
    expect(best(bandCandidates(document, { startLine: 1, endLine: 1 }))).toEqual({
      line: 1,
      rank: 1,
    });
  });

  it('puts one pair on a deleted block, on its last row', () => {
    // Two deleted rows, both anchored on the same new-file line: matching the anchor
    // alone would paint a pair on each of them.
    const document = unifiedDocument(
      parseUnifiedDiff('@@ -1,4 +1,2 @@\n const a = 1;\n-const b = 2;\n-const b2 = 2;\n const c = 3;\n'),
    );

    // The last deleted row, not the unchanged row that follows it on the same anchor.
    expect(best(bandCandidates(document, { startLine: 2, endLine: 2 }))).toEqual({
      line: 3,
      rank: 0,
    });
  });
});

describe('the split documents', () => {
  it('pairs the two sides row for row, blank-filling the short one', () => {
    const { left, right } = splitDocuments(PARSED);

    // Context, the rewrite (del + add), then the addition with nothing on the old side.
    expect(left.lines.map((line) => line.text)).toEqual(['const a = 1;', 'const b = 2;', '']);
    expect(right.lines.map((line) => line.text)).toEqual(['const a = 1;', 'const b = 3;', 'const c = 4;']);
    expect(left.lines.map((line) => line.kind)).toEqual(['context', 'del', 'blank']);
    expect(right.lines.map((line) => line.kind)).toEqual(['context', 'add', 'add']);
  });

  it('keeps hunk headers on the same row of both sides', () => {
    const parsed = parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n');
    const { left, right } = splitDocuments(parsed);

    expect(left.hunks).toEqual(right.hunks);
    expect(left.hunks.map((hunk) => hunk.line)).toEqual([0, 1]);
    expect(left.lines).toHaveLength(2);
  });

  it('ranks a deletion’s own row above the unchanged line the new side shows', () => {
    const parsed = parseUnifiedDiff('@@ -1,3 +1,2 @@\n const a = 1;\n-const b = 2;\n const c = 3;\n');
    const { left, right } = splitDocuments(parsed);
    const pin = { startLine: 2, endLine: 2 };

    // New line 2 is the unchanged `const c = 3;`, so the new side can only offer a
    // context row; the old side has the deleted row itself, which outranks it.
    expect(best(bandCandidates(right, pin))).toEqual({ line: 3, rank: 1 });
    expect(best(bandCandidates(left, pin))).toEqual({ line: 2, rank: 0 });
  });

  it('ranks an addition’s own row above everything on the old side', () => {
    const { left, right } = splitDocuments(PARSED);
    const pin = { startLine: 3, endLine: 3 };

    // The addition is the new side's; the old side pads that row with a blank.
    expect(best(bandCandidates(right, pin))).toEqual({ line: 3, rank: 0 });
    expect(bandCandidates(left, pin)).toEqual([]);
  });
});

describe('the pin a diff block carries', () => {
  it('covers a row whose anchor sits inside the pin’s range', () => {
    expect(changePinned([{ id: 'p1', startLine: 2, endLine: 4 }], 3)).toBe(true);
    expect(changePinned([{ id: 'p1', startLine: 2, endLine: 4 }], 5)).toBe(false);
    expect(changePinned([], 3)).toBe(false);
    expect(changePinned([{ id: 'p1', startLine: 2 }], undefined)).toBe(false);
  });

  it('counts a block as pinned only when one pin covers the whole block', () => {
    const change = { start: 3, end: 6 };

    expect(blockPinned([{ id: 'p1', startLine: 3, endLine: 6 }], change)).toBe(true);
    // A partial record is still clickable: the click completes it, not duplicates it.
    expect(blockPinned([{ id: 'p1', startLine: 4, endLine: 5 }], change)).toBe(false);
    expect(blockPinned([], change)).toBe(false);
    expect(blockPinned([{ id: 'p1', startLine: 3, endLine: 6 }], undefined)).toBe(false);
  });
});
