import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentStore, type PendingPin } from '../../core/attachments';
import { AnimationService } from '../../core/animation.service';
import { MorseService } from '../../core/morse.service';
import { WorkspaceFiles } from '../../core/workspace-files';
import { WorkspaceTabs, type FileTab } from '../../core/workspace-tabs';
import { FilePreview } from './file-preview';

/** What the stubbed host answers for each language-server command. */
interface LspAnswers {
  diagnostics?: unknown;
  hover?: unknown;
  definition?: unknown;
  references?: unknown;
}

function render(
  tab: Partial<FileTab>,
  status?: unknown,
  lsp?: LspAnswers,
): {
  fixture: ComponentFixture<FilePreview>;
  attachments: {
    pin: ReturnType<typeof vi.fn>;
    setPinRange: ReturnType<typeof vi.fn>;
    removePin: ReturnType<typeof vi.fn>;
    say: ReturnType<typeof vi.fn>;
  };
  animation: { confetti: ReturnType<typeof vi.fn> };
  tabs: { reload: ReturnType<typeof vi.fn>; loadDiff: ReturnType<typeof vi.fn>; openFile: ReturnType<typeof vi.fn>; revealLine: ReturnType<typeof vi.fn> };
  morse: { requestHostCommand: ReturnType<typeof vi.fn> };
  pins: ReturnType<typeof signal<PendingPin[]>>;
} {
  const pins = signal<PendingPin[]>([]);
  const animation = { confetti: vi.fn() };
  const tabs = { reload: vi.fn(), loadDiff: vi.fn(), openFile: vi.fn(), revealLine: vi.fn() };
  const morse = {
    capabilities: signal(lsp === undefined ? {} : { lsp: true }),
    requestHostCommand: vi.fn((command: string) =>
      Promise.resolve(
        command === 'lspDiagnostics'
          ? lsp?.diagnostics
          : command === 'lspHover'
            ? lsp?.hover
            : command === 'lspDefinition'
              ? lsp?.definition
              : lsp?.references,
      ),
    ),
  };
  let counter = 0;
  const attachments = {
    pins: pins.asReadonly(),
    // Mirrors the real store closely enough for the preview: a pin shows up,
    // `replaceId` edits in place, and a touching range is absorbed (a merge).
    pin: vi.fn((next: Omit<PendingPin, 'id'>, replaceId?: string) => {
      const newId = replaceId ?? `pin-${(counter += 1)}`;
      pins.update((list) => {
        const base =
          replaceId === undefined
            ? [...list, { ...next, id: newId }]
            : list.map((item) =>
                item.id === replaceId ? { ...next, id: replaceId } : item,
              );
        const start = next.startLine ?? 0;
        const end = next.endLine ?? start;
        return base.filter((item) => {
          if (item.id === newId || item.startLine === undefined) {
            return true;
          }
          const itemStart = item.startLine;
          const itemEnd = item.endLine ?? itemStart;
          return !(itemStart <= end + 1 && itemEnd + 1 >= start);
        });
      });
      return newId;
    }),
    setPinRange: vi.fn((id: string, range: { startLine: number; endLine?: number }) => {
      pins.update((list) =>
        list.map((item) => (item.id === id ? { ...item, ...range } : item)),
      );
    }),
    removePin: vi.fn((id: string) => {
      pins.update((list) => list.filter((item) => item.id !== id));
    }),
    say: vi.fn(),
  };
  TestBed.configureTestingModule({
    imports: [FilePreview],
    providers: [
      { provide: WorkspaceTabs, useValue: tabs },
      { provide: AttachmentStore, useValue: attachments },
      { provide: AnimationService, useValue: animation },
      // The host is stubbed rather than real: `capabilities` is what decides
      // whether the preview offers the language server at all, and the answers
      // are what it renders.
      { provide: MorseService, useValue: morse },
      {
        provide: WorkspaceFiles,
        useValue: {
          status: signal(status),
          files: signal([]),
          busy: signal(false),
          error: signal(undefined),
          refresh: vi.fn(),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(FilePreview);
  fixture.componentRef.setInput('tab', {
    kind: 'file',
    id: 'file:src/main.ts',
    path: 'src/main.ts',
    title: 'main.ts',
    language: 'typescript',
    loading: false,
    ...tab,
  } satisfies FileTab);
  fixture.detectChanges();
  return { fixture, attachments, animation, tabs, morse, pins };
}

/** The gutter's line numbers, in order. */
function numbers(fixture: ComponentFixture<FilePreview>): string[] {
  return [...fixture.nativeElement.querySelectorAll('.gutter .num')].map(
    (node: Element) => node.textContent ?? '',
  );
}

/** Picks a preview mode (the choice persists in localStorage across tests). */
function setDiffMode(fixture: ComponentFixture<FilePreview>, title: string): void {
  const host = fixture.nativeElement as HTMLElement;
  host.querySelector<HTMLButtonElement>(`.modes button[title="${title}"]`)?.click();
  fixture.detectChanges();
}

function press(element: Element, type: string, clientY = 0): void {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY }));
}

describe('FilePreview', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('highlights the source and numbers the lines', () => {
    const { fixture } = render({ content: 'const x = 1;\nconst y = 2;\n', size: 26 });

    const source = fixture.nativeElement.querySelector('.source');
    expect(source?.textContent).toContain('const x = 1;');
    // The registered language actually highlighted it, rather than falling back.
    expect(source?.querySelector('.hljs-keyword')).not.toBeNull();
    expect(numbers(fixture)).toEqual(['1', '2']);
  });

  it('shows a unified diff for a changed file, and a split one on request', () => {
    const { fixture } = render(
      {
        content: 'const a = 2;\n',
        diff:
          'diff --git a/a b/a\nindex 111..222 100644\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n const b = 3;\n',
      },
      { isRepo: true, files: [{ path: 'src/main.ts', status: ' M' }] },
    );
    const host = fixture.nativeElement as HTMLElement;

    // The default view is the unified diff: one removed, one added line, both
    // syntax-highlighted like the file view.
    expect(host.querySelectorAll('.diff .drow.add')).toHaveLength(1);
    expect(host.querySelectorAll('.diff .drow.del')).toHaveLength(1);
    expect(host.querySelector('.diff .drow.add .hljs-keyword')).not.toBeNull();

    host.querySelector<HTMLButtonElement>('.modes button[title="Side-by-side diff"]')?.click();
    fixture.detectChanges();
    // One change pair (del/add) plus one context pair.
    expect(host.querySelectorAll('.diff.split .srow')).toHaveLength(2);
  });

  it('shows a commit tab as a diff, without the working-tree File view', () => {
    const { fixture } = render({
      id: 'commit:abc123:src/main.ts',
      path: 'src/main.ts',
      commitHash: 'abc123',
      commitSubject: 'A commit',
      diff:
        'diff --git a/a b/a\nindex 111..222 100644\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n const b = 3;\n',
    });
    setDiffMode(fixture, 'Unified diff');
    const host = fixture.nativeElement as HTMLElement;

    // The diff renders even though the working tree reports no status for it.
    expect(host.querySelectorAll('.diff .drow.add')).toHaveLength(1);
    // A commit has no honest "File" view (the disk content is not the commit's).
    expect(host.querySelector('.modes button[title="The file\'s content"]')).toBeNull();
    expect(host.querySelector('.commit-ref')?.textContent).toContain('abc123');
  });

  it('says a truncated file was cut short', () => {
    const { fixture } = render({ content: 'a\n', truncated: true, size: 2_097_152 });

    expect(fixture.nativeElement.querySelector('.hint')?.textContent).toContain('first 512 KB');
    expect(fixture.nativeElement.querySelector('.stat')?.textContent).toContain('2.0 MB');
  });

  it('shows no code for a binary file', () => {
    const { fixture } = render({ content: '', binary: true, size: 2_048 });

    expect(fixture.nativeElement.querySelector('.code')).toBeNull();
    expect(fixture.nativeElement.querySelector('.hint')?.textContent).toContain('Binary file');
  });

  it('reports a read failure instead of an empty editor', () => {
    const { fixture } = render({ error: 'Could not read this file.' });

    expect(fixture.nativeElement.querySelector('.hint.error')?.textContent).toContain(
      'Could not read this file.',
    );
  });

  it('shows a loading line while the host reads', () => {
    const { fixture } = render({ loading: true });

    expect(fixture.nativeElement.querySelector('.hint')?.textContent).toContain('Reading main.ts');
  });

  it('pins a single clicked line without an end line', () => {
    const { fixture, attachments } = render({ content: 'a\nb\nc\n' });

    const second = fixture.nativeElement.querySelectorAll('.gutter .num')[1] as Element;
    press(second, 'pointerdown');
    press(second, 'pointerup');
    fixture.detectChanges();

    expect(attachments.pin).toHaveBeenCalledWith(
      { path: 'src/main.ts', startLine: 2, endLine: undefined },
      undefined,
    );
    expect(fixture.nativeElement.querySelectorAll('.selection')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('.gutter .num.selected')).toHaveLength(1);
  });

  it('edits the pin a drag started inside instead of adding another', () => {
    const { fixture, attachments, pins } = render({ content: 'a\nb\nc\nd\n' });
    pins.set([{ id: 'p1', path: 'src/main.ts', startLine: 1, endLine: 3 }]);
    fixture.detectChanges();

    // Line 2 is inside the existing pin, so this drag redefines it. It has to
    // actually move: a click with no movement is the removal gesture below.
    const second = fixture.nativeElement.querySelectorAll('.gutter .num')[1] as Element;
    press(second, 'pointerdown');
    press(second, 'pointermove', 30);
    press(second, 'pointerup');
    fixture.detectChanges();

    const [range, replaced] = attachments.pin.mock.calls[0] as [
      { startLine: number },
      string | undefined,
    ];
    expect(replaced).toBe('p1');
    expect(range.startLine).toBe(2);
    // One band, not two: the drag redefined the pin rather than adding one.
    expect(fixture.nativeElement.querySelectorAll('.selection')).toHaveLength(1);
  });

  it('removes a highlight when its line number is clicked', () => {
    const { fixture, attachments, pins } = render({ content: 'a\nb\nc\nd\n' });
    pins.set([{ id: 'p1', path: 'src/main.ts', startLine: 1, endLine: 3 }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.selection')).toHaveLength(1);

    // A click without movement inside the highlight takes it off again — the same
    // toggle the diff view's change blocks use, and it takes the composer's chip
    // with it, because the bands are derived from the pins.
    const second = fixture.nativeElement.querySelectorAll('.gutter .num')[1] as Element;
    press(second, 'pointerdown');
    press(second, 'pointerup');
    fixture.detectChanges();

    expect(attachments.removePin).toHaveBeenCalledWith('p1');
    expect(attachments.pin).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelectorAll('.selection')).toHaveLength(0);
    expect(fixture.nativeElement.querySelectorAll('.gutter .num.selected')).toHaveLength(0);
  });

  it('abandons a range being dragged when Escape is pressed', () => {
    const { fixture, attachments } = render({ content: 'a\nb\nc\n' });

    const second = fixture.nativeElement.querySelectorAll('.gutter .num')[1] as Element;
    press(second, 'pointerdown');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.gutter .num.selected')).toHaveLength(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.gutter .num.selected')).toHaveLength(0);
    // Released with nothing selected: no pin is created either.
    press(second, 'pointerup');
    expect(attachments.pin).not.toHaveBeenCalled();
  });

  it('cancels a highlight from the band’s own button', () => {
    const { fixture, attachments, pins } = render({ content: 'a\nb\nc\nd\n' });
    pins.set([
      { id: 'p1', path: 'src/main.ts', startLine: 1, endLine: 2 },
      { id: 'p2', path: 'src/main.ts', startLine: 4, endLine: 4 },
    ]);
    fixture.detectChanges();

    // One band, one button — each in the corner its band ends in.
    const buttons = fixture.nativeElement.querySelectorAll('.selection .cancel');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent?.trim()).toBe('Cancel');

    (buttons[0] as HTMLElement).click();
    fixture.detectChanges();

    expect(attachments.removePin).toHaveBeenCalledWith('p1');
    expect(attachments.pin).not.toHaveBeenCalled();
    // The other highlight is untouched, button included.
    expect(fixture.nativeElement.querySelectorAll('.selection')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('.selection .cancel')).toHaveLength(1);
  });

  it('cancels a range being dragged from the same button', () => {
    const { fixture, attachments } = render({ content: 'a\nb\nc\n' });

    const second = fixture.nativeElement.querySelectorAll('.gutter .num')[1] as Element;
    press(second, 'pointerdown');
    fixture.detectChanges();

    // A drag in progress draws the same band, so it carries the same way out —
    // a range can be abandoned without going back to the gutter.
    const cancel = fixture.nativeElement.querySelector('.selection .cancel') as HTMLElement;
    expect(cancel).not.toBeNull();
    cancel.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.gutter .num.selected')).toHaveLength(0);
    // The release that follows finds nothing selected and pins nothing.
    press(second, 'pointerup');
    expect(attachments.pin).not.toHaveBeenCalled();
  });

  it('pins a dragged range as path:start-end', () => {
    const { fixture, attachments } = render({ content: 'a\nb\nc\nd\n' });

    const first = fixture.nativeElement.querySelectorAll('.gutter .num')[0] as Element;
    press(first, 'pointerdown');
    press(first, 'pointermove', 40);
    press(first, 'pointerup');
    fixture.detectChanges();

    // The exact line the drag lands on depends on the measured line box (a real
    // browser resolves the CSS line-height; jsdom does not), so this checks the
    // range grew and was pinned, not a hard-coded end line.
    const pinned = attachments.pin.mock.calls[0]?.[0] as { startLine: number; endLine?: number };
    expect(pinned.startLine).toBe(1);
    expect(pinned.endLine).toBeGreaterThan(1);
    expect(fixture.nativeElement.querySelectorAll('.selection')).toHaveLength(1);
  });

  it('moves a highlight edge without merging until the drag is released', () => {
    const { fixture, attachments, pins } = render({ content: 'a\nb\nc\nd\ne\nf\n' });
    pins.set([{ id: 'p1', path: 'src/main.ts', startLine: 1, endLine: 2 }]);
    fixture.detectChanges();

    const bottom = fixture.nativeElement.querySelector('.selection .edge.bottom') as Element;
    expect(bottom).not.toBeNull();
    press(bottom, 'pointerdown');
    press(bottom, 'pointermove', 40);
    fixture.detectChanges();

    // While the pointer is down the range only moves: no chip is created or
    // merged, so a neighbour never disappears mid-drag.
    expect(attachments.setPinRange).toHaveBeenCalled();
    expect(attachments.pin).not.toHaveBeenCalled();
    expect(pins()).toHaveLength(1);
    expect(pins()[0].startLine).toBe(1);
    expect(pins()[0].endLine).toBeGreaterThan(2);

    // Releasing is what coalesces (the store owns the union).
    press(bottom, 'pointerup');
    expect(attachments.pin).toHaveBeenCalledWith(
      expect.objectContaining({ startLine: 1 }),
      'p1',
    );
  });

  it('bursts a celebration when a merge collapses two ranges', () => {
    const { fixture, animation, pins } = render({ content: 'a\nb\nc\nd\ne\nf\n' });
    pins.set([
      { id: 'p1', path: 'src/main.ts', startLine: 1, endLine: 2 },
      { id: 'p2', path: 'src/main.ts', startLine: 4, endLine: 5 },
    ]);
    fixture.detectChanges();

    const bottom = fixture.nativeElement.querySelectorAll('.selection .edge.bottom')[0] as Element;
    press(bottom, 'pointerdown');
    press(bottom, 'pointermove', 60);
    press(bottom, 'pointerup');
    fixture.detectChanges();

    // Two chips became one: the burst is the visual cue.
    expect(pins()).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.selection.merged')).not.toBeNull();
    expect(animation.confetti).toHaveBeenCalled();
  });

  it('pins a changed block when its diff row is clicked', () => {
    const { fixture, attachments } = render(
      {
        content: 'const a = 1;\nconst b = 3;\nconst c = 4;\n',
        diff: '@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n',
      },
      { isRepo: true, files: [{ path: 'src/main.ts', status: ' M' }] },
    );
    setDiffMode(fixture, 'Unified diff');

    const added = fixture.nativeElement.querySelector('.drow.add') as Element;
    expect(added).not.toBeNull();
    added.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    // The whole block (old line 2 -> new lines 2–3) becomes one chip.
    expect(attachments.pin).toHaveBeenCalledWith({
      path: 'src/main.ts',
      startLine: 2,
      endLine: 3,
    });
    expect(fixture.nativeElement.querySelectorAll('.drow.pinned')).toHaveLength(3);
    expect(attachments.say).toHaveBeenCalled();
  });

  it('pins a deletion at the new-file line it left behind', () => {
    const { fixture, attachments } = render(
      {
        content: 'const a = 1;\nconst c = 3;\n',
        diff: '@@ -1,3 +1,2 @@\n const a = 1;\n-const b = 2;\n const c = 3;\n',
      },
      { isRepo: true, files: [{ path: 'src/main.ts', status: ' M' }] },
    );
    setDiffMode(fixture, 'Unified diff');

    const removed = fixture.nativeElement.querySelector('.drow.del') as Element;
    removed.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    expect(attachments.pin).toHaveBeenCalledWith({
      path: 'src/main.ts',
      startLine: 2,
      endLine: undefined,
    });
  });

  it('unpins a change when its highlighted block is clicked again', () => {
    const { fixture, attachments, pins } = render(
      {
        content: 'const a = 1;\nconst b = 3;\n',
        diff: '@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n',
      },
      { isRepo: true, files: [{ path: 'src/main.ts', status: ' M' }] },
    );
    pins.set([{ id: 'p1', path: 'src/main.ts', startLine: 2, endLine: 2 }]);
    fixture.detectChanges();
    setDiffMode(fixture, 'Unified diff');

    const added = fixture.nativeElement.querySelector('.drow.add') as Element;
    added.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    expect(attachments.removePin).toHaveBeenCalledWith('p1');
    expect(attachments.pin).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelectorAll('.drow.pinned')).toHaveLength(0);
  });

  it('pins a change from the side-by-side view too', () => {
    const { fixture, attachments } = render(
      {
        content: 'const a = 1;\nconst b = 3;\n',
        diff: '@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n',
      },
      { isRepo: true, files: [{ path: 'src/main.ts', status: ' M' }] },
    );
    const host = fixture.nativeElement as HTMLElement;
    setDiffMode(fixture, 'Side-by-side diff');

    const added = host.querySelector('.diff.split .side.add') as Element;
    expect(added).not.toBeNull();
    added.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    expect(attachments.pin).toHaveBeenCalledWith({
      path: 'src/main.ts',
      startLine: 2,
      endLine: undefined,
    });
    expect(host.querySelectorAll('.diff.split .side.pinned')).toHaveLength(2);
  });

  it('draws every range pinned to this file, and only this file', () => {
    const { fixture, pins } = render({ content: 'a\nb\nc\nd\n' });

    pins.set([
      { id: 'p1', path: 'src/main.ts', startLine: 1, endLine: 2 },
      { id: 'p2', path: 'src/main.ts', startLine: 4, endLine: 4 },
      { id: 'p3', path: 'other.ts', startLine: 1, endLine: 1 },
    ]);
    fixture.detectChanges();

    // Two bands, not one: the second drag adds to the first.
    expect(fixture.nativeElement.querySelectorAll('.selection')).toHaveLength(2);
    expect(fixture.nativeElement.querySelectorAll('.gutter .num.selected')).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('.range')?.textContent).toContain('2 ranges');

    // Removing a chip removes its highlight.
    pins.set([{ id: 'p2', path: 'src/main.ts', startLine: 4, endLine: 4 }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.selection')).toHaveLength(1);
  });
});

/** Lets the stubbed host answer, then paints the result. */
async function settle(fixture: ComponentFixture<FilePreview>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
}

const TWO_PROBLEMS = {
  path: 'src/main.ts',
  available: true,
  diagnostics: [
    {
      range: { start: { line: 0, character: 14 }, end: { line: 0, character: 17 } },
      severity: 'error',
      message: 'Type string is not assignable to number',
    },
    {
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
      severity: 'warning',
      message: 'Unused variable',
    },
  ],
};

/**
 * The text node holding `needle`, and the offset just inside it. jsdom implements
 * no caret API, so a hover test has to say where the pointer is.
 */
function caretInside(source: HTMLElement, needle: string): { offsetNode: Node; offset: number } {
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const at = text.indexOf(needle);
    if (at >= 0) {
      return { offsetNode: node, offset: at + Math.min(1, needle.length - 1) };
    }
  }
  throw new Error(`no text node holds ${needle}`);
}

/**
 * Installs the caret API a hover needs, and returns the undo. The document is
 * narrowed to the shape the component actually reads (`caretAt` in
 * `file-preview.ts`), which is also what makes `delete` legal: lib.dom declares
 * the real one as required.
 */
function stubCaret(source: HTMLElement, needle: string): () => void {
  const doc = document as unknown as {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  const caret = caretInside(source, needle);
  doc.caretPositionFromPoint = () => caret;
  return () => delete doc.caretPositionFromPoint;
}

/** A pointer event at a point; jsdom has no `PointerEvent`, a MouseEvent serves. */
function movePointer(element: Element, type: string, clientX = 40, clientY = 20): void {
  element.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }),
  );
}

/**
 * Opens a hover card and pins it, returning the fixture and the caret stub's
 * undo. Fake timers must already be installed: the lock clock is a timer.
 */
async function openLockedCard(extra: LspAnswers = {}): Promise<{
  fixture: ComponentFixture<FilePreview>;
  restore: () => void;
}> {
  const { fixture } = render({ content: 'alpha = 1;\n' }, undefined, {
    hover: { contents: 'const alpha: number' },
    ...extra,
  });
  await vi.advanceTimersByTimeAsync(0);
  fixture.detectChanges();

  const source = fixture.nativeElement.querySelector('.source') as HTMLElement;
  const restore = stubCaret(source, 'alpha');
  movePointer(source, 'pointermove');
  // The hover debounce, then the host's answer.
  await vi.advanceTimersByTimeAsync(200);
  fixture.detectChanges();
  // The lock clock starts when the card appears; run it out so the card is pinned.
  await vi.advanceTimersByTimeAsync(900);
  fixture.detectChanges();
  return { fixture, restore };
}

describe('FilePreview and the language server', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('counts the problems, lists them, and jumps to one', async () => {
    const { fixture, tabs } = render(
      { content: 'const a: number = "x";\n' },
      undefined,
      { diagnostics: TWO_PROBLEMS },
    );
    await settle(fixture);

    const badge = fixture.nativeElement.querySelector('.problems');
    expect(badge).not.toBeNull();
    // Whitespace-free: the glyph and the count are separate nodes.
    expect(badge.textContent.replace(/\s/g, '')).toBe('▲2');
    // An error is in there, so the badge reads as one.
    expect(badge.className).toContain('errors');

    (badge as HTMLElement).click();
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('.lsp-row.problem');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('not assignable');

    // A problem row sends this file to its line (1-based, as it renders).
    (rows[0] as HTMLElement).click();
    expect(tabs.revealLine).toHaveBeenCalledWith('file:src/main.ts', 1);
  });

  it('says so when no server covers the file, instead of showing a clean zero', async () => {
    const { fixture } = render(
      { content: 'note\n' },
      undefined,
      { diagnostics: { path: 'src/main.ts', available: false, diagnostics: [] } },
    );
    await settle(fixture);

    expect(fixture.nativeElement.querySelector('.lsp-none')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.problems')).toBeNull();
  });

  it('asks the host for this file, zero-based, with the longer timeout', async () => {
    const { fixture, morse } = render(
      { content: 'const a = 1;\n' },
      undefined,
      { diagnostics: { path: 'src/main.ts', available: true, diagnostics: [] } },
    );
    await settle(fixture);

    // No `cwd` on the wire: the host uses the session the client is viewing.
    expect(morse.requestHostCommand).toHaveBeenCalledWith(
      'lspDiagnostics',
      { path: 'src/main.ts' },
      45_000,
    );
  });

  it('never asks a host that has no language server', async () => {
    const { fixture, morse } = render({ content: 'const a = 1;\n' });
    await settle(fixture);

    expect(morse.requestHostCommand).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.lsp-none')).toBeNull();
    expect(fixture.nativeElement.querySelector('.problems')).toBeNull();
  });

  it('forwards the project a restored tab was read from', async () => {
    const { fixture, morse } = render(
      { content: 'const a = 1;\n', projectCwd: '/work/other' },
      undefined,
      { diagnostics: { path: 'src/main.ts', available: true, diagnostics: [] } },
    );
    await settle(fixture);

    expect(morse.requestHostCommand).toHaveBeenCalledWith(
      'lspDiagnostics',
      { path: 'src/main.ts', cwd: '/work/other' },
      45_000,
    );
  });

  it('counts down to a pinned card, then closes it with the button', async () => {
    vi.useFakeTimers();
    let restore = (): void => undefined;
    try {
      const { fixture } = render({ content: 'alpha = 1;\n' }, undefined, {
        hover: { contents: 'const alpha: number' },
      });
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();

      const source = fixture.nativeElement.querySelector('.source') as HTMLElement;
      restore = stubCaret(source, 'alpha');
      movePointer(source, 'pointermove');
      // The hover debounce, then the answer from the stubbed host.
      await vi.advanceTimersByTimeAsync(200);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.hover-card')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.lock-ring')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.hover-close')).toBeNull();

      // Staying on the symbol pins it, and the ring gives way to the button.
      await vi.advanceTimersByTimeAsync(900);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.hover-close')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.lock-ring')).toBeNull();

      // That is the point of the pin: leaving no longer takes the card with it.
      movePointer(source, 'pointerleave');
      await vi.advanceTimersByTimeAsync(1_000);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.hover-card')).not.toBeNull();

      (fixture.nativeElement.querySelector('.hover-close') as HTMLElement).click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.hover-card')).toBeNull();
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('keeps the card, and its clock, while the pointer stays on one symbol', async () => {
    vi.useFakeTimers();
    let restore = (): void => undefined;
    try {
      const { fixture, morse } = render({ content: 'alpha = 1;\n' }, undefined, {
        hover: { contents: 'const alpha: number' },
      });
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();

      const source = fixture.nativeElement.querySelector('.source') as HTMLElement;
      restore = stubCaret(source, 'alpha');
      movePointer(source, 'pointermove');
      await vi.advanceTimersByTimeAsync(200);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.hover-card')).not.toBeNull();

      // A second move inside the same identifier must not restart the countdown:
      // a resting pointer still moves a pixel. The card was set at ~140 ms (the
      // hover debounce), so its clock runs out at ~1040 ms; a restart would push
      // that to ~1240 ms. t≈1100 is past the first and short of the second.
      movePointer(source, 'pointermove', 41, 20);
      await vi.advanceTimersByTimeAsync(900);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.hover-close')).not.toBeNull();
      const hoverCalls = morse.requestHostCommand.mock.calls.filter(
        ([command]) => command === 'lspHover',
      );
      expect(hoverCalls.length).toBeLessThanOrEqual(2);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('dismisses the card when a press lands outside it', async () => {
    vi.useFakeTimers();
    const { fixture, restore } = await openLockedCard();
    try {
      // A pinned card is exactly the one that used to be stuck: this press lands
      // on the code beside it, which is "somewhere else".
      const source = fixture.nativeElement.querySelector('.source') as HTMLElement;
      movePointer(source, 'pointerdown');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.hover-card')).toBeNull();
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('leaves the card alone when the press lands on its own controls', async () => {
    vi.useFakeTimers();
    const { fixture, restore } = await openLockedCard();
    try {
      const refs = fixture.nativeElement.querySelector('.hover-refs') as HTMLElement;
      expect(refs).not.toBeNull();
      refs.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      fixture.detectChanges();

      // Copy, Find references and the ✕ are the card's own; only other targets
      // dismiss it.
      expect(fixture.nativeElement.querySelector('.hover-card')).not.toBeNull();
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('hands over to the references panel, and dismisses the card', async () => {
    vi.useFakeTimers();
    const { fixture, restore } = await openLockedCard({
      references: {
        path: 'src/main.ts',
        locations: [
          {
            path: 'src/other.ts',
            range: { start: { line: 9, character: 2 }, end: { line: 9, character: 8 } },
          },
        ],
      },
    });
    try {
      (fixture.nativeElement.querySelector('.hover-refs') as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();

      // The panel is the answer now: the card has done its job and steps aside.
      expect(fixture.nativeElement.querySelector('.hover-card')).toBeNull();
      const rows = fixture.nativeElement.querySelectorAll('.lsp-row');
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain('src/other.ts');
      expect(rows[0].textContent).toContain('10');
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('says so in the panel when no references come back', async () => {
    vi.useFakeTimers();
    // No `references` answer: a cold server, or one that cannot answer.
    const { fixture, restore } = await openLockedCard();
    try {
      (fixture.nativeElement.querySelector('.hover-refs') as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();

      // The card is gone either way, so the panel must not be blank.
      expect(fixture.nativeElement.querySelector('.hover-card')).toBeNull();
      expect(fixture.nativeElement.querySelector('.lsp-panel-title')?.textContent).toContain(
        'did not answer',
      );
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('takes over a pinned card when the pointer settles on another symbol', async () => {
    vi.useFakeTimers();
    let restore = (): void => undefined;
    try {
      const { fixture, morse } = render({ content: 'alpha beta\n' }, undefined, {
        hover: { contents: 'const alpha: number' },
      });
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      const source = fixture.nativeElement.querySelector('.source') as HTMLElement;

      restore = stubCaret(source, 'alpha');
      movePointer(source, 'pointermove');
      await vi.advanceTimersByTimeAsync(200);
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(900);
      fixture.detectChanges();
      // Pinned on `alpha`.
      expect(fixture.nativeElement.querySelector('.hover-close')).not.toBeNull();

      // Settling on `beta` takes the pinned card over instead of being ignored,
      // and the new card starts its own countdown.
      restore();
      restore = stubCaret(source, 'beta');
      movePointer(source, 'pointermove', 60, 20);
      await vi.advanceTimersByTimeAsync(200);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.hover-card')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.lock-ring')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.hover-close')).toBeNull();
      const hoverCalls = morse.requestHostCommand.mock.calls.filter(
        ([command]) => command === 'lspHover',
      );
      expect(hoverCalls).toHaveLength(2);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('lets a card survive a crossing, and go when the pointer rests off a symbol', async () => {
    vi.useFakeTimers();
    let restore = (): void => undefined;
    try {
      const { fixture } = render({ content: 'alpha beta\n' }, undefined, {
        hover: { contents: 'const alpha: number' },
      });
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      const source = fixture.nativeElement.querySelector('.source') as HTMLElement;

      restore = stubCaret(source, 'alpha');
      movePointer(source, 'pointermove');
      await vi.advanceTimersByTimeAsync(200);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.hover-card')).not.toBeNull();

      // Crossing the space between the two symbols on the way somewhere else: the
      // pointer barely pauses, so the card stays (this needs the settle, since the
      // move alone used to dismiss it).
      restore();
      restore = stubCaret(source, ' ');
      movePointer(source, 'pointermove', 60, 20);
      await vi.advanceTimersByTimeAsync(50);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.hover-card')).not.toBeNull();

      // Resting there, though, is the end of it.
      await vi.advanceTimersByTimeAsync(200);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.hover-card')).toBeNull();
    } finally {
      restore();
      vi.useRealTimers();
    }
  });
});
