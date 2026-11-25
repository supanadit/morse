import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage, type SessionViewState } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { ChatComposer } from './composer';

/** A host that reports four choices, so the phone's one sheet has work to do. */
class SettingsHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  readonly sent: ClientToHostMessage[] = [];

  constructor(private readonly patch: Partial<SessionViewState> = {}) {
    super();
  }

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
        user: null,
        capabilities: {
          hostKind: 'server',
          scope: 'global',
          editorContext: false,
          nativeDialogs: false,
          insertIntoEditor: false,
          revealFile: false,
          sharedComposer: false,
          engines: [
            { kind: 'pi', label: 'Pi', default: true },
            { kind: 'opencode', label: 'OpenCode' },
          ],
        },
        state: {
          workspace: { cwd: '/work/morse', name: 'morse' },
          draft: true,
          engine: 'opencode',
          mode: 'build',
          model: { provider: 'anthropic', id: 'sonnet', name: 'Sonnet' },
          thinkingLevel: 'high',
          availableModels: [
            { provider: 'anthropic', id: 'sonnet', name: 'Sonnet' },
            { provider: 'openai', id: 'gpt', name: 'GPT' },
          ],
          availableThinkingLevels: ['off', 'low', 'high'],
          availableCommands: [],
          availableModes: [
            { id: 'build', name: 'Build', default: true },
            { id: 'plan', name: 'Plan' },
          ],
          streaming: false,
          busy: false,
          agentReady: true,
          agentStarting: false,
          ...this.patch,
        } satisfies SessionViewState,
      },
    });
  }

  dispose(): void {
    this.emitStatus('closed');
  }
}

async function mount(transport: SettingsHostTransport): Promise<{
  fixture: ComponentFixture<ChatComposer>;
  host: HTMLElement;
}> {
  await TestBed.configureTestingModule({
    imports: [ChatComposer],
    providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

function openSheet(fixture: ComponentFixture<ChatComposer>, host: HTMLElement): HTMLElement {
  (host.querySelector('.settings-trigger') as HTMLButtonElement).click();
  fixture.detectChanges();
  return host.querySelector('.settings-sheet') as HTMLElement;
}

function sheetRows(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll('.settings-sheet .sheet-row')] as HTMLButtonElement[];
}

describe('ChatComposer nested options sheet', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** The index's four rows, in order. */
  function navRows(host: HTMLElement): HTMLElement[] {
    return [...host.querySelectorAll('.settings-sheet .nav-row')] as HTMLElement[];
  }

  function rows(host: HTMLElement): HTMLButtonElement[] {
    return [...host.querySelectorAll('.settings-sheet .sheet-row')] as HTMLButtonElement[];
  }

  function rowText(host: HTMLElement): (string | undefined)[] {
    return rows(host).map((row) => row.textContent?.trim());
  }

  it('opens on an index, then slides into one list at a time', async () => {
    const transport = new SettingsHostTransport();
    const { fixture, host } = await mount(transport);

    const sheet = openSheet(fixture, host);
    expect(sheet.querySelector('strong')?.textContent).toBe('Session options');
    expect(navRows(host).map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Agent engineOpenCode›',
      'ModeBuild›',
      'ModelSonnet›',
      'Thinking levelhigh›',
    ]);
    expect(rows(host)).toHaveLength(0);

    // The mode picker refreshes when a reader opens it; the sheet must too.
    expect(transport.sent.some((message) => message.type === 'modes/refresh')).toBe(true);

    navRows(host)[2].click();
    fixture.detectChanges();
    expect(sheet.querySelector('strong')?.textContent).toBe('Model');
    expect(rowText(host)).toEqual(['Sonnetanthropic✓', 'GPTopenai']);
    expect(host.querySelector('.model-search')).not.toBeNull();

    (host.querySelector('.sheet-back') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(sheet.querySelector('strong')?.textContent).toBe('Session options');
    expect(navRows(host)).toHaveLength(4);
    expect(host.querySelector('.sheet-page')?.classList.contains('back')).toBe(true);
  });

  it('sends the pick from a nested page and returns to the index', async () => {
    const transport = new SettingsHostTransport();
    const { fixture, host } = await mount(transport);

    openSheet(fixture, host);
    navRows(host)[3].click();
    fixture.detectChanges();
    rows(host).find((row) => row.textContent?.includes('low'))?.click();
    fixture.detectChanges();

    expect(transport.sent).toContainEqual({
      type: 'thinking/set',
      payload: { level: 'low' },
    });
    // Picking one choice does not throw away the sheet: the next setting is one
    // tap away, which is how a phone settings page behaves.
    expect(host.querySelector('.settings-sheet')).not.toBeNull();
    expect(host.querySelector('.settings-sheet strong')?.textContent).toBe('Session options');
  });

  it('re-probes modes even when the Mode row is not there yet', async () => {
    const transport = new SettingsHostTransport({
      availableModes: [],
      loadingEngine: true,
    });
    const { fixture, host } = await mount(transport);
    const sheet = openSheet(fixture, host);

    expect(transport.sent.some((message) => message.type === 'modes/refresh')).toBe(true);
    const modeRow = navRows(host).find((row) => row.textContent?.includes('Mode'));
    expect(modeRow?.classList.contains('pending')).toBe(true);
    expect(modeRow?.textContent).toContain('Reading engine choices…');
    expect(sheet.querySelector('.sheet-back')).toBeNull();
  });

  it('filters models on their page and starts clean on the next open', async () => {
    const transport = new SettingsHostTransport();
    const { fixture, host } = await mount(transport);

    openSheet(fixture, host);
    navRows(host)[2].click();
    fixture.detectChanges();

    const field = host.querySelector('.model-search') as HTMLInputElement;
    field.value = 'openai';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    expect(rowText(host)).toEqual(['GPTopenai']);

    (host.querySelector('.sheet-close') as HTMLButtonElement).click();
    fixture.detectChanges();
    const sheet = openSheet(fixture, host);
    expect(sheet.querySelector('strong')?.textContent).toBe('Session options');
    navRows(host)[2].click();
    fixture.detectChanges();
    expect(rows(host)).toHaveLength(2);
  });

  it('closes on the scrim and on Escape', async () => {
    const transport = new SettingsHostTransport();
    const { fixture, host } = await mount(transport);

    openSheet(fixture, host);
    (host.querySelector('.sheet-scrim') as HTMLElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.settings-sheet')).toBeNull();

    openSheet(fixture, host);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(host.querySelector('.settings-sheet')).toBeNull();
  });
});
