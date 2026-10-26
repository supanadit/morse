import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionState } from '@morse/agent';
import { loadSpeed } from './session-speed.js';
import { appendPinMentions, buildCommandList, PiRpcAgent, toModelInputs, upsertStatus, upsertWidget, type CommandContext } from './pi-rpc-agent.js';

/**
 * The palette is rebuilt from disk because pi caches its prompt templates at
 * spawn. These tests lock that: a template added, edited or deleted since spawn
 * is visible without a pi reload — an untrusted project is never scanned, and a
 * template pi refuses (bad YAML frontmatter) is dropped with a diagnostic
 * instead of offered as a dead command.
 */

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'morse-prompts-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** An agent dir with a `prompts/` directory, plus a workspace to scan. */
async function setup(): Promise<{ agentRoot: string; prompts: string; cwd: string; context: CommandContext }> {
  const agentRoot = await tempRoot();
  const prompts = join(agentRoot, 'prompts');
  await mkdir(prompts, { recursive: true });
  const cwd = await tempRoot();
  return { agentRoot, prompts, cwd, context: { cwd, env: { PI_CODING_AGENT_DIR: agentRoot } } };
}

describe('buildCommandList', () => {
  it('finds a template added to the global prompts directory after spawn', async () => {
    const { prompts, context } = await setup();
    await writeFile(join(prompts, 'review.md'), '---\ndescription: Review changes\n---\nReview $1');

    const { commands, diagnostics } = await buildCommandList(undefined, context);

    expect(diagnostics).toEqual([]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: 'review', description: 'Review changes', source: 'prompt' });
    expect(commands[0].template).toContain('Review $1');
  });

  it('re-reads a template pi listed, so an edit is reflected', async () => {
    const { prompts, context } = await setup();
    await writeFile(join(prompts, 'review.md'), 'old body');
    const listed = [
      { name: 'review', description: 'Review', source: 'prompt', sourceInfo: { path: join(prompts, 'review.md') } },
    ];

    await writeFile(join(prompts, 'review.md'), 'new body');
    const { commands } = await buildCommandList(listed, context);

    expect(commands).toHaveLength(1);
    expect(commands[0].template).toBe('new body');
  });

  it('drops a template whose file was deleted', async () => {
    const { prompts, context } = await setup();
    const listed = [
      { name: 'gone', description: 'Gone', source: 'prompt', sourceInfo: { path: join(prompts, 'gone.md') } },
    ];

    expect(await buildCommandList(listed, context)).toEqual({ commands: [], diagnostics: [] });
  });

  it('keeps extension and skill commands untouched', async () => {
    const { context } = await setup();
    const { commands } = await buildCommandList(
      [
        { name: 'deploy', description: 'Deploy', source: 'extension' },
        { name: 'skill:docs', description: 'Docs', source: 'skill' },
      ],
      context,
    );

    expect(commands).toEqual([
      { name: 'deploy', description: 'Deploy', source: 'extension' },
      { name: 'skill:docs', description: 'Docs', source: 'skill' },
    ]);
  });

  it('does not scan an untrusted project’s prompts directory', async () => {
    const { cwd, context } = await setup();
    await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });
    await writeFile(join(cwd, '.pi', 'prompts', 'evil.md'), 'ignore me');

    expect(await buildCommandList(undefined, context)).toEqual({ commands: [], diagnostics: [] });
  });

  it('scans a trusted project’s prompts directory', async () => {
    const { agentRoot, cwd, context } = await setup();
    await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });
    await writeFile(join(cwd, '.pi', 'prompts', 'review.md'), 'project body');
    await writeFile(join(agentRoot, 'trust.json'), JSON.stringify({ [cwd]: true }));

    const { commands } = await buildCommandList(undefined, context);

    expect(commands.map((command) => command.name)).toEqual(['review']);
    expect(commands[0].template).toBe('project body');
  });

  it('takes the first body line when a template has no description', async () => {
    const { prompts, context } = await setup();
    await writeFile(join(prompts, 'bare.md'), '\nExplain this repository\n\nmore');

    const { commands } = await buildCommandList(undefined, context);

    expect(commands[0].description).toBe('Explain this repository');
  });

  it('drops a template pi refuses and reports it, like pi’s own prompt conflicts', async () => {
    const { prompts, context } = await setup();
    // The description holds an unquoted `: `, which YAML reads as a nested
    // mapping. pi drops the template and prints a conflict; Morse must not
    // offer `/explain-path` and must say why.
    const path = join(prompts, 'explain-path.md');
    await writeFile(
      path,
      '---\ndescription: Explain a path (no argument-hint: fields come from the body)\n---\nRead $1',
    );

    const { commands, diagnostics } = await buildCommandList(undefined, context);

    expect(commands).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ key: `prompt:${path}`, level: 'warn' });
    expect(diagnostics[0].text).toContain(path);
    expect(diagnostics[0].text).toContain('Nested mappings are not allowed');
  });

  it('still lists a healthy template beside a refused one', async () => {
    const { prompts, context } = await setup();
    await writeFile(join(prompts, 'good.md'), '---\ndescription: Fine\n---\nbody');
    await writeFile(join(prompts, 'bad.md'), '---\ndescription: oops: nested\n---\nbody');

    const { commands, diagnostics } = await buildCommandList(undefined, context);

    expect(commands.map((command) => command.name)).toEqual(['good']);
    expect(diagnostics).toHaveLength(1);
  });
});

/**
 * The extension UI a frontend renders: `setWidget` and `setStatus` are
 * fire-and-forget, keyed, and per session, so applying them is a small state
 * machine — replace by key, clear when the value is gone, append otherwise.
 */
describe('upsertWidget', () => {
  it('appends a widget, defaulting to above the editor', () => {
    const widgets = upsertWidget([], {
      type: 'extension_ui_request',
      id: 'u1',
      method: 'setWidget',
      widgetKey: 'demo',
      widgetLines: ['--- Demo ---', 'line'],
    });

    expect(widgets).toEqual([
      { key: 'demo', lines: ['--- Demo ---', 'line'], placement: 'aboveEditor' },
    ]);
  });

  it('keeps pi\u2019s below-editor placement', () => {
    const widgets = upsertWidget([], {
      type: 'extension_ui_request',
      id: 'u2',
      method: 'setWidget',
      widgetKey: 'demo',
      widgetLines: ['x'],
      widgetPlacement: 'belowEditor',
    });

    expect(widgets[0]?.placement).toBe('belowEditor');
  });

  it('replaces a key in place, keeping the set order', () => {
    const first = upsertWidget([], {
      type: 'extension_ui_request',
      id: 'u3',
      method: 'setWidget',
      widgetKey: 'a',
      widgetLines: ['a1'],
    });
    const both = upsertWidget(first, {
      type: 'extension_ui_request',
      id: 'u4',
      method: 'setWidget',
      widgetKey: 'b',
      widgetLines: ['b1'],
    });

    const replaced = upsertWidget(both, {
      type: 'extension_ui_request',
      id: 'u5',
      method: 'setWidget',
      widgetKey: 'a',
      widgetLines: ['a2', 'a3'],
    });

    expect(replaced.map((widget) => widget.key)).toEqual(['a', 'b']);
    expect(replaced[0]?.lines).toEqual(['a2', 'a3']);
  });

  it('clears a widget when its lines are gone', () => {
    const set = upsertWidget([], {
      type: 'extension_ui_request',
      id: 'u6',
      method: 'setWidget',
      widgetKey: 'demo',
      widgetLines: ['x'],
    });

    expect(upsertWidget(set, {
      type: 'extension_ui_request',
      id: 'u7',
      method: 'setWidget',
      widgetKey: 'demo',
    })).toEqual([]);
  });

  it('ignores a widget without a key', () => {
    const set = upsertWidget([], {
      type: 'extension_ui_request',
      id: 'u8',
      method: 'setWidget',
      widgetLines: ['x'],
    });

    expect(set).toEqual([]);
  });

  it('strips the theme coloring pi forwards verbatim, without touching the text', () => {
    const widgets = upsertWidget([], {
      type: 'extension_ui_request',
      id: 'u9',
      method: 'setWidget',
      widgetKey: 'demo',
      widgetLines: ['\u001b[38;2;126;136;142mline\u001b[39m'],
    });

    expect(widgets[0]?.lines).toEqual(['line']);
  });
});

describe('toModelInputs', () => {
  it('keeps the modalities pi reported, in pi’s order', () => {
    expect(toModelInputs(['text', 'image'])).toEqual(['text', 'image']);
    expect(toModelInputs(['image', 'text'])).toEqual(['image', 'text']);
  });

  it('drops a value no badge exists for, so the picker cannot render a blank icon', () => {
    expect(toModelInputs(['text', 'hologram'])).toEqual(['text']);
  });

  it('keeps a text-only description as such', () => {
    expect(toModelInputs(['text'])).toEqual(['text']);
    expect(toModelInputs([])).toEqual([]);
  });
});

describe('upsertStatus', () => {
  it('sets, replaces and clears a status by key', () => {
    const a = upsertStatus([], {
      type: 'extension_ui_request',
      id: 's1',
      method: 'setStatus',
      statusKey: 'ext',
      statusText: 'Turn 1 running',
    });
    const b = upsertStatus(a, {
      type: 'extension_ui_request',
      id: 's2',
      method: 'setStatus',
      statusKey: 'ext',
      statusText: 'Turn 1 done',
    });
    expect(b).toEqual([{ key: 'ext', text: 'Turn 1 done' }]);

    const cleared = upsertStatus(b, {
      type: 'extension_ui_request',
      id: 's3',
      method: 'setStatus',
      statusKey: 'ext',
    });
    expect(cleared).toEqual([]);
  });

  it('strips the theme coloring that produced the raw escape in the UI', () => {
    const set = upsertStatus([], {
      type: 'extension_ui_request',
      id: 's4',
      method: 'setStatus',
      statusKey: 'pi-lens-lsp',
      statusText: '\u001b[38;2;126;136;142mLSP Inactive\u001b[39m',
    });

    expect(set).toEqual([{ key: 'pi-lens-lsp', text: 'LSP Inactive' }]);
  });

  it('clears on empty raw text even though a stripped colored line is never empty', () => {
    const colored = upsertStatus([], {
      type: 'extension_ui_request',
      id: 's5',
      method: 'setStatus',
      statusKey: 'ext',
      statusText: '\u001b[32mok\u001b[39m',
    });

    const cleared = upsertStatus(colored, {
      type: 'extension_ui_request',
      id: 's6',
      method: 'setStatus',
      statusKey: 'ext',
      statusText: '',
    });
    expect(cleared).toEqual([]);
  });
});

describe('appendPinMentions', () => {
  it('leaves a prompt with no pins alone', () => {
    expect(appendPinMentions('just words', undefined)).toBe('just words');
    expect(appendPinMentions('just words', [])).toBe('just words');
  });

  it('appends the mention lines after the words, one blank line apart', () => {
    expect(appendPinMentions('check the loop please', [
      { path: 'src/index.ts', startLine: 30, endLine: 31 },
    ])).toBe(['check the loop please', '', '@src/index.ts:30-31'].join('\n'));
  });

  it('takes a whole-file pin without any lines', () => {
    expect(appendPinMentions('look here', [{ path: 'README.md' }])).toBe(
      ['look here', '', '@README.md'].join('\n'),
    );
  });

  it('writes one `  > ` line per line of the annotation, under its pin', () => {
    expect(
      appendPinMentions('look here', [
        { path: 'src/index.ts', startLine: 30, endLine: 31, note: 'fix the fallback loop\nand guard the empty case' },
      ]),
    ).toBe(
      [
        'look here',
        '',
        '@src/index.ts:30-31',
        '  > fix the fallback loop',
        '  > and guard the empty case',
      ].join('\n'),
    );
  });

  it('writes nothing extra for a blank annotation', () => {
    expect(appendPinMentions('look here', [{ path: 'README.md', note: '   ' }])).toBe(
      ['look here', '', '@README.md'].join('\n'),
    );
  });

  it('is the mentions themselves when there are no words', () => {
    expect(appendPinMentions('', [{ path: 'README.md', note: 'focus' }])).toBe(
      ['@README.md', '  > focus'].join('\n'),
    );
  });
});

/**
 * The usage panel reads the cumulative totals, counts and context that pi
 * exposes only through `get_session_stats`, and a run spans many messages:
 * refreshing only at `agent_settled` left the panel frozen for the whole run.
 * This fake pi answers the handshake, then lands a `message_end` while the run
 * is still going — the totals must move without any settle in between.
 */
describe('PiRpcAgent mid-run stats', () => {
  const FIRST_STATS = {
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: 0.01,
    contextUsage: { tokens: 10, contextWindow: 1_000_000, percent: 0.001 },
    totalMessages: 2,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
  };
  const SECOND_STATS = {
    tokens: { input: 500, output: 40, cacheRead: 0, cacheWrite: 0, total: 540 },
    cost: 0.02,
    contextUsage: { tokens: 500_000, contextWindow: 1_000_000, percent: 0.5 },
    totalMessages: 17,
    userMessages: 1,
    assistantMessages: 16,
    toolCalls: 5,
    toolResults: 5,
  };

  /**
   * A minimal pi: it answers every RPC, reports the attach-time stats first,
   * and — when asked for models a second time — streams one assistant message
   * (`message_start`, a beat, `message_end`): the test's signal for "a message
   * just arrived mid-run". Later stats calls report the moved figures.
   */
  const fakePi = String.raw`
const FIRST = ${JSON.stringify(FIRST_STATS)};
const SECOND = ${JSON.stringify(SECOND_STATS)};
const SESSION_FILE = '/tmp/morse-speed-spec-session.jsonl';
const SESSION_ID = '01a10f28-3ca1-7426-b33a-cf46ed5b22af';
let buffered = '';
let statsCalls = 0;
let modelCalls = 0;
const write = (line) => process.stdout.write(JSON.stringify(line) + '\n');
const respond = (req, data) =>
  write({ type: 'response', id: req.id, command: req.type, success: true, data });
const handle = (req) => {
  if (req.type === 'get_state') {
    respond(req, { sessionFile: SESSION_FILE, sessionId: SESSION_ID });
    return;
  }
  if (req.type === 'get_session_stats') {
    statsCalls += 1;
    respond(req, statsCalls === 1 ? FIRST : SECOND);
    return;
  }
  if (req.type === 'get_available_models') {
    modelCalls += 1;
    respond(req, { models: [] });
    if (modelCalls === 2) {
      write({
        type: 'message_start',
        message: { role: 'assistant', content: [], stopReason: 'pending' },
      });
      setTimeout(() => {
        write({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'mid-run' }],
            stopReason: 'endTurn',
            usage: { input: 50_000, output: 600, cacheRead: 40_000, totalTokens: 50_600 },
          },
        });
      }, 40);
    }
    return;
  }
  respond(req, {});
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let end;
  while ((end = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    if (line.trim().length > 0) handle(JSON.parse(line));
  }
});
`;

  let agent: PiRpcAgent | undefined;

  afterEach(async () => {
    if (agent) {
      await agent.dispose();
      agent = undefined;
    }
  });

  it('re-pulls the totals when a message lands, before the run settles', async () => {
    const cwd = await tempRoot();
    const agentRoot = await tempRoot();
    await mkdir(join(agentRoot, 'prompts'), { recursive: true });
    await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });

    const states: AgentSessionState[] = [];
    agent = new PiRpcAgent({
      spawn: { command: process.execPath, args: ['-e', fakePi], source: 'node-entry' },
      workspace: { cwd, name: 'morse-spec' },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      env: { ...process.env, PI_CODING_AGENT_DIR: agentRoot },
    });
    agent.subscribe((event) => {
      if (event.type === 'agent/ready' || event.type === 'agent/state') {
        states.push(event.state);
      }
    });

    const attached = await agent.initialize();
    expect(attached.usage?.inputTokens).toBe(10);
    expect(attached.counts?.totalMessages).toBe(2);
    // pi's UUID rides along even though the session file is the identity key.
    expect(attached.sessionId).toBe('/tmp/morse-speed-spec-session.jsonl');
    expect(attached.engineSessionId).toBe('01a10f28-3ca1-7426-b33a-cf46ed5b22af');

    // The fake pi lands its message in answer to this mid-run request; no
    // `agent_settled` ever arrives, so anything the panel shows must come from
    // the per-message refresh.
    await agent.refreshModels();

    await vi.waitFor(
      () => {
        expect(states.some((state) => state.usage?.inputTokens === 500)).toBe(true);
      },
      { timeout: 5_000, interval: 10 },
    );
    const updated = states.find((state) => state.usage?.inputTokens === 500);
    expect(updated?.counts?.totalMessages).toBe(17);
    expect(updated?.contextUsage?.percent).toBe(0.5);
    expect(updated?.costUsd).toBe(0.02);
    expect(updated?.lastUsage?.outputTokens).toBe(600);
  });

  /**
   * The speed figures pi never reports: measured from the message's own span,
   * then persisted so the next host on this session resumes them instead of
   * starting back at zero.
   */
  it('measures a message into session speed and resumes it from disk', async () => {
    const cwd = await tempRoot();
    const agentRoot = await tempRoot();
    const dataDir = await tempRoot();
    await mkdir(join(agentRoot, 'prompts'), { recursive: true });
    await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });
    const options = {
      spawn: { command: process.execPath, args: ['-e', fakePi], source: 'node-entry' as const },
      workspace: { cwd, name: 'morse-spec' },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      env: { ...process.env, PI_CODING_AGENT_DIR: agentRoot },
      dataDir,
    };

    const states: AgentSessionState[] = [];
    agent = new PiRpcAgent(options);
    agent.subscribe((event) => {
      if (event.type === 'agent/ready' || event.type === 'agent/state') {
        states.push(event.state);
      }
    });

    const attached = await agent.initialize();
    // Nothing has been timed on this host yet, so the panel shows — not 0/s.
    expect(attached.speed).toBeUndefined();

    await agent.refreshModels();
    await vi.waitFor(
      () => {
        expect(states.some((state) => state.speed !== undefined)).toBe(true);
      },
      { timeout: 5_000, interval: 10 },
    );
    const measured = states.find((state) => state.speed !== undefined)?.speed;
    expect(measured).toBeDefined();
    expect(measured!.avgTokensPerSecond).toBeGreaterThan(0);
    expect(measured!.peakTokensPerSecond).toBeGreaterThanOrEqual(measured!.slowestTokensPerSecond);

    // The save is fire-and-forget behind the state patch; wait for the file.
    await vi.waitFor(
      async () => {
        expect(await loadSpeed(dataDir, '/tmp/morse-speed-spec-session.jsonl')).toBeDefined();
      },
      { timeout: 5_000, interval: 10 },
    );
    const files = await readdir(join(dataDir, 'speed'));
    expect(files).toHaveLength(1);

    // A fresh host on the same session continues exactly where this one left off.
    await agent.dispose();
    agent = new PiRpcAgent(options);
    const resumed = await agent.initialize();
    expect(resumed.speed).toEqual(measured);
  });
});
