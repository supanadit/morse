import { TestBed } from '@angular/core/testing';
import type { ClientToHostMessage } from '@morse/protocol';
import { MemoryHostTransport, cacheHitRate, formatTokens, formatUsage } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { AttachmentStore } from '../../state/attachments';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import {
  ChatComposer,
  type BotComposerSend,
  outputChars,
  builtinName,
  compactInstructions,
} from './composer';

describe('formatTokens', () => {
  it('compacts like pi: 1.2k, 56k, 2.8M', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_200)).toBe('1.2k');
    expect(formatTokens(56_400)).toBe('56k');
    expect(formatTokens(2_800_000)).toBe('2.8M');
    expect(formatTokens(12_000_000)).toBe('12M');
  });
});

describe('formatUsage', () => {
  it('renders the TUI footer layout with cache hit and context', () => {
    const label = formatUsage({
      usage: {
        inputTokens: 56_400,
        outputTokens: 35_200,
        totalTokens: 91_600,
        cacheReadTokens: 2_800_000,
        cacheWriteTokens: 12_000,
      },
      costUsd: 0.42,
      contextUsage: { tokens: 79_000, contextWindow: 1_000_000, percent: 7.9 },
    });

    // cache hit = 2.8M / (56.4k + 2.8M + 12k) ~ 97.6%
    expect(label).toBe('↑56k ↓35k R2.8M W12k CH97.6% $0.420 7.9%/1.0M');
  });

  it('omits a cache hit when the provider reports no caching', () => {
    const label = formatUsage({
      usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
    });

    expect(label).toBe('↑500 ↓200 ?/200k');
  });

  it('is empty before any usage arrives', () => {
    expect(formatUsage({})).toBe('');
  });
});

describe('cacheHitRate', () => {
  it('is undefined when the provider reports no caching', () => {
    expect(cacheHitRate({ inputTokens: 500, outputTokens: 1, totalTokens: 501 })).toBeUndefined();
  });

  it('is the share of the prompt served from cache', () => {
    expect(
      cacheHitRate({
        inputTokens: 1000,
        outputTokens: 10,
        totalTokens: 1010,
        cacheReadTokens: 3000,
      }),
    ).toBe(75);
  });
});

describe('outputChars', () => {
  it('counts thinking, not just the visible answer', () => {
    const items = [
      { kind: 'assistant', text: 'hello', thinking: '1234567890' },
      { kind: 'tool', text: 'ignored' },
      { kind: 'user', text: 'ignored' },
    ];
    // 5 + 10 = 15; tool output and the user prompt are not generated tokens.
    expect(outputChars(items)).toBe(15);
  });

  it('is monotonic across assistant messages in one run', () => {
    const first = [{ kind: 'assistant', text: 'aaaa', thinking: '' }];
    const second = [
      { kind: 'assistant', text: 'aaaa', thinking: '' },
      { kind: 'assistant', text: 'bb', thinking: 'ccc' },
    ];
    expect(outputChars(second)).toBeGreaterThan(outputChars(first));
  });
});

/** Only TUI built-ins are Morse's to run; everything else goes to pi. */
describe('builtinName', () => {
  it('recognises a bare built-in', () => {
    expect(builtinName('/compact')).toBe('compact');
    expect(builtinName('/model')).toBe('model');
    expect(builtinName('/about')).toBe('about');
  });

  it('leaves pi commands to pi', () => {
    expect(builtinName('/skill:codebase-memory')).toBeUndefined();
    expect(builtinName('/fix-tests')).toBeUndefined();
    expect(builtinName('/unknown')).toBeUndefined();
  });

  it('is not a command when there are arguments', () => {
    expect(builtinName('/compact keep the decisions')).toBeUndefined();
  });
});

/**
 * `/compact …` with arguments is not a *built-in*, but it is the same compaction —
 * so the composer gates it too, with the words attached.
 */
describe('compactInstructions', () => {
  it('takes the words that followed the command', () => {
    expect(compactInstructions('/compact keep the decisions')).toBe('keep the decisions');
    expect(compactInstructions('/compact  keep   the schema ')).toBe('keep   the schema');
    expect(compactInstructions('/compact\nkeep the decisions')).toBe('keep the decisions');
  });

  it('leaves the bare command and everything else alone', () => {
    expect(compactInstructions('/compact')).toBeUndefined();
    expect(compactInstructions('/compactable')).toBeUndefined();
    expect(compactInstructions('/fix-tests compact it')).toBeUndefined();
    expect(compactInstructions('please /compact this')).toBeUndefined();
  });
});

/**
 * The bot variant: the same prompt box, without the session's machinery around
 * it. Bot mode reuses the composer so a reader keeps the editor, the send key
 * and the look, but the model/thinking/engine pickers, the attach row and the
 * `@`-mention affordances describe a session this conversation does not have.
 * Its line leaves through `botSend`, not the session prompt path.
 */
class RecordingMemoryHost extends MemoryHostTransport {
  readonly sent: ClientToHostMessage[] = [];

  override send(message: ClientToHostMessage): void {
    this.sent.push(message);
    super.send(message);
  }

  /** Replays a `session/state`, the way the host reports a run in flight. */
  runStreaming(on: boolean): void {
    this.emitMessage({
      type: 'session/state',
      payload: {
        workspace: { cwd: '/work/morse', name: 'morse' },
        thinkingLevel: 'off',
        availableModels: [],
        availableThinkingLevels: [],
        availableCommands: [],
        streaming: on,
        busy: false,
        agentReady: true,
        agentStarting: false,
      },
    });
  }
}

async function mountComposer(): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<ChatComposer>>;
  host: HTMLElement;
  transport: RecordingMemoryHost;
}> {
  TestBed.resetTestingModule();
  const transport = new RecordingMemoryHost();
  await TestBed.configureTestingModule({
    imports: [ChatComposer],
    providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, transport };
}

function botPrompt(host: HTMLElement): HTMLTextAreaElement {
  return host.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement;
}

function typeInto(host: HTMLElement, text: string): void {
  const box = botPrompt(host);
  box.value = text;
  box.dispatchEvent(new Event('input'));
}

function pressSend(host: HTMLElement): void {
  botPrompt(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

/** A browser File whose bytes are a known, short base64 payload. */
function fakeFile(name: string, mimeType: string, body: 'img' | 'file' = 'img'): File {
  return new File([body], name, { type: mimeType });
}

/**
 * The bot conversation in front, with one member whose model declares `input`.
 * `openConversation` is what makes the composer's image gate decide anything:
 * with no roster it answers `'unknown'` and lets everything through.
 */
function openConversation(
  fixture: ReturnType<typeof TestBed.createComponent<ChatComposer>>,
  input: ('text' | 'image')[],
): void {
  const morse = TestBed.inject(MorseService);
  morse.bot.onRoster({
    bots: [
      {
        username: 'forge',
        name: 'Forge',
        description: 'Builds things',
        engineKind: 'pi',
        model: { provider: 'p', id: 'm', name: 'Model', input },
        warm: false,
      },
    ],
    conversations: [
      { id: 'dm-forge', kind: 'dm', title: 'Forge', members: ['forge'], chainCap: 8, updatedAt: 1 },
    ],
  });
  morse.bot.activeId.set('dm-forge');
  fixture.detectChanges();
}

/** A clipboard paste of one image, the way a browser delivers a screenshot. */
function pasteImage(host: HTMLElement, name: string): void {
  const box = botPrompt(host);
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: { files: [fakeFile(name, 'image/png')], items: [], types: ['Files'] },
  });
  box.dispatchEvent(event);
}

/** The file dialog's result, since a test cannot open one. */
function chooseFile(
  host: HTMLElement,
  name: string,
  mimeType: string,
  body: 'img' | 'file' = 'img',
): void {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  const file = fakeFile(name, mimeType, body);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Waits for an attachment to land. Reading a browser File is asynchronous (a
 * `FileReader` per file) and the count differs under load, so this polls for the
 * effect instead of guessing a number of ticks — a fixed wait passed alone and
 * failed inside the full suite.
 */
async function waitFor(
  fixture: ReturnType<typeof TestBed.createComponent<ChatComposer>>,
  check: () => void,
): Promise<void> {
  await vi.waitFor(
    () => {
      fixture.detectChanges();
      check();
    },
    { timeout: 2000, interval: 5 },
  );
}

describe('ChatComposer bot variant', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('hides the session pickers and the attach row', async () => {
    const { fixture, host } = await mountComposer();
    // The default variant keeps them — this is the control for the test below.
    expect(host.querySelector('.model-button')).not.toBeNull();
    expect(host.querySelector('morse-thinking-picker')).not.toBeNull();
    expect(host.querySelector('.toolbar')).not.toBeNull();

    fixture.componentRef.setInput('variant', 'bot');
    fixture.detectChanges();

    expect(host.querySelector('.model-button')).toBeNull();
    expect(host.querySelector('morse-thinking-picker')).toBeNull();
    expect(host.querySelector('morse-option-picker')).toBeNull();
    // Only the attach control is left: a bot has no workspace to mention from
    // and no slash commands, but it does take an image or a file.
    const toolbar = host.querySelector('.toolbar') as HTMLElement;
    expect(toolbar).not.toBeNull();
    expect(toolbar.querySelectorAll('button')).toHaveLength(1);
    expect(toolbar.textContent).toContain('attach an image or a file');
    // Nothing is attached yet, so no chip row either.
    expect(host.querySelector('.attachments')).toBeNull();
    // The editor itself stays: this is the one thing a bot message is typed in.
    expect(botPrompt(host)).not.toBeNull();
  });

  it('emits botSend on Enter instead of the session prompt path', async () => {
    const { fixture, host, transport } = await mountComposer();
    const emitted: string[] = [];
    fixture.componentInstance.botSend.subscribe((line) => emitted.push(line.text));
    fixture.componentRef.setInput('variant', 'bot');
    fixture.detectChanges();

    typeInto(host, '  @Forge what changed?  ');
    fixture.detectChanges();
    pressSend(host);
    fixture.detectChanges();

    expect(emitted).toEqual(['@Forge what changed?']);
    expect(transport.sent.some((message) => message.type === 'chat/prompt')).toBe(false);
    // The line left the box: a second Enter must not send it again.
    expect(botPrompt(host).value).toBe('');
  });

  it('treats an empty or whitespace-only line as a no-op', async () => {
    const { fixture, host } = await mountComposer();
    const emitted: string[] = [];
    fixture.componentInstance.botSend.subscribe((line) => emitted.push(line.text));
    fixture.componentRef.setInput('variant', 'bot');
    fixture.detectChanges();

    pressSend(host);
    typeInto(host, '   \n  ');
    fixture.detectChanges();
    pressSend(host);
    fixture.detectChanges();

    expect(emitted).toEqual([]);
  });

  it('sends the bot line from the Send button too', async () => {
    const { fixture, host } = await mountComposer();
    const emitted: string[] = [];
    fixture.componentInstance.botSend.subscribe((line) => emitted.push(line.text));
    fixture.componentRef.setInput('variant', 'bot');
    fixture.detectChanges();

    typeInto(host, 'hello');
    fixture.detectChanges();
    (host.querySelector('.icon.send') as HTMLButtonElement).click();

    expect(emitted).toEqual(['hello']);
  });

  it('takes a bot placeholder without changing the session one', async () => {
    const { fixture, host } = await mountComposer();
    fixture.componentRef.setInput('placeholder', 'Message Forge…');
    fixture.detectChanges();
    // The session composer keeps its own contextual hint.
    expect(botPrompt(host).placeholder).toContain('Ask Morse');

    fixture.componentRef.setInput('variant', 'bot');
    fixture.detectChanges();
    expect(botPrompt(host).placeholder).toBe('Message Forge…');
  });

  it('carries a pasted image to the bot when its model takes images', async () => {
    const { fixture, host } = await mountComposer();
    const lines: BotComposerSend[] = [];
    fixture.componentInstance.botSend.subscribe((line) => lines.push(line));
    fixture.componentRef.setInput('variant', 'bot');
    fixture.detectChanges();
    openConversation(fixture, ['image']);

    pasteImage(host, 'shot.png');
    // The image is a chip on the message, exactly like a code session's.
    await waitFor(fixture, () =>
      expect(host.querySelector('.attachments .chip img')).not.toBeNull(),
    );

    typeInto(host, 'what is wrong here?');
    fixture.detectChanges();
    pressSend(host);
    fixture.detectChanges();

    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('what is wrong here?');
    expect(lines[0]?.images).toEqual([{ data: 'aW1n', mimeType: 'image/png' }]);
    expect(lines[0]?.files).toEqual([]);
    // The chip row is emptied with the message, not left behind.
    expect(host.querySelector('.attachments')).toBeNull();
  });

  it('refuses a pasted image for a model that reported text only, and says why', async () => {
    const { fixture, host } = await mountComposer();
    fixture.componentRef.setInput('variant', 'bot');
    fixture.detectChanges();
    openConversation(fixture, ['text']);

    pasteImage(host, 'shot.png');
    await waitFor(fixture, () =>
      expect(TestBed.inject(AttachmentStore).notice()?.text).toContain('takes text only'),
    );

    expect(host.querySelector('.attachments')).toBeNull();
    // The refusal is said where every other attachment notice goes, not hidden.
    expect(TestBed.inject(AttachmentStore).notice()?.text).toContain(
      'This bot’s model takes text only',
    );
    // A file is still welcome: the refusal is about images, not attachments.
    expect(host.querySelector('.toolbar')?.textContent).toContain(
      'this bot’s model takes text only',
    );
  });

  it('carries a chosen file to the bot, whose host writes it into its workspace', async () => {
    const { fixture, host } = await mountComposer();
    const lines: BotComposerSend[] = [];
    fixture.componentInstance.botSend.subscribe((line) => lines.push(line));
    fixture.componentRef.setInput('variant', 'bot');
    fixture.detectChanges();
    openConversation(fixture, ['text']);

    chooseFile(host, 'cv.pdf', 'application/pdf', 'file');
    await waitFor(fixture, () =>
      expect(host.querySelector('.attachments .chip-name')?.textContent).toContain('cv.pdf'),
    );

    typeInto(host, 'read my cv');
    fixture.detectChanges();
    pressSend(host);
    fixture.detectChanges();

    expect(lines[0]?.files).toEqual([
      { name: 'cv.pdf', mimeType: 'application/pdf', data: 'ZmlsZQ==' },
    ]);
    expect(lines[0]?.images).toEqual([]);
  });

  it('keeps the session run controls out of the bot composer', async () => {
    const { fixture, host, transport } = await mountComposer();
    transport.runStreaming(true);
    fixture.detectChanges();

    // The control: while the code session's run is live, it owns these.
    expect(host.querySelector('.controls-actions .icon.stop')).not.toBeNull();
    expect(host.querySelectorAll('.controls-actions .secondary')).toHaveLength(2);

    fixture.componentRef.setInput('variant', 'bot');
    fixture.detectChanges();

    // A bot round is stopped from its own routing strip, and Steer would send a
    // bot line; the bot composer offers only Send, whatever the code session does.
    expect(host.querySelector('.controls-actions .icon.stop')).toBeNull();
    expect(host.querySelectorAll('.controls-actions .secondary')).toHaveLength(0);
    const send = host.querySelector('.controls-actions .icon.send') as HTMLButtonElement;
    expect(send).not.toBeNull();
    expect(send.disabled).toBe(false);
  });

  it('keeps the default variant sending through the session prompt path', async () => {
    const { fixture, host, transport } = await mountComposer();
    const emitted: string[] = [];
    fixture.componentInstance.botSend.subscribe((line) => emitted.push(line.text));

    typeInto(host, 'hello');
    fixture.detectChanges();
    pressSend(host);
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(transport.sent.some((message) => message.type === 'chat/prompt')).toBe(true);
  });
});
