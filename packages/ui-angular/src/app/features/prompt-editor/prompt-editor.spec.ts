import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { PromptEditor } from './prompt-editor';

interface RenderOptions {
  saved?: unknown;
  templates?: unknown;
  engine?: string;
  /** What `configFix` answers; the default is a successful rewrite. */
  fixResult?: unknown;
  /** What the first `promptTemplates` read answers after a fix (the cleared list). */
  templatesAfterFix?: unknown;
  /** Whether the host advertises `configFix`; the default is yes. */
  configFix?: boolean;
}

/**
 * A reload must not eat a half-written template, and the editor must render what
 * the host reported. `ViewState` is the host store (browser `localStorage`, the
 * VS Code webview state its panel serializer restores).
 */
function render(options: RenderOptions = {}): {
  element: HTMLElement;
  fixture: ComponentFixture<PromptEditor>;
  engine?: string;
  requestHostCommand: ReturnType<typeof vi.fn>;
} {
  const transport = new MemoryHostTransport();
  let reads = 0;
  const requestHostCommand = vi.fn((command: string) => {
    if (command === 'configFix') {
      return Promise.resolve(options.fixResult ?? { ok: true, issues: [] });
    }
    reads += 1;
    // The store re-reads after a successful fix: later reads may be the file
    // the host just rewrote, so tests can hand back a cleared list.
    if (reads > 1 && options.templatesAfterFix !== undefined) {
      return Promise.resolve(options.templatesAfterFix);
    }
    return Promise.resolve(
      options.templates ?? {
        templates: [],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '/repo/.pi/prompts',
        trusted: true,
      },
    );
  });
  const fake = {
    capabilities: signal({
      hostKind: 'server',
      scope: 'global',
      editorContext: false,
      nativeDialogs: false,
      insertIntoEditor: false,
      revealFile: false,
      promptEditor: true,
      configFix: options.configFix ?? true,
    }),
    workspace: signal({ cwd: '/repo', name: 'repo' }),
    state: signal({ sessionId: 's1' }),
    engine: signal(options.engine ?? 'pi'),
    hostCommand: vi.fn(),
    refreshCommands: vi.fn(),
    requestHostCommand,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [PromptEditor],
    providers: [
      { provide: MORSE_TRANSPORT, useValue: transport },
      { provide: MorseService, useValue: fake },
    ],
  });
  if (options.saved !== undefined) {
    transport.writeState({ 'morse.view.prompt-editor': options.saved });
  }
  const fixture = TestBed.createComponent(PromptEditor);
  fixture.detectChanges();
  return { element: fixture.nativeElement as HTMLElement, fixture, requestHostCommand };
}

afterEach(() => TestBed.resetTestingModule());

describe('PromptEditor', () => {
  it('restores a saved draft after a reload', () => {
    const { element } = render({
      saved: {
        name: 'review',
        description: 'Review',
        hint: '[focus]',
        body: 'Review the staged changes.',
        scope: 'global',
        mode: 'raw',
        fieldValues: {},
        rawArgs: '',
      },
    });

    const value = (selector: string) =>
      (element.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null)?.value;
    expect(value('#prompt-name')).toBe('review');
    expect(value('#prompt-description')).toBe('Review');
    expect(value('#prompt-body')).toBe('Review the staged changes.');
  });

  it('lists the host templates and opens the first', async () => {
    const { element, fixture } = render({
      templates: {
        templates: [
          {
            name: 'fix',
            scope: 'global',
            path: '/home/u/.pi/agent/prompts/fix.md',
            description: 'Fix a bug',
            body: 'Fix $1.',
            raw: '---\ndescription: Fix a bug\n---\nFix $1.',
          },
        ],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '/repo/.pi/prompts',
        trusted: true,
      },
    });

    await fixture.whenStable();
    // The list load and the auto-select run in promise callbacks the fixture
    // does not track, so let the microtask queue drain before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(element.textContent).toContain('/fix');
    const name = element.querySelector('#prompt-name') as HTMLInputElement | null;
    expect(name?.value).toBe('fix');
    const preview = element.querySelector('pre.preview') as HTMLElement | null;
    // The field tester leaves `$1` blank, so the preview still shows the literal.
    expect(preview?.textContent).toContain('Fix');
  });

  it('adds and drops field inputs as the body changes, after a debounce', async () => {
    vi.useFakeTimers();
    try {
      const { element, fixture } = render();
      await Promise.resolve();
      const body = element.querySelector('#prompt-body') as HTMLTextAreaElement;

      const type = async (value: string) => {
        body.value = value;
        body.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        await Promise.resolve();
      };

      await type('Use $1 and $2');
      // The tester is debounced: nothing changes while the reader is mid-type.
      expect(element.querySelectorAll('.arg-grid textarea')).toHaveLength(0);
      vi.advanceTimersByTime(250);
      fixture.detectChanges();
      expect(element.querySelectorAll('.arg-grid textarea')).toHaveLength(2);

      // Deleting `$2` from the body deletes its input too.
      await type('Use $1 only');
      vi.advanceTimersByTime(250);
      fixture.detectChanges();
      expect(element.querySelectorAll('.arg-grid textarea')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the argument tester only when the body can be previewed', async () => {
    vi.useFakeTimers();
    try {
      const { element, fixture } = render();
      await Promise.resolve();
      expect(element.querySelector('.test')).toBeNull();

      const body = element.querySelector('#prompt-body') as HTMLTextAreaElement;
      body.value = 'Just prose, no placeholders';
      body.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await Promise.resolve();
      vi.advanceTimersByTime(250);
      fixture.detectChanges();

      // A previewable body brings the tester back, but there is nothing to fill.
      expect(element.querySelector('.test')).not.toBeNull();
      expect(element.querySelector('pre.preview')).not.toBeNull();
      expect(element.querySelectorAll('.arg-grid textarea')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads the list when capabilities arrive after the panel mounts', async () => {
    // The VS Code panel boots its route before `host/ready`, so capabilities are
    // unknown at first paint; a one-shot check used to skip the load for good.
    const transport = new MemoryHostTransport();
    const caps = signal<Record<string, unknown>>({ hostKind: 'server', promptEditor: false });
    const request = vi.fn(() =>
      Promise.resolve({
        templates: [
          { name: 'review', scope: 'global', path: '/p/review.md', body: 'Review.', raw: 'Review.' },
        ],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '',
        trusted: true,
      }),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [PromptEditor],
      providers: [
        { provide: MORSE_TRANSPORT, useValue: transport },
        {
          provide: MorseService,
          useValue: {
            capabilities: caps,
            workspace: signal({ cwd: '', name: '' }),
            state: signal({}),
            engine: signal('pi'),
            hostCommand: vi.fn(),
            refreshCommands: vi.fn(),
            requestHostCommand: request,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(PromptEditor);
    fixture.detectChanges();
    expect(request).not.toHaveBeenCalled();

    caps.set({ hostKind: 'server', promptEditor: true });
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(request).toHaveBeenCalledWith('promptTemplates', expect.anything(), expect.anything());
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('/review');
  });
});

/** A `prompts` complaint: one unreadable template file beside the list. */
const BROKEN_TEMPLATE_ISSUE = {
  file: '/repo/.pi/prompts/broken.md',
  fileId: 'prompts',
  scope: 'project',
  pointer: '/description',
  code: 'frontmatter',
  message: 'the frontmatter is not valid YAML',
  snippet: 'description: [unclosed',
  fixable: true,
};

describe('PromptEditor config issues', () => {
  it('shows a list-level issue and fixes it', async () => {
    const { element, fixture, requestHostCommand } = render({
      templates: {
        templates: [],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '/repo/.pi/prompts',
        trusted: true,
        issues: [BROKEN_TEMPLATE_ISSUE],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const text = element.textContent ?? '';
    expect(text).toContain('the frontmatter is not valid YAML');
    expect(text).toContain('/description');
    expect(element.querySelector('pre.snippet')?.textContent).toContain('[unclosed');

    const fix = [...element.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Fix',
    );
    expect(fix).toBeDefined();
    fix?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(requestHostCommand).toHaveBeenCalledWith(
      'configFix',
      {
        fileId: 'prompts',
        path: '/repo/.pi/prompts/broken.md',
        scope: 'project',
        cwd: '/repo',
        engine: 'pi',
      },
      expect.any(Number),
    );
  });

  it('hides Fix and asks for a hand edit when the host cannot fix', async () => {
    const { element, fixture } = render({
      configFix: false,
      templates: {
        templates: [],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '/repo/.pi/prompts',
        trusted: true,
        issues: [BROKEN_TEMPLATE_ISSUE],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const text = element.textContent ?? '';
    expect(text).toContain('the frontmatter is not valid YAML');
    expect(text).toMatch(/Fix is not available in this host — edit the file by hand/);
    expect(
      [...element.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === 'Fix',
      ),
    ).toBe(false);
  });

  it('shows the host’s refusal in the status row when a fix fails', async () => {
    const { element, fixture } = render({
      templates: {
        templates: [],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '/repo/.pi/prompts',
        trusted: true,
        issues: [BROKEN_TEMPLATE_ISSUE],
      },
      fixResult: { ok: false, message: 'The host refused to rewrite the file.' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const fix = [...element.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Fix',
    );
    fix?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(element.querySelector('.status-row.error')?.textContent).toContain(
      'The host refused to rewrite the file.',
    );
    // The failure is announced, not just painted.
    expect(element.querySelector('[role="status"]')?.textContent).toContain(
      'The host refused to rewrite the file.',
    );
  });

  it('disables every Fix and shows “Fixing…” while a rewrite runs', async () => {
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const { element, fixture } = render({
      templates: {
        templates: [],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '/repo/.pi/prompts',
        trusted: true,
        issues: [
          BROKEN_TEMPLATE_ISSUE,
          { ...BROKEN_TEMPLATE_ISSUE, file: '/repo/.pi/prompts/other.md' },
        ],
      },
      fixResult: pending,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    (element.querySelector('.fix') as HTMLButtonElement).click();
    fixture.detectChanges();

    const buttons = [...element.querySelectorAll('.fix')] as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons[0]?.textContent).toContain('Fixing…');
    expect(buttons[1]?.textContent?.trim()).toBe('Fix');
    expect(buttons[0]?.getAttribute('aria-label')).toBe(
      'Fix /repo/.pi/prompts/broken.md',
    );

    release?.({ ok: true, issues: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  });

  it('clears the issue and names the rewritten file after a successful fix', async () => {
    const { element, fixture } = render({
      templates: {
        templates: [],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '/repo/.pi/prompts',
        trusted: true,
        issues: [BROKEN_TEMPLATE_ISSUE],
      },
      fixResult: { ok: true, path: '/repo/.pi/prompts/rewritten.md', issues: [] },
      templatesAfterFix: {
        templates: [],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '/repo/.pi/prompts',
        trusted: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    (element.querySelector('.fix') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(element.textContent ?? '').not.toContain('the frontmatter is not valid YAML');
    expect(element.querySelector('.fix')).toBeNull();
    expect(element.querySelector('.status-row.ok')?.textContent).toContain(
      'Rewrote /repo/.pi/prompts/rewritten.md.',
    );
  });

  it('drops the path line when the message already names the file', async () => {
    const { element, fixture } = render({
      templates: {
        templates: [],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '/repo/.pi/prompts',
        trusted: true,
        issues: [
          {
            ...BROKEN_TEMPLATE_ISSUE,
            message: '/repo/.pi/prompts/broken.md: the frontmatter is not valid YAML',
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(element.textContent ?? '').toContain('the frontmatter is not valid YAML');
    expect(element.querySelector('.issue-file')).toBeNull();
    // The path appears once, inside the message, not again as its own line.
    expect((element.textContent ?? '').split('/repo/.pi/prompts/broken.md')).toHaveLength(2);
  });

  it('drops the path line for an unfixable issue whose message already names the file', async () => {
    const { element, fixture } = render({
      templates: {
        templates: [],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '/repo/.pi/prompts',
        trusted: true,
        issues: [
          {
            ...BROKEN_TEMPLATE_ISSUE,
            message: '/repo/.pi/prompts/broken.md: the frontmatter is not valid YAML',
            fixable: false,
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(element.querySelector('.issue-file')).toBeNull();
    expect((element.textContent ?? '').split('/repo/.pi/prompts/broken.md')).toHaveLength(2);
    expect(element.textContent ?? '').toMatch(/hand edit/i);
  });

  it('shows an unfixable issue without a Fix button, and says it needs a hand edit', async () => {
    const { element, fixture } = render({
      templates: {
        templates: [],
        globalDir: '/home/u/.pi/agent/prompts',
        projectDir: '/repo/.pi/prompts',
        trusted: true,
        issues: [{ ...BROKEN_TEMPLATE_ISSUE, fixable: false }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(element.textContent ?? '').toContain('the frontmatter is not valid YAML');
    // The message does not name the file, so the row supplies the path.
    expect(element.querySelector('.issue-file')?.textContent).toContain(
      '/repo/.pi/prompts/broken.md',
    );
    expect(
      [...element.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === 'Fix',
      ),
    ).toBe(false);
    expect(element.textContent ?? '').toMatch(/hand edit/i);
  });
});

describe('PromptEditor (OpenCode)', () => {
  it('renders OpenCode rows honestly: source labels, config bodies, no pi-only fields', async () => {
    const { element, fixture } = render({
      engine: 'opencode',
      templates: {
        templates: [
          {
            name: 'dual',
            scope: 'global',
            source: 'config',
            description: 'From the config',
            entry: { template: 'Run $ARGUMENTS with coverage', description: 'From the config' },
          },
          {
            name: 'filed',
            scope: 'project',
            source: 'file',
            path: '/repo/.opencode/commands/filed.md',
            description: 'From a file',
            body: 'Fix $1 now',
            raw: '---\ndescription: From a file\n---\nFix $1 now',
          },
        ],
        globalDir: '/home/u/.config/opencode/commands',
        projectDir: '/repo/.opencode/commands',
        trusted: true,
      },
    });
    await fixture.whenStable();
    fixture.detectChanges();
    const text = element.textContent ?? '';
    expect(text).toContain('config');
    expect(text).not.toContain('undefined');
    // The argument-hint field is pi-only.
    expect(element.querySelector('#prompt-hint')).toBeNull();

    // Selecting the config row opens its template body, and the hint stays empty.
    const rows = [...element.querySelectorAll('li button')] as HTMLElement[];
    rows.find((r) => r.textContent?.includes('dual'))!.click();
    fixture.detectChanges();
    const value = (selector: string) =>
      (element.querySelector(selector) as HTMLTextAreaElement | null)?.value;
    expect(value('#prompt-body')).toBe('Run $ARGUMENTS with coverage');
    expect(value('#prompt-hint')).toBeUndefined();
  });
});
