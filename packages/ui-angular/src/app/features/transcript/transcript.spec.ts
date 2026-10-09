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
