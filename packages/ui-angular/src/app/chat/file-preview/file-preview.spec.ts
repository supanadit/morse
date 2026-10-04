import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentStore, type PendingPin } from '../../core/attachments';
import { AnimationService } from '../../core/animation.service';
import { WorkspaceFiles } from '../../core/workspace-files';
import { WorkspaceTabs, type FileTab } from '../../core/workspace-tabs';
import { FilePreview } from './file-preview';

function render(
  tab: Partial<FileTab>,
  status?: unknown,
): {
  fixture: ComponentFixture<FilePreview>;
  attachments: {
    pin: ReturnType<typeof vi.fn>;
    setPinRange: ReturnType<typeof vi.fn>;
    say: ReturnType<typeof vi.fn>;
  };
  animation: { confetti: ReturnType<typeof vi.fn> };
  pins: ReturnType<typeof signal<PendingPin[]>>;
} {
  const pins = signal<PendingPin[]>([]);
  const animation = { confetti: vi.fn() };
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
    say: vi.fn(),
  };
  TestBed.configureTestingModule({
    imports: [FilePreview],
    providers: [
      { provide: WorkspaceTabs, useValue: { reload: vi.fn(), loadDiff: vi.fn() } },
      { provide: AttachmentStore, useValue: attachments },
      { provide: AnimationService, useValue: animation },
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
  return { fixture, attachments, animation, pins };
}

/** The gutter's line numbers, in order. */
function numbers(fixture: ComponentFixture<FilePreview>): string[] {
  return [...fixture.nativeElement.querySelectorAll('.gutter .num')].map(
    (node: Element) => node.textContent ?? '',
  );
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

    // Line 2 is inside the existing pin, so this drag redefines it.
    const second = fixture.nativeElement.querySelectorAll('.gutter .num')[1] as Element;
    press(second, 'pointerdown');
    press(second, 'pointerup');
    fixture.detectChanges();

    expect(attachments.pin).toHaveBeenCalledWith(
      { path: 'src/main.ts', startLine: 2, endLine: undefined },
      'p1',
    );
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
