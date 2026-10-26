import { TestBed } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { ComposerDrafts } from '../../state/composer-drafts';
import { ChatComposer } from './composer';

/** Answers the handshake so the composer renders in its normal, ready shape. */
class ReadyHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  readonly sent: ClientToHostMessage[] = [];

  connect(): void {
    this.emitStatus('open');
  }

  send(message: ClientToHostMessage): void {
    this.sent.push(message);
    if (message.type !== 'client/ready') {
      return;
    }
    this.emitMessage({
      type: 'host/ready',
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          hostKind: 'vscode',
          scope: 'workspace',
          editorContext: false,
          nativeDialogs: false,
          insertIntoEditor: false,
          revealFile: false,
        },
        state: {
          workspace: { cwd: '/work/morse', name: 'morse' },
          thinkingLevel: 'off',
          availableModels: [],
          availableThinkingLevels: [],
          availableCommands: [],
          streaming: false,
          busy: false,
          agentReady: true,
          agentStarting: false,
        },
      },
    });
  }

  dispose(): void {
    this.emitStatus('closed');
  }
}

async function mount(): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<ChatComposer>>;
  host: HTMLElement;
  area: HTMLTextAreaElement;
  paint: HTMLElement;
  transport: ReadyHostTransport;
}> {
  const transport = new ReadyHostTransport();
  await TestBed.configureTestingModule({
    imports: [ChatComposer],
    providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    host,
    area: host.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement,
    paint: host.querySelector('.paint') as HTMLElement,
    transport,
  };
}

/** The prompts the host would see — everything but the handshake. */
function prompts(transport: ReadyHostTransport): ClientToHostMessage[] {
  return transport.sent.filter((message) => message.type !== 'client/ready');
}

/** Types the way a user does: the DOM value, then one input event. */
function type(fixture: { detectChanges(): void }, area: HTMLTextAreaElement, text: string): void {
  area.value = text;
  area.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

function press(area: HTMLTextAreaElement, key: string, modifiers: KeyboardEventInit = {}): void {
  area.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }));
}

/** Lets the scheduled paint frames run. */
function flush(): void {
  for (const frame of vi.mocked(globalThis.requestAnimationFrame).mock.calls) {
    (frame[0] as FrameRequestCallback)(0);
  }
  vi.mocked(globalThis.requestAnimationFrame).mockClear();
}

const DRAFT = ['Run this:', '```json', '{"a": 1}', '```', 'thanks!'].join('\n');

describe('ChatComposer markdown paint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('shows the typed draft styled over the transparent surface, character-identical', async () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const { fixture, area, paint } = await mount();

    type(fixture, area, DRAFT);
    flush();
    fixture.detectChanges();

    // The geometry contract in the real composer: the mirror holds exactly what
    // is in the buffer, and the textarea's own glyphs are transparent.
    expect(paint.textContent).toBe(area.value);
    expect(paint.textContent).toBe(DRAFT);
    expect(paint.querySelector('.md-fence')?.textContent).toBe('```json');
    expect(paint.querySelectorAll('.md-code')).toHaveLength(1);
    expect(getComputedStyle(area).color).toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
    expect(getComputedStyle(area).caretColor).not.toBe('transparent');
  });

  /**
   * The composer hosts the layers: transparent surface on top, styled mirror
   * underneath, both inside one host box that flexes in maximize. jsdom cannot
   * resolve `var()` or render rows, so this asserts the alignment contract at
   * the source — one set of metrics read by both layers — at both sizes.
   */
  it('keeps the layers aligned at both sizes: docked and maximized', async () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const { fixture, host, area, paint } = await mount();
    type(fixture, area, DRAFT);

    const paintHost = host.querySelector('morse-markdown-paint') as HTMLElement;
    const styles = [...document.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('\n');
    // One set of metrics: the paint host declares it, the textarea reads it.
    expect(getComputedStyle(paintHost).getPropertyValue('--mdp-padding')).toBe('4px 6px');
    expect(getComputedStyle(paintHost).getPropertyValue('--mdp-line-height')).toBe('1.5');
    expect(styles).toMatch(/textarea[^{]*\{[^}]*padding: var\(--mdp-padding, 4px 6px\)/);
    expect(styles).toMatch(/textarea[^{]*\{[^}]*line-height: var\(--mdp-line-height, 1\.5\)/);
    // Maximize hands the height to the shared wrapper, not to one layer alone.
    expect(styles).toMatch(/morse-markdown-paint[^{]*\{[^}]*flex: 1[^}]*min-height: 0/);

    for (const maximized of [false, true]) {
      const button = host.querySelector('.fold-shut[aria-pressed]') as HTMLButtonElement;
      if (maximized) {
        button.click();
        fixture.detectChanges();
      }
      expect(button.getAttribute('aria-pressed')).toBe(String(maximized));
      // The layers stay nested and cover the same box at both sizes.
      expect(area.parentElement).toBe(paintHost);
      expect(paint.parentElement).toBe(paintHost);
      expect(paint.getBoundingClientRect().height).toBe(area.getBoundingClientRect().height);
      expect(paint.scrollHeight).toBe(area.scrollHeight);
    }
  });

  it('transmits a fenced draft byte-for-byte; the painted layer never rewrites it', async () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const { fixture, area, paint, transport } = await mount();
    // A draft with everything that could tempt a rewriter: fences, an unclosed
    // emphasis opener, an @mention and a /command-looking line.
    const draft = ['Build this', '```sh', 'npm run build', '```', 'cc @src/app.ts', '/review correctness', 'thanks *everyone'].join('\n');
    type(fixture, area, draft);
    flush();
    fixture.detectChanges();

    // Painting restyles characters in place; the buffer a copy would put on the
    // clipboard is still exactly the typed source.
    expect(area.value).toBe(draft);
    expect(paint.textContent).toBe(draft);

    // Docked, Enter sends: the host receives the typed source unchanged.
    press(area, 'Enter');
    fixture.detectChanges();
    const prompt = prompts(transport).find((message) => message.type === 'chat/prompt');
    expect(prompt?.payload.text).toBe(draft);
  });

  it('keeps Enter/Shift+Enter semantics over formatted text at both sizes', async () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const { fixture, host, area, transport } = await mount();
    type(fixture, area, DRAFT);

    // Docked: Shift+Enter writes a line and sends nothing; Enter sends.
    // (jsdom does not run the un-prevented default, so the newline the browser
    // would insert is typed in explicitly.)
    press(area, 'Enter', { shiftKey: true });
    fixture.detectChanges();
    expect(prompts(transport)).toHaveLength(0);
    type(fixture, area, `${DRAFT}\n`);
    press(area, 'Enter');
    fixture.detectChanges();
    expect(
      prompts(transport).find((message) => message.type === 'chat/prompt')?.payload.text,
    ).toBe(DRAFT);

    // Maximized: the rule flips — Enter writes a line, Shift+Enter sends.
    (host.querySelector('.fold-shut[aria-pressed]') as HTMLButtonElement).click();
    fixture.detectChanges();
    type(fixture, area, DRAFT);
    press(area, 'Enter');
    fixture.detectChanges();
    expect(prompts(transport)).toHaveLength(1);
    type(fixture, area, `${DRAFT}\n`);
    press(area, 'Enter', { shiftKey: true });
    fixture.detectChanges();
    const sent = prompts(transport).filter((message) => message.type === 'chat/prompt');
    expect(sent).toHaveLength(2);
    // Sending trims the buffer, nothing else: the typed source rides through.
    expect(sent[1]?.payload.text).toBe(DRAFT);
  });

  it('repaints when a mention or seed fills the draft outside a keypress', async () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const { fixture, area, paint } = await mount();

    // Mentions and host seeds land through the draft store, not a DOM input
    // event (onPickFile, onComposerSeed); the mirror follows the same signal.
    TestBed.inject(ComposerDrafts).setText('pin @src/app.ts to this');
    fixture.detectChanges();
    flush();
    fixture.detectChanges();

    expect(area.value).toBe('pin @src/app.ts to this');
    expect(paint.textContent).toBe(area.value);
  });

  it('restores a maximized formatted draft on Escape, palette or not', async () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const { fixture, host, area } = await mount();
    (host.querySelector('.fold-shut[aria-pressed]') as HTMLButtonElement).click();
    fixture.detectChanges();
    type(fixture, area, DRAFT);

    press(area, 'Escape');
    fixture.detectChanges();
    expect(host.classList.contains('maximized')).toBe(false);
    // The draft survives the size change untouched.
    expect(area.value).toBe(DRAFT);
  });
});
