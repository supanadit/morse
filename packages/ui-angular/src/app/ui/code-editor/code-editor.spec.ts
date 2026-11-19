import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiffView } from '../../state/display-prefs';
import { CodeEditor } from './code-editor';

/**
 * The component's own wiring: which surface a `mode` builds, and that switching modes
 * replaces the document instead of trying to patch it. The drawing itself (gutters,
 * tints, hunk captions) is covered by `diff-extensions.spec.ts`; the arithmetic by
 * `diff-document.spec.ts`.
 */
const DIFF = '@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n';

/** The numbers a numbered gutter actually shows (its widest spacer is not one). */
function numbers(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].map(
    (element) => element.textContent?.trim() ?? '',
  );
}

async function mount(
  inputs: {
    mode?: DiffView;
    diff?: string;
    text?: string;
    pins?: readonly { id: string; startLine: number; endLine?: number; note?: string }[];
  } = {},
): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(CodeEditor);
  fixture.componentRef.setInput('text', inputs.text ?? 'const a = 1;\n');
  fixture.componentRef.setInput('path', 'src/main.ts');
  fixture.componentRef.setInput('mode', inputs.mode ?? 'file');
  fixture.componentRef.setInput('diff', inputs.diff);
  fixture.componentRef.setInput('pins', inputs.pins ?? []);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('CodeEditor', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('draws a file in one pane, with its own line numbers', async () => {
    const host = await mount({ text: 'const a = 1;\nconst b = 2;\n' });

    expect(host.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(numbers(host)).toContain('1');
    expect(numbers(host)).toContain('2');
    // A file's content is not a diff: nothing is tinted as a change.
    expect(host.querySelector('.morse-diff-add')).toBeNull();
  });

  it('draws a unified diff in the same pane, with both files’ numbers', async () => {
    const host = await mount({ mode: 'unified', diff: DIFF });

    expect(host.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(host.querySelector('.cm-lineNumbers')).toBeNull();
    expect(host.querySelector('.morse-diff-gutter-old')?.textContent).toBe('12');
    expect(host.querySelector('.morse-diff-gutter-new')?.textContent).toBe('123');
    expect(host.querySelector('.morse-diff-hunk')?.textContent).toBe('@@ -1,2 +1,3 @@');
  });

  it('draws a side-by-side diff as two panes of one document', async () => {
    const host = await mount({ mode: 'split', diff: DIFF });

    const panes = host.querySelectorAll('.morse-editor-host');
    expect(panes).toHaveLength(2);
    // Each pane carries one file's numbers, and only one.
    expect(panes[0]?.querySelector('.morse-diff-gutter-old')?.textContent).toBe('12');
    expect(panes[1]?.querySelector('.morse-diff-gutter-new')?.textContent).toBe('123');
    expect(panes[0]?.querySelector('.morse-diff-gutter-new')).toBeNull();
    expect(panes[1]?.querySelector('.morse-diff-gutter-old')).toBeNull();
  });

  it('goes back to the file when the mode does', async () => {
    const fixture = TestBed.createComponent(CodeEditor);
    fixture.componentRef.setInput('text', 'const a = 1;\n');
    fixture.componentRef.setInput('path', 'src/main.ts');
    fixture.componentRef.setInput('mode', 'split');
    fixture.componentRef.setInput('diff', DIFF);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.cm-editor')).toHaveLength(2);

    fixture.componentRef.setInput('mode', 'file');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The split's second pane is gone with the mode, and the file's own numbers return.
    expect(host.querySelectorAll('.morse-editor-host')).toHaveLength(1);
    expect(host.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(numbers(host)).toContain('1');
  });

  it('floats a pinned diff block’s Notes/Cancel pair over the code', async () => {
    const host = await mount({
      mode: 'unified',
      diff: DIFF,
      pins: [{ id: 'p1', startLine: 2, endLine: 3, note: 'why' }],
    });

    // The same pair the file view uses, on the row the band ends on.
    const actions = host.querySelectorAll('morse-pin-actions');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.querySelector('button.note')?.textContent?.trim()).toBe('why');
    expect(actions[0]?.querySelector('button.cancel')?.textContent).toContain('Cancel');
  });

  it('opens on a diff with no hunks without breaking', async () => {
    const host = await mount({ mode: 'unified', diff: '' });

    expect(host.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(host.querySelector('.morse-diff-hunk')).toBeNull();
  });
});
