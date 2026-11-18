import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationFiles, failIfAny } from './conversation-files.js';

interface Row {
  id: string;
}

function isRow(value: unknown): value is Row {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['id'] === 'string'
  );
}

/**
 * The plumbing behind both conversation stores: an id is turned into a path
 * here, and a file is read here, so these rules are what keep a store from
 * writing outside its directory or mistaking a broken file for an empty one.
 */
describe('conversation files', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morse-conversation-files-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function files(): ConversationFiles<Row> {
    return new ConversationFiles<Row>(dir, 'a list of rows', isRow);
  }

  it('reads a missing directory and a missing file as empty', () => {
    expect(
      new ConversationFiles<Row>(join(dir, 'absent'), 'a list of rows', isRow).all('dm-sigil'),
    ).toEqual([]);
    expect(files().all('dm-sigil')).toEqual([]);
    expect(files().conversations()).toEqual([]);
  });

  it('writes a conversation file the next reader sees', () => {
    files().write('dm-sigil', [{ id: 'a' }]);

    expect(files().all('dm-sigil')).toEqual([{ id: 'a' }]);
    expect(files().conversations()).toEqual(['dm-sigil']);
  });

  it('refuses an id that could name another path, before touching the disk', () => {
    expect(() => files().all('../etc')).toThrow(/usable conversation id/);
    expect(() => files().write('../etc', [])).toThrow(/usable conversation id/);
    expect(() => files().forget('../etc')).toThrow(/usable conversation id/);
  });

  it('refuses a malformed file with its path instead of reading it as empty', () => {
    writeFileSync(join(dir, 'dm-sigil.json'), '{"nope":');
    expect(() => files().all('dm-sigil')).toThrow(/dm-sigil\.json/);

    writeFileSync(join(dir, 'dm-sigil.json'), '[{"id":1}]');
    expect(() => files().all('dm-sigil')).toThrow(/dm-sigil\.json/);
  });

  it('surfaces a file that exists but cannot be read', () => {
    // A directory where a file belongs: the path exists, so it must not read as
    // an empty history — only a missing file does that.
    mkdirSync(join(dir, 'dm-sigil.json'));

    expect(() => files().all('dm-sigil')).toThrow();
  });

  it('forgets a file and tolerates one that was never written', () => {
    files().write('dm-sigil', [{ id: 'a' }]);

    files().forget('dm-sigil');
    files().forget('dm-sigil');

    expect(files().all('dm-sigil')).toEqual([]);
  });

  it('names a sweep failure even when its id could not be a path', () => {
    expect(files().failure('00 notes', new Error('boom'))).toMatch(/00 notes\.json: boom$/);
  });

  it('reports nothing when a sweep had no failures', () => {
    expect(() => failIfAny('prune rows', [], 'row')).not.toThrow();
    expect(() => failIfAny('prune rows', ['a: boom'], 'row')).toThrow(/1 row file\(s\) failed/);
  });
});
