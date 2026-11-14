import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { BotMcpServerInput } from '@morse/protocol';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { McpState } from '../../state/mcp-state';
import { BotMcpStep, parseEnvText, parseHeaderText } from './bot-mcp-step';

/**
 * The UI runtime's mock host. These tests spy on `McpState.inspect` for the
 * probe, so unlike the wizard's suite there is no message to script by hand.
 */
const transport = new MemoryHostTransport();

async function render(
  engineKind = 'pi',
  servers: BotMcpServerInput[] = [],
): Promise<{
  fixture: ComponentFixture<BotMcpStep>;
  host: HTMLElement;
  mcp: McpState;
  changes: ReturnType<typeof vi.fn>;
}> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [BotMcpStep],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(BotMcpStep);
  fixture.componentRef.setInput('servers', servers);
  fixture.componentRef.setInput('engineKind', engineKind);
  const changes = vi.fn();
  fixture.componentInstance.serversChange.subscribe(changes);
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    mcp: TestBed.inject(McpState),
    changes,
  };
}

function fill(host: HTMLElement, selector: string, value: string): void {
  const field = host.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

function choose(host: HTMLElement, selector: string, value: string): void {
  const field = host.querySelector(selector) as HTMLSelectElement;
  field.value = value;
  field.dispatchEvent(new Event('change'));
}

function button(host: HTMLElement, selector: string): HTMLButtonElement {
  const found = host.querySelector(selector) as HTMLButtonElement | null;
  if (found === null) {
    throw new Error(`no button matches ${selector}`);
  }
  return found;
}

function tick(fixture: ComponentFixture<BotMcpStep>): void {
  fixture.detectChanges();
}

/** Fill the always-visible form's stdio fields and submit it. */
function addStdio(fixture: ComponentFixture<BotMcpStep>, host: HTMLElement, name: string): void {
  fill(host, 'input[placeholder="filesystem"]', name);
  fill(host, 'input[placeholder="npx"]', 'npx');
  fill(host, 'input[placeholder="-y @modelcontextprotocol/server-filesystem ."]', '-y server .');
  tick(fixture);
  button(host, '.mcp-add').click();
  tick(fixture);
}

describe('BotMcpStep', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('adds a stdio server and emits the neutral shape', async () => {
    const { fixture, host, changes } = await render();

    addStdio(fixture, host, 'filesystem');

    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith([
      {
        name: 'filesystem',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'server', '.'],
        enabled: true,
      },
    ]);
  });

  it('adds an HTTP server with headers', async () => {
    const { fixture, host, changes } = await render();

    fill(host, 'input[placeholder="filesystem"]', 'web');
    choose(host, '.mcp-type', 'http');
    tick(fixture);
    fill(host, 'input[placeholder="https://example.com/mcp"]', 'https://example.com/mcp');
    fill(host, 'textarea[placeholder="Authorization: Bearer …"]', 'Authorization: Bearer x');
    tick(fixture);
    button(host, '.mcp-add').click();

    expect(changes).toHaveBeenCalledWith([
      {
        name: 'web',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        enabled: true,
      },
    ]);
  });

  it('ignores the other transport’s textarea when saving', async () => {
    const { fixture, host, changes } = await render();

    // Start on stdio, leave an unusable env line, then switch to HTTP: the
    // hidden field is not part of the entry and must not block the save.
    fill(host, 'input[placeholder="filesystem"]', 'web');
    fill(host, 'textarea[placeholder="ALLOWED_DIR=/tmp"]', 'NO_EQUALS');
    choose(host, '.mcp-type', 'http');
    tick(fixture);
    fill(host, 'input[placeholder="https://example.com/mcp"]', 'https://example.com/mcp');
    tick(fixture);
    button(host, '.mcp-add').click();

    expect(changes).toHaveBeenCalledWith([
      { name: 'web', type: 'http', url: 'https://example.com/mcp', enabled: true },
    ]);
  });

  it('refuses a duplicate or unusable name', async () => {
    const { fixture, host, changes } = await render();

    addStdio(fixture, host, 'filesystem');
    const saved = changes.mock.calls[0]?.[0] as BotMcpServerInput[];
    fixture.componentRef.setInput('servers', saved);
    tick(fixture);

    // The same name again is a config key collision, not a second server.
    fill(host, 'input[placeholder="filesystem"]', 'filesystem');
    fill(host, 'input[placeholder="npx"]', 'npx');
    tick(fixture);
    button(host, '.mcp-add').click();
    tick(fixture);
    expect(host.querySelector('.mcp-error')?.textContent).toContain('already');
    expect(changes).toHaveBeenCalledTimes(1);

    // A space is not part of an MCP config key.
    fill(host, 'input[placeholder="filesystem"]', 'has space');
    tick(fixture);
    button(host, '.mcp-add').click();
    tick(fixture);
    expect(host.querySelector('.mcp-error')?.textContent).toContain('letters');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('parses env values with equals signs and ignores blank lines', () => {
    expect(parseEnvText('A=1\n\nB=x=y\n')).toEqual({ values: { A: '1', B: 'x=y' } });
    expect(parseEnvText('NO_EQUALS')).toEqual({
      values: {},
      error: 'Each environment variable needs a KEY=value line.',
    });
  });

  it('parses headers with colons and duplicate keys last-wins', () => {
    expect(parseHeaderText('A: 1\nA: 2\nB: x:y')).toEqual({
      values: { A: '2', B: 'x:y' },
    });
  });

  it('edits an existing server and keeps cwd', async () => {
    const servers: BotMcpServerInput[] = [
      {
        name: 'filesystem',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'server', '.'],
        cwd: '/tmp',
        enabled: true,
      },
    ];
    const { fixture, host, changes } = await render('pi', servers);

    button(host, '.mcp-edit').click();
    tick(fixture);
    fill(host, 'input[placeholder="-y @modelcontextprotocol/server-filesystem ."]', '-y other .');
    tick(fixture);
    button(host, '.mcp-add').click();

    expect(changes).toHaveBeenCalledWith([
      {
        name: 'filesystem',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'other', '.'],
        cwd: '/tmp',
        enabled: true,
      },
    ]);
  });

  it('keeps an argument that contains a space when an edit only renames the server', async () => {
    const servers: BotMcpServerInput[] = [
      {
        name: 'rooted',
        type: 'stdio',
        command: 'npx',
        args: ['--root', '/home/me/my dir'],
        enabled: true,
      },
    ];
    const { fixture, host, changes } = await render('pi', servers);

    button(host, '.mcp-edit').click();
    tick(fixture);
    // Only the name changes: the args textarea is not touched, so its text is a
    // lossy rendering and must not be re-split into three arguments.
    fill(host, 'input[placeholder="filesystem"]', 'rooted-renamed');
    tick(fixture);
    button(host, '.mcp-add').click();

    expect(changes).toHaveBeenCalledWith([
      {
        name: 'rooted-renamed',
        type: 'stdio',
        command: 'npx',
        args: ['--root', '/home/me/my dir'],
        enabled: true,
      },
    ]);
  });

  it('splits the args text once the reader edits it', async () => {
    const servers: BotMcpServerInput[] = [
      {
        name: 'rooted',
        type: 'stdio',
        command: 'npx',
        args: ['--root', '/home/me/my dir'],
        enabled: true,
      },
    ];
    const { fixture, host, changes } = await render('pi', servers);

    button(host, '.mcp-edit').click();
    tick(fixture);
    fill(host, 'input[placeholder="-y @modelcontextprotocol/server-filesystem ."]', '--root /tmp --flag');
    tick(fixture);
    button(host, '.mcp-add').click();

    expect(changes).toHaveBeenCalledWith([
      {
        name: 'rooted',
        type: 'stdio',
        command: 'npx',
        args: ['--root', '/tmp', '--flag'],
        enabled: true,
      },
    ]);
  });

  it('removes a server', async () => {
    const web: BotMcpServerInput = {
      name: 'web',
      type: 'http',
      url: 'https://example.com/mcp',
      enabled: true,
    };
    const servers: BotMcpServerInput[] = [
      { name: 'filesystem', type: 'stdio', command: 'npx', enabled: true },
      web,
    ];
    const { fixture, host, changes } = await render('pi', servers);

    button(host, '.mcp-remove').click();

    expect(changes).toHaveBeenCalledWith([web]);
  });

  it('shows exposure for pi only', async () => {
    const pi = await render('pi');
    expect(pi.host.querySelector('.mcp-exposure')).not.toBeNull();
    expect(pi.host.textContent).toContain('Exposure');

    const opencode = await render('opencode');
    expect(opencode.host.querySelector('.mcp-exposure')).toBeNull();
    expect(opencode.host.textContent).not.toContain('Exposure');
  });

  it('tests the connection and shows the result', async () => {
    const { fixture, host, mcp } = await render();
    const inspect = vi.spyOn(mcp, 'inspect').mockResolvedValue({
      ok: true,
      tools: [{ name: 'read_file' }],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      durationMs: 3,
    });

    fill(host, 'input[placeholder="filesystem"]', 'filesystem');
    fill(host, 'input[placeholder="npx"]', 'npx');
    fill(host, 'input[placeholder="-y @modelcontextprotocol/server-filesystem ."]', '-y server .');
    tick(fixture);
    button(host, '.mcp-test').click();
    await fixture.whenStable();
    tick(fixture);

    // The probe runs in the host's own workspace, not a bot directory that may
    // not exist yet: the second argument is deliberately empty.
    expect(inspect).toHaveBeenCalledWith(
      {
        name: 'filesystem',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'server', '.'],
        enabled: true,
      },
      '',
    );
    expect(host.textContent).toContain('1 tool');
  });

  it("shows a failed probe's message", async () => {
    const { fixture, host, mcp } = await render();
    vi.spyOn(mcp, 'inspect').mockResolvedValue({
      ok: false,
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      durationMs: 1,
      error: { kind: 'spawn', message: 'ENOENT' },
    });

    fill(host, 'input[placeholder="filesystem"]', 'filesystem');
    fill(host, 'input[placeholder="npx"]', 'npx');
    tick(fixture);
    button(host, '.mcp-test').click();
    await fixture.whenStable();
    tick(fixture);

    expect(host.textContent).toContain('ENOENT');
  });
});
