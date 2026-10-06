import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../core/morse.service';
import { MORSE_TRANSPORT } from '../../core/transport.token';
import { PromptEditor } from './prompt-editor';

interface RenderOptions {
  saved?: unknown;
  templates?: unknown;
}

/**
 * A reload must not eat a half-written template, and the editor must render what
 * the host reported. `ViewState` is the host store (browser `localStorage`, the
 * VS Code webview state its panel serializer restores).
 */
function render(options: RenderOptions = {}): {
  element: HTMLElement;
  fixture: ComponentFixture<PromptEditor>;
} {
  const transport = new MemoryHostTransport();
  const fake = {
    capabilities: signal({
      hostKind: 'server',
      scope: 'global',
      editorContext: false,
      nativeDialogs: false,
      insertIntoEditor: false,
      revealFile: false,
      promptEditor: true,
    }),
    workspace: signal({ cwd: '/repo', name: 'repo' }),
    state: signal({ sessionId: 's1' }),
    hostCommand: vi.fn(),
    refreshCommands: vi.fn(),
    requestHostCommand: vi.fn(() =>
      Promise.resolve(
        options.templates ?? {
          templates: [],
          globalDir: '/home/u/.pi/agent/prompts',
          projectDir: '/repo/.pi/prompts',
          trusted: true,
        },
      ),
    ),
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
  return { element: fixture.nativeElement as HTMLElement, fixture };
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
      expect(element.querySelectorAll('.arg-grid input')).toHaveLength(0);
      vi.advanceTimersByTime(250);
      fixture.detectChanges();
      expect(element.querySelectorAll('.arg-grid input')).toHaveLength(2);

      // Deleting `$2` from the body deletes its input too.
      await type('Use $1 only');
      vi.advanceTimersByTime(250);
      fixture.detectChanges();
      expect(element.querySelectorAll('.arg-grid input')).toHaveLength(1);
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
      expect(element.querySelectorAll('.arg-grid input')).toHaveLength(0);
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
