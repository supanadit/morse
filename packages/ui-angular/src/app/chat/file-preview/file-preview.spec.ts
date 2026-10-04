import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTabs, type FileTab } from '../../core/workspace-tabs';
import { FilePreview } from './file-preview';

function render(tab: Partial<FileTab>): ComponentFixture<FilePreview> {
  TestBed.configureTestingModule({
    imports: [FilePreview],
    providers: [{ provide: WorkspaceTabs, useValue: { reload: vi.fn() } }],
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
  return fixture;
}

describe('FilePreview', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('highlights the source and numbers the lines', () => {
    const fixture = render({ content: 'const x = 1;\nconst y = 2;\n', size: 26 });

    const source = fixture.nativeElement.querySelector('.source');
    expect(source?.textContent).toContain('const x = 1;');
    // The registered language actually highlighted it, rather than falling back.
    expect(source?.querySelector('.hljs-keyword')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.gutter')?.textContent?.trim()).toBe('1\n2');
  });

  it('says a truncated file was cut short', () => {
    const fixture = render({ content: 'a\n', truncated: true, size: 2_097_152 });

    expect(fixture.nativeElement.querySelector('.hint')?.textContent).toContain('first 512 KB');
    expect(fixture.nativeElement.querySelector('.stat')?.textContent).toContain('2.0 MB');
  });

  it('shows no code for a binary file', () => {
    const fixture = render({ content: '', binary: true, size: 2_048 });

    expect(fixture.nativeElement.querySelector('.code')).toBeNull();
    expect(fixture.nativeElement.querySelector('.hint')?.textContent).toContain('Binary file');
  });

  it('reports a read failure instead of an empty editor', () => {
    const fixture = render({ error: 'Could not read this file.' });

    expect(fixture.nativeElement.querySelector('.hint.error')?.textContent).toContain(
      'Could not read this file.',
    );
  });

  it('shows a loading line while the host reads', () => {
    const fixture = render({ loading: true });

    expect(fixture.nativeElement.querySelector('.hint')?.textContent).toContain('Reading main.ts');
  });
});
