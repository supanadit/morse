import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { SessionViewState, TranscriptItem } from '@morse/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { ChatTranscript } from './transcript';

function viewState(streaming = false): SessionViewState {
  return {
    workspace: { cwd: '/work/morse', name: 'morse' },
    thinkingLevel: 'off',
    availableModels: [],
    availableThinkingLevels: [],
    availableCommands: [],
    streaming,
    busy: false,
    agentReady: true,
    agentStarting: false,
  };
}

/**
 * The transcript must never claim "Start of conversation" while older history
 * is still reachable (a 2000-message session opens on its newest page, not on
 * its first message).
 */
describe('ChatTranscript history paging', () => {
  const hasOlder = signal(false);
  const loading = signal(false);
  const items = signal<TranscriptItem[]>([]);

  beforeEach(async () => {
    hasOlder.set(false);
    loading.set(false);
    items.set([
      { kind: 'user', id: 'u1', at: 1, text: 'hello' },
      { kind: 'assistant', id: 'a1', at: 2, text: 'hi', thinking: '', streaming: false },
    ]);
    await TestBed.configureTestingModule({
      imports: [ChatTranscript],
      providers: [
        {
          provide: MorseService,
          useValue: {
            state: signal(viewState()),
            items,
            hasOlderHistory: hasOlder,
            loadingOlderHistory: loading,
            capabilities: signal(null),
            requestHostCommand: () => Promise.resolve(undefined),
            loadOlderHistory: () => undefined,
          },
        },
      ],
    }).compileComponents();
  });

  it('offers older history instead of claiming the start', () => {
    hasOlder.set(true);
    const fixture = TestBed.createComponent(ChatTranscript);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.start')).toBeNull();
    expect(host.querySelector('.older-button')?.textContent).toContain('Load older messages');
  });

  it('shows the start divider only when nothing older remains', () => {
    hasOlder.set(false);
    const fixture = TestBed.createComponent(ChatTranscript);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.start')).toBeTruthy();
  });

  it('shows a loading label while the first page is in flight', () => {
    loading.set(true);
    const fixture = TestBed.createComponent(ChatTranscript);
    fixture.detectChanges();
    const label = (fixture.nativeElement as HTMLElement).querySelector('.older-label');
    expect(label?.textContent).toContain('Loading older messages');
  });
});

/**
 * A resumed session opens on its newest history page, so the panel is empty
 * while the host fetches it. The hero must wait for that: it says "type away",
 * and it must not claim the screen over a conversation that is still arriving.
 */
describe('ChatTranscript empty state while history is loading', () => {
  const loading = signal(false);
  const items = signal<TranscriptItem[]>([]);

  beforeEach(async () => {
    loading.set(false);
    items.set([]);
    await TestBed.configureTestingModule({
      imports: [ChatTranscript],
      providers: [
        {
          provide: MorseService,
          useValue: {
            state: signal(viewState()),
            items,
            hasOlderHistory: signal(false),
            loadingOlderHistory: loading,
            capabilities: signal(null),
            requestHostCommand: () => Promise.resolve(undefined),
            loadOlderHistory: () => undefined,
          },
        },
      ],
    }).compileComponents();
  });

  it('shows the wait instead of the hero while the conversation is still loading', () => {
    loading.set(true);
    const fixture = TestBed.createComponent(ChatTranscript);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.seeding')?.textContent).toContain('Loading the conversation');
    // The hero would sit on top of it and claim the agent is ready.
    expect(host.querySelector('.hero')).toBeNull();
  });

  it('brings the hero back once the conversation has arrived', () => {
    const fixture = TestBed.createComponent(ChatTranscript);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.hero')).toBeTruthy();
    expect(host.querySelector('.seeding')).toBeNull();
  });
});

/**
 * Editing a past prompt is a host capability: the button must only appear when
 * the host can fork, and sending must carry the transcript item id.
 */
describe('ChatTranscript message editing', () => {
  const editMessage = vi.fn();
  const forkMessage = vi.fn();
  const items = signal<TranscriptItem[]>([
    { kind: 'user', id: 'u1', at: 1, text: 'original prompt' },
    { kind: 'assistant', id: 'a1', at: 2, text: 'an answer', thinking: '', streaming: false },
  ]);

  beforeEach(async () => {
    editMessage.mockClear();
    forkMessage.mockClear();
    items.set([
      { kind: 'user', id: 'u1', at: 1, text: 'original prompt' },
      { kind: 'assistant', id: 'a1', at: 2, text: 'an answer', thinking: '', streaming: false },
    ]);
    await TestBed.configureTestingModule({
      imports: [ChatTranscript],
      providers: [
        {
          provide: MorseService,
          useValue: {
            state: signal(viewState()),
            items,
            hasOlderHistory: signal(false),
            loadingOlderHistory: signal(false),
            capabilities: signal({ hostKind: 'server', scope: 'global', editMessage: true, forkMessage: true }),
            editMessage,
            forkMessage,
            requestHostCommand: () => Promise.resolve(undefined),
            loadOlderHistory: () => undefined,
          },
        },
      ],
    }).compileComponents();
  });

  it('opens an inline editor and sends the edited text', () => {
    const fixture = TestBed.createComponent(ChatTranscript);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const editButton = host.querySelector<HTMLButtonElement>('.copy-msg[title="Edit message"]');
    expect(editButton).toBeTruthy();
    editButton?.click();
    fixture.detectChanges();

    const input = host.querySelector<HTMLTextAreaElement>('.edit-input');
    expect(input).toBeTruthy();
    expect(input?.value).toBe('original prompt');

    if (input) {
      input.value = 'corrected prompt';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }
    host.querySelector<HTMLButtonElement>('.edit-send')?.click();

    expect(editMessage).toHaveBeenCalledWith('u1', 'corrected prompt');
    fixture.detectChanges();
    expect(host.querySelector('.edit-input')).toBeNull();
  });

  it('branches from a message and hands the prompt back to the host', () => {
    const fixture = TestBed.createComponent(ChatTranscript);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const forkButton = host.querySelector<HTMLButtonElement>('.copy-msg[title="Fork from here"]');
    expect(forkButton).toBeTruthy();
    forkButton?.click();

    expect(forkMessage).toHaveBeenCalledWith('u1');
    // Forking never opens the inline editor; the composer takes the prompt back.
    expect(host.querySelector('.edit-input')).toBeNull();
  });
});

/**
 * A thinking note that is still streaming is the live indicator: it opens
 * itself, and folds back the moment the message produces prose. The transcript
 * must not add an empty assistant placeholder (a stray caret under the note).
 */
describe('ChatTranscript live thinking', () => {
  const items = signal<TranscriptItem[]>([]);

  beforeEach(async () => {
    items.set([]);
    await TestBed.configureTestingModule({
      imports: [ChatTranscript],
      providers: [
        {
          provide: MorseService,
          useValue: {
            state: signal(viewState(true)),
            items,
            hasOlderHistory: signal(false),
            loadingOlderHistory: signal(false),
            capabilities: signal(null),
            requestHostCommand: () => Promise.resolve(undefined),
            loadOlderHistory: () => undefined,
          },
        },
      ],
    }).compileComponents();
  });

  function setThinkingOnly(): void {
    items.set([
      { kind: 'user', id: 'u1', at: 1, text: 'hello' },
      {
        kind: 'assistant',
        id: 'a1',
        at: 2,
        text: '',
        thinking: 'considering the question',
        streaming: true,
      },
    ]);
  }

  it('expands the streaming note instead of showing a stray caret', () => {
    setThinkingOnly();
    const fixture = TestBed.createComponent(ChatTranscript);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.assistant .cursor')).toBeNull();
    const body = host.querySelector('morse-tool-group .body pre');
    expect(body?.textContent).toContain('considering the question');
    // The purple star breathes while the note is live.
    expect(host.querySelector('morse-tool-group .glyph.thinking.live')).toBeTruthy();
  });

  it('folds the note back once the message has prose', () => {
    setThinkingOnly();
    const fixture = TestBed.createComponent(ChatTranscript);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('morse-tool-group .body pre'),
    ).toBeTruthy();

    items.set([
      { kind: 'user', id: 'u1', at: 1, text: 'hello' },
      {
        kind: 'assistant',
        id: 'a1',
        at: 2,
        text: 'the answer',
        thinking: 'considering the question',
        streaming: true,
      },
    ]);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('morse-tool-group .body pre'),
    ).toBeNull();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('morse-tool-group .glyph.thinking.live'),
    ).toBeNull();
  });
});

/**
 * A stored prompt's chips must name the exact range the reader pinned, whether
 * that range is a column span, whole lines, or the whole file.
 */
describe('ChatTranscript attachment chips', () => {
  const items = signal<TranscriptItem[]>([]);

  beforeEach(async () => {
    items.set([
      {
        kind: 'user',
        id: 'u1',
        at: 1,
        text: 'look at this',
        pins: [
          {
            path: 'src/app.ts',
            startLine: 18,
            startColumn: 45,
            endLine: 18,
            endColumn: 79,
            characters: 35,
            text: 'the highlighted words of one line',
          },
          { path: 'src/lines.ts', startLine: 18, endLine: 20 },
          { path: 'src/whole.ts' },
        ],
      },
    ]);
    await TestBed.configureTestingModule({
      imports: [ChatTranscript],
      providers: [
        {
          provide: MorseService,
          useValue: {
            state: signal(viewState()),
            items,
            hasOlderHistory: signal(false),
            loadingOlderHistory: signal(false),
            capabilities: signal(null),
            requestHostCommand: () => Promise.resolve(undefined),
            loadOlderHistory: () => undefined,
          },
        },
      ],
    }).compileComponents();
  });

  it('labels a column pin with its exact columns', () => {
    const fixture = TestBed.createComponent(ChatTranscript);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const lines = [...host.querySelectorAll('.mention-pin .lines')].map(
      (node) => node.textContent?.trim() ?? '',
    );
    expect(lines).toEqual(['L18:45-79', 'L18-20']);
    const title = host.querySelector('.mention-pin')?.getAttribute('title') ?? '';
    expect(title).toContain('src/app.ts');
    expect(title).toContain('line 18, columns 45-79');
    expect(title).toContain('35 selected');
    expect(title).toContain('the highlighted words of one line');
  });

  it('shows no range for a whole-file pin', () => {
    const fixture = TestBed.createComponent(ChatTranscript);
    fixture.detectChanges();
    const chips = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.mention-pin')];
    expect(chips).toHaveLength(3);
    expect(chips[2]?.querySelector('.lines')).toBeNull();
    expect(chips[2]?.querySelector('.name')?.textContent).toBe('whole.ts');
  });
});
