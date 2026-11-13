import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSearchResult } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { ShellState } from '../../state/shell-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { SearchPanel } from './search-panel';

/** The host's answer, shaped the way the wire really delivers it. */
function answer(overrides: Partial<WorkspaceSearchResult> = {}): WorkspaceSearchResult {
  return {
    files: [
      {
        path: 'src/app.ts',
        count: 2,
        lines: [
          { line: 3, text: 'export const needle = 1;', columns: [14] },
          { line: 9, text: '// needle again', columns: [4] },
        ],
      },
      {
        path: 'README.md',
        count: 1,
        lines: [{ line: 1, text: '# Needle docs', columns: [3] }],
      },
    ],
    total: 3,
    truncated: false,
    engine: 'ripgrep',
    ...overrides,
  };
}

/** The preview seam's answer: a small TypeScript file the highlighter can chew. */
const FILE_PAYLOAD = {
  path: 'src/app.ts',
  // Lines sit where the answer's matches say they do: line 3 and line 9.
  content: 'x\ny\nexport const needle = 1;\na\nb\nc\nd\ne\n// needle again\n',
  size: 58,
  truncated: false,
  binary: false,
};

function setup(data: unknown = answer(), openPaths: string[] = []) {
  const morse = {
    // The dialog reads the marked file for its preview pane; anything that is
    // not a search goes down the `readFile` seam and answers with that file.
    requestHostCommand: vi.fn((command: string) =>
      command === 'searchWorkspace'
        ? Promise.resolve(data)
        : Promise.resolve({ ...FILE_PAYLOAD }),
    ),
    projects: signal([
      { path: '/repo/morse', name: 'morse', sessionCount: 1, lastUsedAt: 1 },
      { path: '/repo/noo', name: 'noo-pmps', sessionCount: 2, lastUsedAt: 2 },
    ]),
    state: signal({ workspace: { cwd: '/repo/morse', name: 'morse' } }),
  };
  const tabs = {
    openFile: vi.fn(),
    tabs: signal(
      openPaths.map((path) => ({ id: `file:${path}`, kind: 'file' as const, path })),
    ),
  };
  TestBed.configureTestingModule({
    imports: [SearchPanel],
    providers: [
      { provide: MorseService, useValue: morse },
      { provide: WorkspaceTabs, useValue: tabs },
    ],
  });
  const fixture = TestBed.createComponent(SearchPanel);
  const shell = TestBed.inject(ShellState);
  shell.openFindFiles(); // the dialog answers to the same switch it lives behind
  fixture.detectChanges();
  return { fixture, morse, tabs, shell };
}

/** Past the debounce, then the settled promise, then the redraw. */
async function settle(fixture: ComponentFixture<SearchPanel>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
}

function type(fixture: ComponentFixture<SearchPanel>, selector: string, value: string): void {
  const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function text(fixture: ComponentFixture<SearchPanel>): string {
  return fixture.nativeElement.textContent as string;
}

/** Only the search calls; the preview pane's `readFile` calls sit beside them. */
function searchCalls(morse: { requestHostCommand: { mock: { calls: unknown[][] } } }): number {
  return morse.requestHostCommand.mock.calls.filter((call) => call[0] === 'searchWorkspace').length;
}

/** The last `searchWorkspace` payload the dialog sent. */
function lastSearchArgs(
  morse: { requestHostCommand: { mock: { calls: unknown[][] } } },
): Record<string, unknown> {
  const call = [...morse.requestHostCommand.mock.calls]
    .reverse()
    .find((candidate) => candidate[0] === 'searchWorkspace')!;
  return call[1] as Record<string, unknown>;
}

afterEach(() => TestBed.resetTestingModule());

describe('SearchPanel', () => {
  it('asks nothing until there is a query, and says so plainly', () => {
    const { fixture, morse } = setup();
    expect(text(fixture)).toContain('Type search query to find in files');
    expect(morse.requestHostCommand).not.toHaveBeenCalled();
  });

  it('searches as you type and draws a flat list with the file named at the end', async () => {
    const { fixture, morse } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    expect(morse.requestHostCommand).toHaveBeenCalledWith(
      'searchWorkspace',
      { query: 'needle', caseSensitive: false, include: [], exclude: [] },
      30_000,
    );
    expect(text(fixture)).toContain('app.ts');
    expect(text(fixture)).toContain('README.md');
    // The titlebar carries the count.
    expect(text(fixture)).toContain('3 matches in 2 files');
    const hits = [...fixture.nativeElement.querySelectorAll('.match .hit')].map(
      (node) => (node as HTMLElement).textContent,
    );
    expect(hits).toEqual(['needle', 'needle', 'Needle']);
    // The preview read the first row's file for its pane.
    expect(morse.requestHostCommand).toHaveBeenCalledWith('readFile', { path: 'src/app.ts' });
  });

  it('paints the preview with syntax HTML and marks the matches over it', async () => {
    const { fixture } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    // The file is TypeScript, so its text arrives highlighted, not bare: some
    // token span sits over the plain characters.
    expect(fixture.nativeElement.querySelectorAll('.preview-line .code span').length)
      .toBeGreaterThan(0);
    // The query's ranges sit over the highlight as amber marks.
    const marks = fixture.nativeElement.querySelectorAll('.preview-line .code .hit');
    expect(marks.length).toBeGreaterThan(0);
    expect((marks[0] as HTMLElement).textContent).toContain('needle');
    // The selection's line carries the band.
    expect(fixture.nativeElement.querySelectorAll('.preview-line.current')).toHaveLength(1);
  });

  it('opens the file at the match line when a row is clicked, and closes the dialog', async () => {
    const { fixture, tabs, shell } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    const rows = fixture.nativeElement.querySelectorAll('.match');
    (rows[1] as HTMLElement).click();
    expect(tabs.openFile).toHaveBeenCalledWith('src/app.ts', 9);
    // Without the pin, jumping to the source leaves the find window.
    expect(shell.findFilesOpen()).toBe(false);
  });

  it('keeps the dialog up when "Open results in new tab" is on', async () => {
    const { fixture, tabs, shell } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    (fixture.nativeElement.querySelector('.foot-check input') as HTMLInputElement).click();
    fixture.detectChanges();
    const results = fixture.nativeElement.querySelector('.results') as HTMLElement;
    results.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(tabs.openFile).toHaveBeenCalledWith('src/app.ts', 3);
    expect(shell.findFilesOpen()).toBe(true);
  });

  it('keeps the dialog up on Ctrl+Enter even without the pin', async () => {
    const { fixture, tabs, shell } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    const results = fixture.nativeElement.querySelector('.results') as HTMLElement;
    results.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    expect(tabs.openFile).toHaveBeenCalledWith('src/app.ts', 3);
    expect(shell.findFilesOpen()).toBe(true);
  });

  it('sends the file mask as the include glob', async () => {
    const { fixture, morse } = setup();
    type(fixture, 'input.query', 'needle');
    type(fixture, 'input[aria-label="File mask"]', '*.ts');
    (fixture.nativeElement.querySelector('.mask-check') as HTMLInputElement).click();
    await settle(fixture);
    expect(lastSearchArgs(morse)).toMatchObject({ include: ['*.ts'] });
  });

  it('sends the exclude globs from the funnel box', async () => {
    const { fixture, morse } = setup();
    type(fixture, 'input.query', 'needle');
    (
      fixture.nativeElement.querySelector(
        '.iconbtn[aria-label="Files to exclude"]',
      ) as HTMLElement
    ).click();
    fixture.detectChanges();
    type(fixture, 'input[aria-label="Files to exclude"]', 'dist/**, *.lock');
    await settle(fixture);
    expect(lastSearchArgs(morse)).toMatchObject({ exclude: ['dist/**', '*.lock'] });
  });

  it('maps the Directory tab onto a dir/** include glob', async () => {
    const { fixture, morse } = setup();
    (fixture.nativeElement.querySelectorAll('.tab')[2] as HTMLElement).click();
    fixture.detectChanges();
    type(fixture, 'input.query', 'needle');
    type(fixture, 'input[aria-label="Directory relative to the project root"]', 'src/app');
    await settle(fixture);
    expect(lastSearchArgs(morse)).toMatchObject({ include: ['src/app/**'] });
  });

  it('searches the Module tab project by its cwd, and reads its preview there too', async () => {
    const { fixture, morse } = setup();
    (fixture.nativeElement.querySelectorAll('.tab')[1] as HTMLElement).click();
    fixture.detectChanges();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    expect(lastSearchArgs(morse)).toMatchObject({ cwd: '/repo/morse' });
    expect(morse.requestHostCommand).toHaveBeenCalledWith('readFile', {
      path: 'src/app.ts',
      cwd: '/repo/morse',
    });
  });

  it('narrows the Project Test Files scope with test globs', async () => {
    const { fixture, morse } = setup();
    (fixture.nativeElement.querySelectorAll('.tab')[3] as HTMLElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.combo-btn') as HTMLElement).click();
    fixture.detectChanges();
    const items = fixture.nativeElement.querySelectorAll('.menu-item');
    (items[2] as HTMLElement).click(); // Project Test Files
    fixture.detectChanges();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    const args = lastSearchArgs(morse);
    expect(String(args['include'])).toContain('*.spec.');
  });

  it('narrows the Open Files scope to the tab strip file tabs', async () => {
    const { fixture } = setup(answer(), ['README.md']);
    (fixture.nativeElement.querySelectorAll('.tab')[3] as HTMLElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.combo-btn') as HTMLElement).click();
    fixture.detectChanges();
    const items = fixture.nativeElement.querySelectorAll('.menu-item');
    (items[3] as HTMLElement).click(); // Open Files
    fixture.detectChanges();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    const names = text(fixture);
    expect(names).toContain('README.md');
    expect(names).not.toContain('app.ts');
  });

  it('re-runs immediately when the match-case toggle flips', async () => {
    const { fixture, morse } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    (
      fixture.nativeElement.querySelector('.fieldbtn[aria-label="Match case"]') as HTMLElement
    ).click();
    await settle(fixture);
    expect(lastSearchArgs(morse)).toMatchObject({ caseSensitive: true });
  });

  it('greys the words and regex toggles: the engine answers fixed strings', () => {
    const { fixture } = setup();
    const disabled = fixture.nativeElement.querySelectorAll('.fieldbtn:disabled');
    expect(disabled).toHaveLength(2);
  });

  it('reports a miss as a failed search, not as an empty result', async () => {
    // Not `undefined`: that would hit the default parameter, not the miss.
    const { fixture } = setup(null);
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    expect(text(fixture)).toContain('The search failed');
  });

  it('clears the answer when the query is emptied', async () => {
    const { fixture, morse } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    expect(searchCalls(morse)).toBe(1);
    type(fixture, 'input.query', '');
    await settle(fixture);
    expect(text(fixture)).toContain('Type search query to find in files');
    expect(searchCalls(morse)).toBe(1);
  });

  it('ignores an answer a newer query already replaced', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const fileAnswer = () => Promise.resolve({ ...FILE_PAYLOAD });
    const morse = {
      requestHostCommand: vi
        .fn()
        .mockImplementation((command: string) =>
          command === 'searchWorkspace' ? undefined : fileAnswer(),
        )
        .mockReturnValueOnce(first)
        .mockResolvedValue(answer({ total: 1 })),
      projects: signal([]),
      state: signal({ workspace: undefined }),
    };
    TestBed.configureTestingModule({
      imports: [SearchPanel],
      providers: [
        { provide: MorseService, useValue: morse },
        { provide: WorkspaceTabs, useValue: { openFile: vi.fn(), tabs: signal([]) } },
      ],
    });
    const fixture = TestBed.createComponent(SearchPanel);
    fixture.detectChanges();

    type(fixture, 'input.query', 'first');
    await new Promise((resolve) => setTimeout(resolve, 300));
    type(fixture, 'input.query', 'second');
    await settle(fixture); // the second search lands
    resolveFirst(answer({ total: 99 })); // the first answers late
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(searchCalls(morse)).toBe(2);
    // The late first answer never reached the screen: its total (99) would be
    // the titlebar's count; the second query's answer holds the dialog instead.
    expect(text(fixture)).not.toContain('99');
  });

  it('draws every row of a nine-match answer in the flat list', async () => {
    const many = answer({
      total: 9,
      files: [
        {
          path: 'src/long.ts',
          count: 9,
          lines: Array.from({ length: 9 }, (_, index) => ({
            line: index + 1,
            text: `const needle${index} = ${index};`,
            columns: [7],
          })),
        },
      ],
    });
    const { fixture } = setup(many);
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    expect(fixture.nativeElement.querySelectorAll('.match')).toHaveLength(9);
    // Every row names its file and its line at the end.
    expect(text(fixture)).toContain('long.ts');
  });

  it('walks the rows with the keyboard and opens the marked one', async () => {
    const { fixture, tabs } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    // The answer arrives with its first row marked, so one ArrowDown lands on
    // the second row.
    const results = fixture.nativeElement.querySelector('.results') as HTMLElement;
    results.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.match.marked')).toHaveLength(1);
    results.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(tabs.openFile).toHaveBeenCalledWith('src/app.ts', 9);
  });

  it('opens from the footer button with the dialog kept up', async () => {
    const { fixture, tabs, shell } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    (fixture.nativeElement.querySelector('.find-btn') as HTMLElement).click();
    expect(tabs.openFile).toHaveBeenCalledWith('src/app.ts', 3);
    expect(shell.findFilesOpen()).toBe(true);
  });
});
