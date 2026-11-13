import { Component, input, output, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentStore, type PendingPin } from '../../state/attachments';
import { WorkspaceFilesStore } from '../../state/workspace-files.store';
import { WorkspaceTabs, type FileTab } from '../../state/workspace-tabs';
import { CODE_EDITOR_LOADER } from '../../ui/code-editor/code-editor-loader';
import type { EditorPin } from '../../ui/code-editor/pins';
import type { PinRequest } from '../../ui/code-editor/pin-selection';
import { FilePreview } from './file-preview';

/**
 * The editor's stand-in: an `EditorView` needs layout jsdom does not provide, so
 * the feature's specs drive its inputs and emit its outputs instead.
 */
@Component({
  selector: 'morse-fake-code-editor',
  template: '',
  standalone: true,
})
class FakeEditor {
  readonly text = input('');
  readonly path = input('');
  readonly line = input<number | undefined>(undefined);
  readonly pins = input<readonly EditorPin[]>([]);
  readonly pinRequested = output<PinRequest>();
  readonly noteEdited = output<{ id: string; note: string }>();
  readonly unpinned = output<{ id: string }>();
}

function render(
  tab: Partial<FileTab>,
  status?: unknown,
): {
  fixture: ComponentFixture<FilePreview>;
  attachments: {
    pin: ReturnType<typeof vi.fn>;
    setPinNote: ReturnType<typeof vi.fn>;
    removePin: ReturnType<typeof vi.fn>;
    say: ReturnType<typeof vi.fn>;
  };
  pins: ReturnType<typeof signal<PendingPin[]>>;
} {
  const pins = signal<PendingPin[]>([]);
  const attachments = {
    pins: pins.asReadonly(),
    pin: vi.fn((next: Omit<PendingPin, 'id'>, replaceId?: string) => {
      const id = replaceId ?? `pin-${pins().length + 1}`;
      pins.update((list) =>
        replaceId === undefined
          ? [...list, { ...next, id }]
          : list.map((item) => (item.id === replaceId ? { ...next, id: replaceId } : item)),
      );
      return id;
    }),
    setPinNote: vi.fn((id: string, note: string | undefined) => {
      pins.update((list) => list.map((item) => (item.id === id ? { ...item, note } : item)));
    }),
    removePin: vi.fn((id: string) => {
      pins.update((list) => list.filter((item) => item.id !== id));
    }),
    say: vi.fn(),
  };
  TestBed.configureTestingModule({
    imports: [FilePreview],
    providers: [
      { provide: WorkspaceTabs, useValue: { reload: vi.fn(), loadDiff: vi.fn() } },
      { provide: AttachmentStore, useValue: attachments },
      {
        provide: WorkspaceFilesStore,
        useValue: {
          status: signal(status),
          files: signal([]),
          busy: signal(false),
          error: signal(undefined),
          refresh: vi.fn(),
        },
      },
      { provide: CODE_EDITOR_LOADER, useValue: async () => FakeEditor },
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
  return { fixture, attachments, pins };
}

/** `render`, then wait for the lazy editor class to land and mount. */
async function mount(
  tab: Partial<FileTab>,
  status?: unknown,
): Promise<ReturnType<typeof render>> {
  const result = render(tab, status);
  await result.fixture.whenStable();
  result.fixture.detectChanges();
  return result;
}

function editorOf(fixture: ComponentFixture<FilePreview>): FakeEditor | undefined {
  return fixture.debugElement.query(By.directive(FakeEditor))?.componentInstance as
    | FakeEditor
    | undefined;
}

/** Picks a preview mode (the choice persists in localStorage across tests). */
function setDiffMode(fixture: ComponentFixture<FilePreview>, title: string): void {
  const host = fixture.nativeElement as HTMLElement;
  host.querySelector<HTMLButtonElement>(`.modes button[title="${title}"]`)?.click();
  fixture.detectChanges();
}

describe('FilePreview', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('hands the file to the editor', async () => {
    const { fixture } = await mount({ content: 'const x = 1;\n', size: 13 });

    const editor = editorOf(fixture);
    expect(editor?.text()).toBe('const x = 1;\n');
    expect(editor?.path()).toBe('src/main.ts');
  });

  it('hands a jump line to the editor', async () => {
    const { fixture } = await mount({ content: 'a\nb\n', line: 2 });

    expect(editorOf(fixture)?.line()).toBe(2);
  });

  it('hands only this file’s pins to the editor', async () => {
    const { fixture, pins } = await mount({ content: 'a\nb\n' });
    pins.set([
      { id: 'p1', path: 'src/main.ts', startLine: 1 },
      { id: 'p2', path: 'src/other.ts', startLine: 2 },
    ]);
    fixture.detectChanges();

    expect(editorOf(fixture)?.pins().map((pin) => pin.id)).toEqual(['p1']);
  });

  it('pins a range the editor reports', async () => {
    const { fixture, attachments } = await mount({ content: 'a\nb\nc\n' });

    editorOf(fixture)?.pinRequested.emit({ startLine: 2, endLine: 3, characters: 4 });
    fixture.detectChanges();

    expect(attachments.pin).toHaveBeenCalledWith({
      path: 'src/main.ts',
      startLine: 2,
      endLine: 3,
      characters: 4,
    });
  });

  it('writes a note edited in a card onto its pin', async () => {
    const { fixture, attachments } = await mount({ content: 'a\n' });

    editorOf(fixture)?.noteEdited.emit({ id: 'p1', note: 'why' });
    fixture.detectChanges();

    expect(attachments.setPinNote).toHaveBeenCalledWith('p1', 'why');
  });

  it('clears a note emptied in a card', async () => {
    const { fixture, attachments } = await mount({ content: 'a\n' });

    editorOf(fixture)?.noteEdited.emit({ id: 'p1', note: '   ' });
    fixture.detectChanges();

    expect(attachments.setPinNote).toHaveBeenCalledWith('p1', undefined);
  });

  it('unpins from a card', async () => {
    const { fixture, attachments } = await mount({ content: 'a\n' });

    editorOf(fixture)?.unpinned.emit({ id: 'p1' });
    fixture.detectChanges();

    expect(attachments.removePin).toHaveBeenCalledWith('p1');
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

  it('says a truncated file was cut short', async () => {
    const { fixture } = await mount({ content: 'a\n', truncated: true, size: 2_097_152 });

    expect(fixture.nativeElement.querySelector('.hint')?.textContent).toContain('first 512 KB');
    expect(fixture.nativeElement.querySelector('.stat')?.textContent).toContain('2.0 MB');
  });

  it('shows no editor for a binary file', async () => {
    const { fixture } = await mount({ content: '', binary: true, size: 2_048 });

    expect(editorOf(fixture)).toBeUndefined();
    expect(fixture.nativeElement.querySelector('.hint')?.textContent).toContain('Binary file');
  });

  it('reports a read failure instead of an empty editor', async () => {
    const { fixture } = await mount({ error: 'Could not read this file.' });

    expect(fixture.nativeElement.querySelector('.hint.error')?.textContent).toContain(
      'Could not read this file.',
    );
  });

  it('shows a loading line while the host reads', async () => {
    const { fixture } = await mount({ loading: true });

    expect(fixture.nativeElement.querySelector('.hint')?.textContent).toContain('Reading main.ts');
  });
});

describe('FilePreview annotations', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('sits the file preview’s note and Cancel on the diff row the pin ends on', () => {
    const { fixture, pins, attachments } = render(
      {
        content: 'const a = 1;\nconst b = 3;\nconst c = 4;\n',
        diff: '@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n',
      },
      { isRepo: true, files: [{ path: 'src/main.ts', status: ' M' }] },
    );
    pins.set([{ id: 'p1', path: 'src/main.ts', startLine: 2, endLine: 3, note: 'the block' }]);
    fixture.detectChanges();
    setDiffMode(fixture, 'Unified diff');

    // Last add row of the block carries the pair the file preview uses.
    const actions = fixture.nativeElement.querySelectorAll('.drow.add morse-pin-actions');
    expect(actions).toHaveLength(1);
    const note = actions[0]?.querySelector('button.note');
    expect(note?.textContent).toContain('the block');
    expect(actions[0]?.querySelector('button.cancel')?.textContent).toContain('Cancel');

    // Opening the note must not read as “unpin this block”.
    note?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(attachments.removePin).not.toHaveBeenCalled();
    const host = fixture.nativeElement as HTMLElement;
    const card = host.querySelector('morse-pin-annotation') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector('.range')?.textContent).toContain('L2-3');
  });

  it('unpins the range from the diff row’s Cancel, exactly once', () => {
    const { fixture, pins, attachments } = render(
      {
        content: 'const a = 1;\nconst b = 3;\n',
        diff: '@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 3;\n',
      },
      { isRepo: true, files: [{ path: 'src/main.ts', status: ' M' }] },
    );
    pins.set([{ id: 'p1', path: 'src/main.ts', startLine: 2, endLine: 2 }]);
    fixture.detectChanges();
    setDiffMode(fixture, 'Unified diff');

    const cancel = fixture.nativeElement.querySelector('.drow.add morse-pin-actions button.cancel');
    cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    // The row's own click would unpin too; the pair stops it, so one press is one removal.
    expect(attachments.removePin).toHaveBeenCalledTimes(1);
    expect(attachments.removePin).toHaveBeenCalledWith('p1');
  });

  it('hosts the deletion pin’s note and Cancel on the old side when there is no new row', () => {
    const { fixture, pins } = render(
      {
        content: 'const a = 1;\nconst c = 3;\n',
        diff: '@@ -1,3 +1,2 @@\n const a = 1;\n-const b = 2;\n const c = 3;\n',
      },
      { isRepo: true, files: [{ path: 'src/main.ts', status: ' M' }] },
    );
    // The deletion at the end of its hunk: in the split view the new side never
    // shows line 2, so the old (deleted) side hosts the affordance instead.
    pins.set([{ id: 'p1', path: 'src/main.ts', startLine: 2, endLine: 2 }]);
    fixture.detectChanges();

    // Unified diff first: the row is the deletion itself, so it carries it.
    setDiffMode(fixture, 'Unified diff');
    expect(fixture.nativeElement.querySelectorAll('.drow.del morse-pin-actions')).toHaveLength(1);

    // Side by side: the new side has rows only for lines 1 and 3 — the pair falls
    // to the old side's last deleted row, never alongside the new side's.
    setDiffMode(fixture, 'Side-by-side diff');
    expect(fixture.nativeElement.querySelectorAll('.side.add morse-pin-actions')).toHaveLength(0);
    expect(fixture.nativeElement.querySelectorAll('.side.del morse-pin-actions')).toHaveLength(1);
  });
});
