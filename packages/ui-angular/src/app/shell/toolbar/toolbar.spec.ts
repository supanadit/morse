import { TestBed } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport, MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellState } from '../../state/shell-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { Toolbar } from './toolbar';

/** A VS Code webview host: the window already owns the modes and the sidebar. */
class VsCodeHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;

  connect(): void {
    this.emitStatus('open');
  }

  dispose(): void {
    this.emitStatus('closed');
  }

  send(message: ClientToHostMessage): void {
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
          editorContext: true,
          nativeDialogs: true,
          insertIntoEditor: true,
          revealFile: true,
          filePicker: true,
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
}

/** The web host that runs Bot mode: the mode row's Bot tab is live. */
class BotHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;

  connect(): void {
    this.emitStatus('open');
  }

  dispose(): void {
    this.emitStatus('closed');
  }

  send(message: ClientToHostMessage): void {
    if (message.type !== 'client/ready') {
      return;
    }
    this.emitMessage({
      type: 'host/ready',
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          hostKind: 'server',
          scope: 'global',
          editorContext: false,
          nativeDialogs: false,
          insertIntoEditor: false,
          revealFile: false,
          bot: true,
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
}

/** The toolbar's one job: the window's way into every command. */
describe('Toolbar', () => {
  afterEach(() => TestBed.resetTestingModule());

  beforeEach(async () => {
    // The mock host advertises `promptEditor`, so the button under test renders.
    await TestBed.configureTestingModule({
      imports: [Toolbar],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
    }).compileComponents();
  });

  it('opens the command palette from the command centre', () => {
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();
    const shell = TestBed.inject(ShellState);
    expect(shell.paletteOpen()).toBe(false);

    (fixture.nativeElement.querySelector('.command') as HTMLButtonElement).click();

    expect(shell.paletteOpen()).toBe(true);
  });

  it('opens the prompt-template editor from its button', () => {
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();
    const tabs = TestBed.inject(WorkspaceTabs);
    // The button takes the shared path, so the host choice (a tab here, an editor
    // panel in VS Code) is `WorkspaceTabs`'s to make and is tested there.
    const open = vi.spyOn(tabs, 'openPromptEditor');

    const button = fixture.nativeElement.querySelector('.prompts') as HTMLButtonElement;
    expect(button).toBeTruthy();
    button.click();

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows Code as the mode in use, and Bot as a mode that is not here yet', () => {
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();

    // The mode row is drawn from the first release: one tab that is the product,
    // one that says it is coming — never a live control that opens nothing.
    const modes = [...fixture.nativeElement.querySelectorAll('.mode')] as HTMLButtonElement[];
    const code = modes.find((one) => one.textContent?.includes('Code'));
    const bot = modes.find((one) => one.textContent?.includes('Bot'));

    expect(code?.classList.contains('on')).toBe(true);
    expect(code?.getAttribute('aria-current')).toBe('page');
    expect(bot?.disabled).toBe(true);
    expect(bot?.textContent).toContain('Soon');
    expect(bot?.getAttribute('title')).toBe('Bot — coming soon');
  });

  it('enables Bot, and drops its Soon chip, where the host runs bots', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [Toolbar],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new BotHostTransport() }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();

    const bot = [...fixture.nativeElement.querySelectorAll('.mode')].find((one: HTMLElement) =>
      one.textContent?.includes('Bot'),
    ) as HTMLButtonElement;

    expect(bot.disabled).toBe(false);
    expect(bot.querySelector('.soon')).toBeNull();
    expect(bot.getAttribute('title')).toBe('Bot — chat with isolated agents');
  });

  it('switches the mode from the row, and back from Code', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [Toolbar],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new BotHostTransport() }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();
    const emitted: Array<'code' | 'bot'> = [];
    fixture.componentInstance.modeChange.subscribe((mode) => emitted.push(mode));

    const modes = [...fixture.nativeElement.querySelectorAll('.mode')] as HTMLButtonElement[];
    const code = modes.find((one) => one.textContent?.includes('Code')) as HTMLButtonElement;
    const bot = modes.find((one) => one.textContent?.includes('Bot')) as HTMLButtonElement;

    bot.click();
    expect(emitted).toEqual(['bot']);

    // The shell owns the mode, so the row only reports the click: once it hands
    // the new mode back, the row shows where the window is.
    fixture.componentRef.setInput('mode', 'bot');
    fixture.detectChanges();
    expect(bot.classList.contains('on')).toBe(true);
    expect(bot.getAttribute('aria-current')).toBe('page');
    expect(code.classList.contains('on')).toBe(false);
    expect(code.getAttribute('aria-current')).toBeNull();

    code.click();
    expect(emitted).toEqual(['bot', 'code']);
  });

  it('reports nothing from the Bot tab while the host has no bots', () => {
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();
    const emitted: Array<'code' | 'bot'> = [];
    fixture.componentInstance.modeChange.subscribe((mode) => emitted.push(mode));

    const bot = [...fixture.nativeElement.querySelectorAll('.mode')].find((one: HTMLElement) =>
      one.textContent?.includes('Bot'),
    ) as HTMLButtonElement;
    bot.click();

    expect(emitted).toEqual([]);
  });

  it('keeps the mode row out of the VS Code host', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [Toolbar],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new VsCodeHostTransport() }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();

    // The extension's window already owns the modes; only the web host grows the row.
    expect(fixture.nativeElement.querySelector('.modes')).toBeNull();
  });

  it('prints the keys that open the palette inside the search box', () => {
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();

    // The hint comes from the shortcut catalog, so it cannot promise a key the
    // keyboard does not answer to.
    const hint = fixture.nativeElement.querySelector('.command-key') as HTMLElement;
    expect(hint.textContent?.trim()).toBeTruthy();
  });
});
