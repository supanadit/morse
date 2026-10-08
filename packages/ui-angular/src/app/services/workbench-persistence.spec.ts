import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentStore } from '../state/attachments';
import { ComposerDrafts } from '../state/composer-drafts';
import { MorseService } from '../host/morse.service';
import { PanelState } from '../state/panel-state';
import { TerminalStore } from '../state/terminal-store';
import { WorkspaceTabs } from '../state/workspace-tabs';
import { DRAFTS_VERSION, WorkbenchPersistence, WORKBENCH_VERSION } from './workbench-persistence';

interface ViewState {
  sessionId?: string;
  sessionTitle?: string;
  workspace: { cwd: string; name: string };
}

/** A saved layout with one session tab and one file tab, the file in front. */
function storedLayout(overrides: Record<string, unknown> = {}) {
  return {
    version: WORKBENCH_VERSION,
    data: {
      tabs: {
        tabs: [
          { kind: 'session', id: 's1', title: 'One', cwd: '/repo' },
          { kind: 'file', id: 'file:a.ts', path: 'a.ts', title: 'a.ts', language: 'typescript' },
        ],
        activeId: 'file:a.ts',
      },
      terminals: {
        panes: [
          { id: 'term-2', owner: 's1', group: 'term-2', title: 'Server', fallbackTitle: 'Terminal 2' },
        ],
        activeByOwner: { s1: 'term-2' },
        activePaneByGroup: { 'term-2': 'term-2' },
        sizesByGroup: { 'term-2': [1] },
      },
      panel: { view: 'terminal', expanded: true, full: false, height: 300 },
      ...overrides,
    },
  };
}

function setup(
  stored: unknown = null,
  capabilities: Record<string, unknown> = { workbench: true },
  storedDrafts: unknown = null,
) {
  const connection = signal<'connecting' | 'ready'>('connecting');
  const caps = signal<Record<string, unknown> | undefined>(undefined);
  const state = signal<ViewState>({ workspace: { cwd: '/repo', name: 'repo' } });
  const saved: { version: number; data: unknown }[] = [];
  const savedDrafts: { version: number; data: unknown }[] = [];
  const fake = {
    connection: connection as Signal<'connecting' | 'ready'>,
    capabilities: caps as Signal<Record<string, unknown> | undefined>,
    state,
    activateSession: vi.fn(),
    requestHostCommand: vi.fn((command: string, args?: Record<string, unknown>) => {
      if (command === 'readWorkbench') {
        return Promise.resolve(stored);
      }
      if (command === 'saveWorkbench') {
        saved.push(args as { version: number; data: unknown });
        return Promise.resolve({ ok: true });
      }
      if (command === 'readDrafts') {
        return Promise.resolve(storedDrafts);
      }
      if (command === 'saveDrafts') {
        savedDrafts.push(args as { version: number; data: unknown });
        return Promise.resolve({ ok: true });
      }
      // A file preview the restore may ask for.
      return Promise.resolve({ path: 'a.ts', content: 'const x = 1;\n', size: 13, truncated: false, binary: false });
    }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: MorseService, useValue: fake }] });
  const persistence = TestBed.inject(WorkbenchPersistence);
  caps.set(capabilities);
  return { persistence, fake, connection, caps, state, saved, savedDrafts };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WorkbenchPersistence', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('restores the tabs, panel and terminals once the host is ready', async () => {
    const { fake, connection } = setup(storedLayout());
    const tabs = TestBed.inject(WorkspaceTabs);
    const panel = TestBed.inject(PanelState);
    const terminals = TestBed.inject(TerminalStore);

    connection.set('ready');
    TestBed.tick();
    await flush();
    await flush();

    expect(fake.requestHostCommand).toHaveBeenCalledWith('readWorkbench');
    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1', 'file:a.ts']);
    expect(tabs.activeId()).toBe('file:a.ts');
    expect(panel.activeView()).toBe('terminal');
    expect(panel.expanded()).toBe(true);
    expect(panel.height()).toBe(300);
    expect(terminals.terminals().map((pane) => pane.id)).toEqual(['term-2']);
    // The pane carries its session's directory, so the restored shell opens there.
    expect(terminals.terminals()[0]!.cwd).toBe('/repo');
  });

  it("keeps a pane's own directory (where the shell `cd`'d) over the session root", async () => {
    const layout = storedLayout();
    (layout.data.terminals as { panes: Array<Record<string, unknown>> }).panes[0]!['cwd'] =
      '/repo/packages/api';
    const { connection } = setup(layout);
    const terminals = TestBed.inject(TerminalStore);

    connection.set('ready');
    TestBed.tick();
    await flush();
    await flush();

    // The shell reported `/repo/packages/api` with OSC 7, so the restored shell
    // reopens where the reader `cd`'d, not at the session's project root.
    expect(terminals.terminals()[0]!.cwd).toBe('/repo/packages/api');
  });

  it('asks the host for the session the layout left in front', async () => {
    const layout = storedLayout();
    (layout.data.tabs as { activeId?: string }).activeId = 's1';
    const { fake, connection } = setup(layout);

    connection.set('ready');
    TestBed.tick();
    await flush();
    await flush();

    expect(fake.activateSession).toHaveBeenCalledWith('s1', '/repo');
  });

  it('does nothing where the host does not promise a workbench', async () => {
    const { fake, connection, caps } = setup(storedLayout(), { workbench: false });
    const tabs = TestBed.inject(WorkspaceTabs);

    connection.set('ready');
    TestBed.tick();
    await flush();

    expect(fake.requestHostCommand).not.toHaveBeenCalled();
    expect(tabs.tabs()).toEqual([]);
    void caps;
  });

  it('ignores a layout written by another version', async () => {
    const stale = { version: WORKBENCH_VERSION + 1, data: storedLayout().data };
    const { connection } = setup(stale);
    const tabs = TestBed.inject(WorkspaceTabs);

    connection.set('ready');
    TestBed.tick();
    await flush();
    await flush();

    expect(tabs.tabs()).toEqual([]);
  });

  it('writes the layout back when a tab changes', async () => {
    const { fake, connection, saved } = setup(storedLayout());
    const tabs = TestBed.inject(WorkspaceTabs);

    connection.set('ready');
    TestBed.tick();
    await flush();
    await flush();

    tabs.focusSession({ id: 's2', title: 'Two', cwd: '/other' });
    TestBed.tick();
    // The debounce is short but real; give it its window.
    await new Promise((resolve) => setTimeout(resolve, 450));

    const write = saved.at(-1);
    expect(write?.version).toBe(WORKBENCH_VERSION);
    expect((write?.data as { tabs: { activeId?: string } }).tabs.activeId).toBe('s2');
    expect(fake.requestHostCommand).toHaveBeenCalledWith('saveWorkbench', expect.anything());
  });

  it('does not write the layout it just read back', async () => {
    const { connection, saved } = setup(storedLayout());

    connection.set('ready');
    TestBed.tick();
    await flush();
    await flush();
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(saved).toEqual([]);
  });

  it('restores each tab draft, words and attachments, once the host is ready', async () => {
    const storedDrafts = {
      version: DRAFTS_VERSION,
      data: {
        texts: { s1: 'a long prompt', s2: 'another tab' },
        attachments: {
          s1: {
            images: [],
            pins: [{ id: 'pin-1', path: 'a.ts', startLine: 4 }],
            mentions: ['b.ts'],
          },
        },
      },
    };
    const { fake, connection } = setup(storedLayout(), { workbench: true }, storedDrafts);
    const drafts = TestBed.inject(ComposerDrafts);
    const attachments = TestBed.inject(AttachmentStore);

    connection.set('ready');
    TestBed.tick();
    await flush();
    await flush();

    expect(fake.requestHostCommand).toHaveBeenCalledWith('readDrafts');
    drafts.use('s1');
    expect(drafts.text()).toBe('a long prompt');
    expect(attachments.mentions()).toEqual(['b.ts']);
    expect(attachments.pins()).toEqual([{ id: 'pin-1', path: 'a.ts', startLine: 4 }]);
    // A second tab stays isolated from the first.
    drafts.use('s2');
    expect(drafts.text()).toBe('another tab');
    expect(attachments.mentions()).toEqual([]);
  });

  it('writes the drafts back when the reader types', async () => {
    const { connection, savedDrafts } = setup(storedLayout());

    connection.set('ready');
    TestBed.tick();
    await flush();
    await flush();

    const drafts = TestBed.inject(ComposerDrafts);
    drafts.use('s1');
    drafts.setText('typed after the load');
    TestBed.tick();
    // The draft debounce is longer than the layout's; give it its window.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const write = savedDrafts.at(-1);
    expect(write?.version).toBe(DRAFTS_VERSION);
    expect((write?.data as { texts: Record<string, string> }).texts['s1']).toBe(
      'typed after the load',
    );
  });

  it('does not write the drafts it just read back', async () => {
    const storedDrafts = {
      version: DRAFTS_VERSION,
      data: { texts: { s1: 'kept' }, attachments: {} },
    };
    const { connection, savedDrafts } = setup(storedLayout(), { workbench: true }, storedDrafts);

    connection.set('ready');
    TestBed.tick();
    await flush();
    await flush();
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(savedDrafts).toEqual([]);
  });
});
