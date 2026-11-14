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

  it('shows Code as the mode in use, and Bot as a beta this host cannot run', () => {
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();

    // The mode row is drawn from the first release: one tab that is the product,
    // one that is shipped and unfinished — never a live control that opens nothing.
    const modes = [...fixture.nativeElement.querySelectorAll('.mode')] as HTMLButtonElement[];
    const code = modes.find((one) => one.textContent?.includes('Code'));
    const bot = modes.find((one) => one.textContent?.includes('Bot'));

    expect(code?.classList.contains('on')).toBe(true);
    expect(code?.getAttribute('aria-current')).toBe('page');
    expect(bot?.disabled).toBe(true);
    // The badge is about the feature's maturity, not about this host's support.
    expect(bot?.querySelector('.beta')?.textContent).toBe('Beta');
    expect(bot?.getAttribute('title')).toBe('Bot (beta) — this host cannot run bot mode yet');
  });

  it('enables Bot where the host runs bots, and keeps the beta badge', async () => {
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
    // Enabling the mode does not finish it: the badge stays.
    expect(bot.querySelector('.beta')?.textContent).toBe('Beta');
    expect(bot.getAttribute('title')).toBe('Bot (beta) — chat with isolated agents');
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

  it('stands the code-only action groups down while bot mode owns the window', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [Toolbar],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();

    // The control: every one of these buttons describes a code conversation.
    expect(fixture.nativeElement.querySelector('.actions .prompts')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.actions .mcp')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.actions')).not.toBeNull();
    // Code mode's way into the command palette, with its key hint.
    expect(fixture.nativeElement.querySelector('.command')).not.toBeNull();

    fixture.componentRef.setInput('mode', 'bot');
    fixture.detectChanges();

    // Bot mode owns the window: compact, prompts, MCP, git and search have no
    // conversation of theirs to act on, so the whole group steps out — while the
    // mode row itself stays, as the way back.
    expect(fixture.nativeElement.querySelector('.actions')).toBeNull();
    expect(fixture.nativeElement.querySelector('.prompts')).toBeNull();
    expect(fixture.nativeElement.querySelector('.mcp')).toBeNull();
    expect(fixture.nativeElement.querySelector('.modes')).not.toBeNull();
    // The command centre follows its palette: that key is code-mode only, so the
    // box must not sit there advertising a line to an overlay bot mode cannot open.
    expect(fixture.nativeElement.querySelector('.command')).toBeNull();
  });
});
