import { computed, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../core/morse.service';
import { ShellState } from '../../core/shell-state';
import { WorkspaceTabs } from '../../core/workspace-tabs';
import { FileExplorer } from './file-explorer';

function setup(files: string[], status?: unknown) {
  const state = signal({ workspace: { cwd: '/work/morse', name: 'morse' } });
  const morse = {
    state,
    // The real service derives `workspace` from `state`; mirror that so a project
    // switch reaches both the Explorer and the shared listing.
    workspace: computed(() => state().workspace),
    // The browser host is the only one with an Explorer, and it also answers git:
    // `gitStatus` is gated on `gitPanel`, exactly as the real capabilities are.
    capabilities: signal({ hostKind: 'server', filePicker: true, filePreview: true, gitPanel: true }),
    requestHostCommand: vi.fn((command: string) =>
      Promise.resolve(command === 'gitStatus' ? status : { files }),
    ),
  };
  const tabs = { openFile: vi.fn(), activeTab: signal<{ kind: 'file'; id: string; path: string; title: string } | undefined>(undefined) };
  TestBed.configureTestingModule({
    imports: [FileExplorer],
    providers: [
      { provide: MorseService, useValue: morse },
      { provide: WorkspaceTabs, useValue: tabs },
    ],
  });
  const fixture = TestBed.createComponent(FileExplorer);
  fixture.detectChanges();
  return { fixture, morse, tabs, state };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function rows(fixture: ComponentFixture<FileExplorer>): string[] {
  return [...fixture.nativeElement.querySelectorAll('.row .name')].map(
    (node: Element) => node.textContent ?? '',
  );
}

function badges(fixture: ComponentFixture<FileExplorer>): string[] {
  return [...fixture.nativeElement.querySelectorAll('.row .badge')].map((node: Element) =>
    (node.textContent ?? '').trim(),
  );
}

describe('FileExplorer', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('lists the project and opens a file in a tab', async () => {
    const { fixture, tabs } = setup(['src/main.ts', 'README.md']);
    await flush();
    fixture.detectChanges();

    expect(rows(fixture)).toEqual(['src', 'README.md']);
    fixture.nativeElement.querySelectorAll('.row')[1].click();
    expect(tabs.openFile).toHaveBeenCalledWith('README.md');
  });

  it('expands a directory to reveal its files', async () => {
    const { fixture } = setup(['src/app/main.ts']);
    await flush();
    fixture.detectChanges();

    expect(rows(fixture)).toEqual(['src']);
    fixture.nativeElement.querySelector('.row').click();
    fixture.detectChanges();

    expect(rows(fixture)).toEqual(['src', 'app']);
    fixture.nativeElement.querySelectorAll('.row')[1].click();
    fixture.detectChanges();
    expect(rows(fixture)).toEqual(['src', 'app', 'main.ts']);
  });

  it('does not walk the project again when only the transcript changed', async () => {
    const { fixture, morse, state } = setup(['a.ts']);
    await flush();
    const listCalls = (): number =>
      morse.requestHostCommand.mock.calls.filter(([command]) => command === 'listFiles').length;
    expect(listCalls()).toBe(1);

    // `session/state` re-emits on every streamed token; that is not a new project.
    state.set({ workspace: { cwd: '/work/morse', name: 'morse' } });
    fixture.detectChanges();
    await flush();
    expect(listCalls()).toBe(1);

    state.set({ workspace: { cwd: '/work/other', name: 'other' } });
    fixture.detectChanges();
    await flush();
    expect(listCalls()).toBe(2);
  });

  it('badges the files git reports as changed, and dots their folder', async () => {
    const { fixture } = setup(['README.md', 'package.json', 'src/main.ts'], {
      isRepo: true,
      files: [
        { path: 'README.md', status: ' M' },
        { path: 'package.json', status: '??' },
        { path: 'src/main.ts', status: 'A ' },
      ],
    });
    await flush();
    fixture.detectChanges();

    expect(rows(fixture)).toEqual(['src', 'package.json', 'README.md']);
    expect(badges(fixture)).toEqual(['U', 'M']);
    expect(fixture.nativeElement.querySelector('.row.dir .dot')).not.toBeNull();
  });

  it('reveals the file in front, and follows the active chip', async () => {
    const { fixture, tabs } = setup([
      'src/app/main.ts',
      'src/app/other.ts',
      'README.md',
    ]);
    await flush();
    fixture.detectChanges();

    // Nothing is in front yet, so the tree stays folded.
    expect(rows(fixture)).toEqual(['src', 'README.md']);

    tabs.activeTab.set({
      kind: 'file',
      id: 'file:src/app/main.ts',
      path: 'src/app/main.ts',
      title: 'main.ts',
    });
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    // Every folder on the way to the file is open, and its row is marked.
    expect(rows(fixture)).toEqual(['src', 'app', 'main.ts', 'other.ts', 'README.md']);
    expect(fixture.nativeElement.querySelector('.row.active')?.textContent).toContain('main.ts');
    expect(
      fixture.nativeElement.querySelector('.row.active')?.getAttribute('aria-current'),
    ).toBe('true');

    // Switching chips moves the Explorer's focus too, not only the preview.
    tabs.activeTab.set({
      kind: 'file',
      id: 'file:README.md',
      path: 'README.md',
      title: 'README.md',
    });
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.row.active')?.textContent).toContain('README.md');
  });

  it('does not reveal a file the active project does not list', async () => {
    const { fixture, tabs } = setup(['src/main.ts']);
    await flush();
    fixture.detectChanges();

    // A chip from another project: expanding this tree for it would be wrong.
    tabs.activeTab.set({
      kind: 'file',
      id: 'file:../other/secret.ts',
      path: '../other/secret.ts',
      title: 'secret.ts',
    });
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(rows(fixture)).toEqual(['src']);
    expect(fixture.nativeElement.querySelector('.row.active')).toBeNull();
  });

  it('offers a resize handle only while the pane is open', async () => {
    const { fixture } = setup(['a.ts']);
    await flush();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.resize')).not.toBeNull();

    fixture.nativeElement.querySelector('.pane-toggle').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.resize')).toBeNull();
  });

  it('drops the dragged height while collapsed, so nothing is left behind', async () => {
    const { fixture } = setup(['a.ts']);
    await flush();
    TestBed.inject(ShellState).setExplorerHeight(300);
    fixture.detectChanges();
    expect(fixture.nativeElement.style.height).toBe('300px');

    fixture.nativeElement.querySelector('.pane-toggle').click();
    fixture.detectChanges();

    // Folded, the pane is only its header: no tall empty box.
    expect(fixture.nativeElement.style.height).toBe('');
    expect((fixture.nativeElement as HTMLElement).classList.contains('sized')).toBe(false);
  });
});
