import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSearchResult } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
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

function setup(data: unknown = answer()) {
  const morse = {
    requestHostCommand: vi.fn(() => Promise.resolve(data)),
  };
  const tabs = {
    openFile: vi.fn(),
    activeTab: signal<unknown>(undefined),
  };
  TestBed.configureTestingModule({
    imports: [SearchPanel],
    providers: [
      { provide: MorseService, useValue: morse },
      { provide: WorkspaceTabs, useValue: tabs },
    ],
  });
  const fixture = TestBed.createComponent(SearchPanel);
  fixture.detectChanges();
  return { fixture, morse, tabs };
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

afterEach(() => TestBed.resetTestingModule());

describe('SearchPanel', () => {
  it('asks nothing until there is a query, and says so', () => {
    const { fixture, morse } = setup();
    expect(text(fixture)).toContain('Type to search every file in the project.');
    expect(morse.requestHostCommand).not.toHaveBeenCalled();
  });

  it('searches as you type and draws the answer grouped by file', async () => {
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
    // The pane's badge is the total; both files' counts sit on their headers.
    expect(text(fixture)).toContain('3');
    const hits = [...fixture.nativeElement.querySelectorAll('.hit')].map(
      (node) => (node as HTMLElement).textContent,
    );
    expect(hits).toEqual(['needle', 'needle', 'Needle']);
  });

  it('opens the preview at the match line when a row is clicked', async () => {
    const { fixture, tabs } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    const rows = fixture.nativeElement.querySelectorAll('.match');
    (rows[1] as HTMLElement).click();
    expect(tabs.openFile).toHaveBeenCalledWith('src/app.ts', 9);
  });

  it('splits the glob boxes on commas and sends them along', async () => {
    const { fixture, morse } = setup();
    type(fixture, 'input.query', 'needle');
    type(fixture, 'input[aria-label="Files to include"]', ' *.ts, src/** ');
    type(fixture, 'input[aria-label="Files to exclude"]', 'dist/**');
    await settle(fixture);
    expect(morse.requestHostCommand).toHaveBeenLastCalledWith(
      'searchWorkspace',
      expect.objectContaining({ include: ['*.ts', 'src/**'], exclude: ['dist/**'] }),
      30_000,
    );
  });

  it('re-runs immediately when the match-case toggle flips', async () => {
    const { fixture, morse } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    (fixture.nativeElement.querySelector('.toggle') as HTMLElement).click();
    await settle(fixture);
    expect(morse.requestHostCommand).toHaveBeenLastCalledWith(
      'searchWorkspace',
      expect.objectContaining({ caseSensitive: true }),
      30_000,
    );
  });

  it('folds and unfolds a file group from its header', async () => {
    const { fixture } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    const heads = fixture.nativeElement.querySelectorAll('.file-head');
    (heads[0] as HTMLElement).click();
    fixture.detectChanges();
    expect(text(fixture)).not.toContain('export const needle');
    (heads[0] as HTMLElement).click();
    fixture.detectChanges();
    expect(text(fixture)).toContain('export const needle');
  });

  it('asks for ripgrep when the walk answered', async () => {
    const { fixture } = setup(answer({ engine: 'node' }));
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    expect(text(fixture)).toContain('ripgrep is not installed');
  });

  it('says the search was cut short when a cap ended it', async () => {
    const { fixture } = setup(answer({ total: 1_000, truncated: true }));
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    expect(text(fixture)).toContain('Showing the first 1000+ matches');
  });

  it('reports a miss as a failed search, not as an empty result', async () => {
    // Not `undefined`: that would hit the default parameter, not the miss.
    const { fixture } = setup(null);
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    expect(text(fixture)).toContain("The search failed");
  });

  it('clears the answer when the query is emptied', async () => {
    const { fixture, morse } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    expect(morse.requestHostCommand).toHaveBeenCalledTimes(1);
    type(fixture, 'input.query', '');
    await settle(fixture);
    expect(text(fixture)).toContain('Type to search every file in the project.');
    expect(morse.requestHostCommand).toHaveBeenCalledTimes(1);
  });

  it('ignores an answer a newer query already replaced', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const morse = {
      requestHostCommand: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockResolvedValue(answer({ total: 1 })),
    };
    TestBed.configureTestingModule({
      imports: [SearchPanel],
      providers: [
        { provide: MorseService, useValue: morse },
        { provide: WorkspaceTabs, useValue: { openFile: vi.fn(), activeTab: signal(undefined) } },
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

    const badges = [...fixture.nativeElement.querySelectorAll('.count')];
    expect(morse.requestHostCommand).toHaveBeenCalledTimes(2);
    // The late first answer never reached the screen: its total (99) would be
    // the pane's badge; the second query's answer holds the pane instead.
    expect(badges).toHaveLength(2);
    expect(text(fixture)).not.toContain('99');
  });

  it('summarises the answer: how much matched, in how many files', async () => {
    const { fixture } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    expect(text(fixture)).toContain('3 matches');
    expect(text(fixture)).toContain('2 files');
    expect(text(fixture)).toContain('ripgrep');
  });

  it('keeps a long file to its first rows and says how many it kept back', async () => {
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
    expect(fixture.nativeElement.querySelectorAll('.match')).toHaveLength(3);
    expect(text(fixture)).toContain('6 more lines');
    // The reader asks for the rest by name.
    (fixture.nativeElement.querySelector('.more') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.match')).toHaveLength(9);
  });

  it('walks the rows with the keyboard and opens the marked one', async () => {
    const { fixture, tabs } = setup();
    type(fixture, 'input.query', 'needle');
    await settle(fixture);
    const results = fixture.nativeElement.querySelector('.results') as HTMLElement;
    results.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    results.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.match.marked')).toHaveLength(1);
    results.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(tabs.openFile).toHaveBeenCalledWith('src/app.ts', 9);
  });

  it('shows every row of every file when the expand button is on', async () => {
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
    expect(fixture.nativeElement.querySelectorAll('.match')).toHaveLength(3);
    const expand = [...fixture.nativeElement.querySelectorAll('.pane-action')].find(
      (node) => (node as HTMLElement).getAttribute('aria-label') === 'Show every row',
    ) as HTMLElement;
    expand.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.match')).toHaveLength(9);
  });
});
