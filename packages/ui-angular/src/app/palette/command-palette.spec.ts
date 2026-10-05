import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  PROTOCOL_VERSION,
  type ClientToHostMessage,
  type HostCapabilities,
  type SessionViewState,
} from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../app';
import { ShellState } from '../core/shell-state';
import { MORSE_TRANSPORT } from '../core/transport.token';
import { WorkspaceTabs } from '../core/workspace-tabs';

const FILES = ['README.md', 'packages/core/src/domain.ts', 'packages/ui-angular/src/app/app.ts'];

const CAPABILITIES: HostCapabilities = {
  hostKind: 'server',
  scope: 'global',
  editorContext: false,
  nativeDialogs: false,
  insertIntoEditor: false,
  revealFile: false,
  filePicker: true,
  // The browser host's shape: a tab strip, an Explorer and a file preview.
  filePreview: true,
};

const STATE: SessionViewState = {
  sessionId: 'session-1',
  sessionTitle: 'Sidebar overhaul',
  workspace: { cwd: '/work/morse', name: 'morse' },
  model: { provider: 'mock', id: 'mock-1', name: 'Mock Model', contextWindow: 128_000 },
  thinkingLevel: 'low',
  availableModels: [
    { provider: 'mock', id: 'mock-1', name: 'Mock Model', contextWindow: 128_000 },
    { provider: 'other', id: 'x-1', name: 'Other Model' },
  ],
  availableThinkingLevels: ['off', 'low', 'high'],
  availableCommands: [],
  streaming: false,
  busy: false,
  agentReady: true,
  agentStarting: false,
};

/**
 * A global host with the browser-only pieces the palette reaches into: a tab
 * strip, a file list and a preview. `sent` records the wire so a test can prove a
 * row ran the same action a button would.
 */
class PaletteTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  readonly sent: ClientToHostMessage[] = [];

  connect(): void {
    this.emitStatus('open');
  }

  dispose(): void {
    this.emitStatus('closed');
  }

  send(message: ClientToHostMessage): void {
    this.sent.push(message);
    switch (message.type) {
      case 'client/ready':
        this.emitMessage({ type: 'transcript/replace', payload: { items: [] } });
        this.emitMessage({
          type: 'project/list',
          payload: {
            projects: [
              { path: '/work/morse', name: 'morse', sessionCount: 2, lastUsedAt: 2 },
              { path: '/work/other', name: 'other', sessionCount: 1, lastUsedAt: 1 },
            ],
          },
        });
        this.emitMessage({
          type: 'session/list',
          payload: {
            sessions: [
              { id: 'session-1', title: 'Sidebar overhaul', cwd: '/work/morse', updatedAt: 2, messageCount: 3 },
              { id: 'session-2', title: 'Greeting', cwd: '/work/morse', updatedAt: 1, messageCount: 1 },
            ],
          },
        });
        this.emitMessage({
          type: 'host/ready',
          payload: { protocolVersion: PROTOCOL_VERSION, capabilities: CAPABILITIES, state: STATE },
        });
        return;
      case 'host/command':
        if (message.payload.command === 'listFiles' && message.payload.requestId) {
          this.emitMessage({
            type: 'host/command/result',
            payload: { requestId: message.payload.requestId, ok: true, data: { files: FILES } },
          });
        }
        return;
      default:
        return;
    }
  }
}

async function render(): Promise<{ fixture: ComponentFixture<App>; transport: PaletteTransport }> {
  const transport = new PaletteTransport();
  await TestBed.configureTestingModule({
    imports: [App],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  return { fixture, transport };
}

function open(fixture: ComponentFixture<App>): void {
  TestBed.inject(ShellState).openPalette();
  fixture.detectChanges();
}

function search(fixture: ComponentFixture<App>, text: string): void {
  const input = fixture.nativeElement.querySelector('morse-command-palette input') as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

function titles(fixture: ComponentFixture<App>): string[] {
  return [...fixture.nativeElement.querySelectorAll('morse-command-palette .group-title')].map(
    (title) => (title.textContent ?? '').trim(),
  );
}

function labels(fixture: ComponentFixture<App>): string[] {
  return [...fixture.nativeElement.querySelectorAll('morse-command-palette .row .label')].map(
    (label) => (label.textContent ?? '').trim(),
  );
}

function press(key: string, { ctrl = false, alt = false } = {}): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, ctrlKey: ctrl, altKey: alt, bubbles: true, cancelable: true }),
  );
}

/** Lets the file list's promise resolve, then lets Angular redraw. */
async function settle(fixture: ComponentFixture<App>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
}

afterEach(() => {
  localStorage.clear();
  TestBed.resetTestingModule();
});

describe('CommandPalette', () => {
  it('opens on its key, and closes again on the same key', async () => {
    const { fixture } = await render();
    expect(fixture.nativeElement.querySelector('morse-command-palette')).toBeNull();

    press('k', { ctrl: true, alt: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-command-palette')).not.toBeNull();

    press('k', { ctrl: true, alt: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-command-palette')).toBeNull();
  });

  it('lists one section per source, in a fixed order', async () => {
    const { fixture } = await render();
    open(fixture);
    await settle(fixture);

    expect(titles(fixture)).toEqual([
      'Commands',
      'Open tabs',
      'Sessions',
      'Projects',
      'Files',
      'Models',
      'Thinking',
    ]);
  });

  it('locks to one source with a leading character, and says so when nothing is there', async () => {
    const { fixture } = await render();
    open(fixture);
    await settle(fixture);

    search(fixture, '#');
    expect(titles(fixture)).toEqual(['Sessions']);
    // An empty query ranks by label length, so the shorter title comes first.
    expect(labels(fixture)).toEqual(['Greeting', 'Sidebar overhaul']);

    search(fixture, '@ app.ts');
    expect(titles(fixture)).toEqual(['Files']);

    search(fixture, ': morse');
    expect(titles(fixture)).toEqual(['Projects']);
    expect(labels(fixture)).toEqual(['morse']);

    // A locked source with no match is empty, not a silent fall back to everything.
    search(fixture, ': nope');
    expect(labels(fixture)).toEqual([]);
    expect(fixture.nativeElement.querySelector('morse-command-palette .empty')).not.toBeNull();
  });

  it('runs a command through the owner that bound its key, then closes', async () => {
    const { fixture } = await render();
    const shell = TestBed.inject(ShellState);
    open(fixture);

    search(fixture, '> this list');
    expect(labels(fixture)).toEqual(['This list']);

    press('Enter');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('morse-command-palette')).toBeNull();
    expect(shell.shortcutsOpen()).toBe(true);
  });

  it('switches to a session, and never asks the host to activate a draft', async () => {
    const { fixture, transport } = await render();
    const tabs = TestBed.inject(WorkspaceTabs);
    open(fixture);

    search(fixture, '# greeting');
    press('Enter');
    fixture.detectChanges();
    expect(
      transport.sent.some(
        (message) => message.type === 'session/activate' && message.payload.sessionId === 'session-2',
      ),
    ).toBe(true);

    // A draft is a placeholder, not a pi session named "draft": selecting its row
    // must leave the host alone. The row is found by its `draft` badge, because a
    // flat query also matches the "New session" command by name.
    tabs.openDraft('/work/morse');
    const activations = transport.sent.filter((message) => message.type === 'session/activate').length;
    open(fixture);
    search(fixture, 'new session');
    const draftRow = [...fixture.nativeElement.querySelectorAll('morse-command-palette .row')].find(
      (row: Element) => row.querySelector('.badge')?.textContent?.trim() === 'draft',
    ) as HTMLElement | undefined;
    expect(draftRow).toBeDefined();
    draftRow!.click();
    fixture.detectChanges();
    expect(transport.sent.filter((message) => message.type === 'session/activate')).toHaveLength(
      activations,
    );
  });

  it('picks a model and a thinking level', async () => {
    const { fixture, transport } = await render();
    open(fixture);

    search(fixture, 'other model');
    expect(labels(fixture)).toContain('Other Model');
    press('Enter');
    fixture.detectChanges();
    expect(transport.sent).toContainEqual({
      type: 'model/set',
      payload: { provider: 'other', id: 'x-1' },
    });

    open(fixture);
    search(fixture, 'high');
    expect(labels(fixture)).toEqual(['high']);
    press('Enter');
    fixture.detectChanges();
    expect(transport.sent).toContainEqual({ type: 'thinking/set', payload: { level: 'high' } });
  });

  it('narrows the sidebar to a project, and back to all of them', async () => {
    const { fixture } = await render();
    const shell = TestBed.inject(ShellState);
    open(fixture);

    search(fixture, ': other');
    press('Enter');
    fixture.detectChanges();
    expect(shell.projectFilterPath()).toBe('/work/other');

    open(fixture);
    search(fixture, ': all');
    press('Enter');
    fixture.detectChanges();
    expect(shell.projectFilterPath()).toBe('');
  });

  it('finds a file and opens it in the preview', async () => {
    const { fixture } = await render();
    open(fixture);
    await settle(fixture);

    search(fixture, '@ app.ts');
    expect(labels(fixture)).toEqual(['app.ts']);
    press('Enter');
    fixture.detectChanges();

    const tab = TestBed.inject(WorkspaceTabs).activeTab();
    expect(tab?.kind).toBe('file');
    expect(tab?.kind === 'file' ? tab.path : '').toBe('packages/ui-angular/src/app/app.ts');
  });

  it('walks the sections with Tab and moves the highlight with the arrows', async () => {
    const { fixture } = await render();
    open(fixture);
    await settle(fixture);

    const active = (): string =>
      fixture.nativeElement.querySelector('morse-command-palette .row.active .label').textContent.trim();

    // Home is the first command; ArrowDown walks inside its section…
    press('Home');
    fixture.detectChanges();
    const first = active();

    press('ArrowDown');
    fixture.detectChanges();
    const second = active();
    expect(second).not.toBe(first);

    // …and Tab jumps to the first row of the next source.
    press('Tab');
    fixture.detectChanges();
    expect(active()).not.toBe(second);
  });

  it('closes on Escape without running anything', async () => {
    const { fixture, transport } = await render();
    open(fixture);

    press('Escape');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('morse-command-palette')).toBeNull();
    expect(transport.sent.filter((message) => message.type === 'model/set')).toHaveLength(0);
  });
});
