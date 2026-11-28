import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { botOwnedProviders, readOpenCodeAuthExport } from './stored-auth.js';

type Call = { binary: string; args: string[] };

function capture(): { calls: Call[]; run: (binary: string, args: string[]) => string } {
  const calls: Call[] = [];
  return {
    calls,
    run: (binary, args) => {
      calls.push({ binary, args });
      return EXPORTED;
    },
  };
}

/** What `opencode auth export` prints for a machine with two logins. */
const EXPORTED = JSON.stringify([
  { id: 'cred_go', integrationID: 'opencode-go', label: 'OpenCode Go', value: { type: 'key', key: 'go-secret' } },
  { id: 'cred_zai', integrationID: 'zai-coding-plan', label: 'Z.AI', value: { type: 'api', key: 'zai-secret' } },
]);

const idsOf = (payload: string | undefined): string[] =>
  payload === undefined
    ? []
    : (JSON.parse(payload) as { integrationID: string }[]).map((entry) => entry.integrationID);

let dir = '';
afterEach(() => {
  if (dir.length > 0) {
    rmSync(dir, { recursive: true, force: true });
    dir = '';
  }
});

function botRoot(): string {
  dir = mkdtempSync(join(tmpdir(), 'morse-stored-auth-'));
  return dir;
}

describe('readOpenCodeAuthExport', () => {
  it('exports every stored integration, with no provider named', () => {
    const { calls, run } = capture();
    const payload = readOpenCodeAuthExport(run);
    expect(idsOf(payload)).toEqual(['opencode-go', 'zai-coding-plan']);
    expect(calls[0]?.binary.length).toBeGreaterThan(0);
    expect(calls[0]?.args).toEqual(['auth', 'export', '--standalone']);
  });

  it('asks the attached server when the host has one', () => {
    const previous = { ...process.env };
    process.env['MORSE_OPENCODE_URL'] = 'http://127.0.0.1:4096';
    process.env['MORSE_OPENCODE_PASSWORD'] = 'secret';
    try {
      const { calls, run } = capture();
      readOpenCodeAuthExport(run);
      expect(calls[0]?.args).toEqual(['auth', 'export', '--server', 'http://127.0.0.1:4096']);
    } finally {
      process.env = previous;
    }
  });

  it('leaves out integrations the bot already answers for on its own', () => {
    const { run } = capture();
    const payload = readOpenCodeAuthExport(run, new Set(['zai-coding-plan']));
    expect(idsOf(payload)).toEqual(['opencode-go']);
  });

  it('passes the exporter’s own records through unmodified, so import accepts them', () => {
    const { run } = capture();
    const payload = readOpenCodeAuthExport(run);
    expect(JSON.parse(payload ?? '[]')).toEqual(JSON.parse(EXPORTED));
  });

  it('has nothing to import when the export is empty, failing, or all kept', () => {
    expect(readOpenCodeAuthExport(() => '')).toBeUndefined();
    expect(
      readOpenCodeAuthExport(() => {
        throw new Error('port already in use');
      }),
    ).toBeUndefined();
    expect(readOpenCodeAuthExport(() => 'not json')).toBeUndefined();
    const { run } = capture();
    expect(
      readOpenCodeAuthExport(run, new Set(['opencode-go', 'zai-coding-plan'])),
    ).toBeUndefined();
  });
});

describe('botOwnedProviders', () => {
  it('names the pasted keys and the declared providers the bot must keep', () => {
    const root = botRoot();
    mkdirSync(join(root, 'sessions', 'opencode'), { recursive: true });
    mkdirSync(join(root, 'config', 'opencode'), { recursive: true });
    writeFileSync(
      join(root, 'sessions', 'opencode', 'auth.json'),
      JSON.stringify({ 'zai-coding-plan': { type: 'api', key: 'typed-in-wizard' } }),
    );
    writeFileSync(
      join(root, 'config', 'opencode', 'opencode.json'),
      JSON.stringify({ providers: { 'llm-eigen': { name: 'Eigen' } } }),
    );
    expect([...botOwnedProviders(root)].sort()).toEqual(['llm-eigen', 'zai-coding-plan']);
  });

  it('is empty for a bot that holds nothing, and survives unreadable files', () => {
    expect([...botOwnedProviders(botRoot())]).toEqual([]);
    const root = botRoot();
    mkdirSync(join(root, 'sessions', 'opencode'), { recursive: true });
    writeFileSync(join(root, 'sessions', 'opencode', 'auth.json'), '{not json');
    expect([...botOwnedProviders(root)]).toEqual([]);
  });
});
