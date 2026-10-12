import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiRpcSessionCatalog } from './pi-rpc-session-catalog.js';

/** A session directory shaped like pi's: `<session-dir>/--<cwd>--/<file>.jsonl`. */
async function makeCatalog(files: Record<string, string[]>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'morse-catalog-'));
  const bucket = join(root, '--work-project--');
  await mkdir(bucket, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    await writeFile(join(bucket, name), `${lines.join('\n')}\n`, 'utf8');
  }
  return root;
}

const userMessage = (text: string, at: string) =>
  `{"type":"message","id":"${at}","timestamp":"2026-01-01T00:00:0${at}.000Z","message":{"role":"user","content":[{"type":"text","text":"${text}"}]}}`;
const assistantMessage = (at: string) =>
  `{"type":"message","id":"a${at}","timestamp":"2026-01-01T00:00:0${at}.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}`;

const SESSION = [
  '{"type":"session","version":3,"id":"abcdef","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/work/project"}',
  '{"type":"model_change","id":"m1","provider":"ollama","model":"x"}',
];
const ONE_SESSION = { 'one.jsonl': [...SESSION, userMessage('first question', '1'), assistantMessage('2')] };

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PiRpcSessionCatalog', () => {
  it('reads pi files the way the sidebar shows them', async () => {
    const root = await makeCatalog({
      ...ONE_SESSION,
      'two.jsonl': [...SESSION, userMessage('Fix the parser please, and keep going', '3'), assistantMessage('4'), assistantMessage('5')],
    });
    roots.push(root);
    const catalog = new PiRpcSessionCatalog({ sessionDir: root });

    const sessions = await catalog.list();
    const byFile = Object.fromEntries(sessions.map((s) => [s.id.split('/').pop(), s]));

    expect(sessions).toHaveLength(2);
    expect(byFile['one.jsonl']).toMatchObject({
      title: 'first question',
      cwd: '/work/project',
      messageCount: 2,
    });
    expect(byFile['two.jsonl'].messageCount).toBe(3);
    // The id is the file path, so it can be handed back to pi for a resume.
    expect(byFile['two.jsonl'].id.endsWith('two.jsonl')).toBe(true);
  });

  it('reads the parent a forked session was cloned from, so the sidebar can nest it', async () => {
    const parent = '/work/project/sessions/original.jsonl';
    const root = await makeCatalog({
      'fork.jsonl': [
        `{"type":"session","version":3,"id":"fork","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/work/project","parentSession":"${parent}"}`,
        userMessage('first question', '1'),
      ],
      ...ONE_SESSION,
    });
    roots.push(root);
    const catalog = new PiRpcSessionCatalog({ sessionDir: root });

    const byFile = Object.fromEntries((await catalog.list()).map((s) => [s.id.split('/').pop(), s]));
    // The header carries the parent path verbatim; a session that is not a fork has none.
    expect(byFile['fork.jsonl'].parentId).toBe(parent);
    expect(byFile['one.jsonl'].parentId).toBeUndefined();
  });

  it('keeps the parent across a resumed scan, which never re-reads the header', async () => {
    const parent = '/work/project/sessions/original.jsonl';
    const root = await makeCatalog({
      'fork.jsonl': [
        `{"type":"session","version":3,"id":"fork","cwd":"/work/project","parentSession":"${parent}"}`,
      ],
    });
    roots.push(root);
    const file = join(root, '--work-project--', 'fork.jsonl');
    const catalog = new PiRpcSessionCatalog({ sessionDir: root });
    expect((await catalog.list())[0].parentId).toBe(parent);

    // The next list reads only the appended tail; the parent must survive that.
    await writeFile(file, `${userMessage('a fork, continued', '1')}\n`, { encoding: 'utf8', flag: 'a' });
    expect((await catalog.list())[0]).toMatchObject({
      title: 'a fork, continued',
      parentId: parent,
    });
  });

  it('still counts and parses lines that are not in pi’s canonical shape', async () => {
    const root = await makeCatalog({
      // Spaced keys and a different key order: the fast path must not miss these.
      'odd.jsonl': [
        '{"type": "session", "cwd": "/work/other"}',
        '{ "message": { "role": "user", "content": "weird spacing" }, "type": "message" }',
        'not json at all',
      ],
    });
    roots.push(root);
    const catalog = new PiRpcSessionCatalog({ sessionDir: root });

    const [session] = await catalog.list();
    expect(session).toMatchObject({ cwd: '/work/other', title: 'weird spacing', messageCount: 1 });
  });

  it('falls back to a rename, then to Untitled, exactly as before', async () => {
    const root = await makeCatalog({
      'named.jsonl': [
        ...SESSION,
        userMessage('first question', '1'),
        '{"type":"session_name","name":"Renamed later"}',
      ],
      'empty.jsonl': [...SESSION],
    });
    roots.push(root);
    const catalog = new PiRpcSessionCatalog({ sessionDir: root });

    const titles = (await catalog.list()).map((s) => s.title);
    expect(titles).toContain('Renamed later');
    expect(titles).toContain('Untitled session');
  });

  it('answers a repeated list from the file fingerprint instead of reading the file again', async () => {
    const root = await makeCatalog(ONE_SESSION);
    roots.push(root);
    const file = join(root, '--work-project--', 'one.jsonl');
    let reads = 0;
    const catalog = new PiRpcSessionCatalog({
      sessionDir: root,
      readSummary: async (path, updatedAt) => {
        reads += 1;
        return {
          summary: { id: path, title: `read ${reads}`, cwd: '/work/project', updatedAt, messageCount: 1 },
          scanned: 0,
        };
      },
    });

    expect((await catalog.list())[0].title).toBe('read 1');
    expect(reads).toBe(1);

    // Same file, same size, same mtime: the list is answered without touching the
    // disk again, which is what makes a refresh cheap.
    expect((await catalog.list())[0].title).toBe('read 1');
    expect(reads).toBe(1);

    // A session that grew is read again.
    await writeFile(file, `${assistantMessage('9')}\n`, { encoding: 'utf8', flag: 'a' });
    expect((await catalog.list())[0].title).toBe('read 2');
    expect(reads).toBe(2);
  });

  it('picks up what a growing session appends, including its first title', async () => {
    const root = await makeCatalog({ 'grow.jsonl': [...SESSION] });
    roots.push(root);
    const file = join(root, '--work-project--', 'grow.jsonl');
    const catalog = new PiRpcSessionCatalog({ sessionDir: root });

    // Only the header so far: nothing to title it with yet.
    expect((await catalog.list())[0]).toMatchObject({ title: 'Untitled session', messageCount: 0 });

    // The first user message arrives later, then a rename.
    await writeFile(file, `${userMessage('hello there', '1')}\n`, { encoding: 'utf8', flag: 'a' });
    expect((await catalog.list())[0]).toMatchObject({ title: 'hello there', messageCount: 1 });

    await writeFile(file, `${assistantMessage('2')}\n{"type":"session_name","name":"Renamed"}\n`, {
      encoding: 'utf8',
      flag: 'a',
    });
    expect((await catalog.list())[0]).toMatchObject({ title: 'Renamed', messageCount: 2 });

    // A line still being written is not counted until it is complete.
    await writeFile(file, '{"type":"message","id":"x"', { encoding: 'utf8', flag: 'a' });
    expect((await catalog.list())[0].messageCount).toBe(2);
    await writeFile(file, ',"message":{"role":"assistant","content":"done"}}\n', {
      encoding: 'utf8',
      flag: 'a',
    });
    expect((await catalog.list())[0].messageCount).toBe(3);

    // A whole entry whose newline has not landed yet counts once, and is not
    // counted twice by the next scan.
    await writeFile(file, '{"type":"message","id":"y","message":{"role":"assistant","content":"end"}}', {
      encoding: 'utf8',
      flag: 'a',
    });
    expect((await catalog.list())[0].messageCount).toBe(4);
    expect((await catalog.list())[0].messageCount).toBe(4);
  });

  it('reads a rewritten or shorter file again instead of trusting the resume offset', async () => {
    const root = await makeCatalog({
      'rewrite.jsonl': [...SESSION, userMessage('long one', '1'), assistantMessage('2'), assistantMessage('3')],
    });
    roots.push(root);
    const file = join(root, '--work-project--', 'rewrite.jsonl');
    const catalog = new PiRpcSessionCatalog({ sessionDir: root });
    expect((await catalog.list())[0].messageCount).toBe(3);

    // Shorter content: the byte offset from before means nothing now.
    await writeFile(file, `${[...SESSION, userMessage('restarted', '9')].join('\n')}\n`, 'utf8');
    expect((await catalog.list())[0]).toMatchObject({ title: 'restarted', messageCount: 1 });
  });

  it('builds one list at a time, however many callers ask at once', async () => {
    const root = await makeCatalog(ONE_SESSION);
    roots.push(root);
    let reads = 0;
    const catalog = new PiRpcSessionCatalog({
      sessionDir: root,
      readSummary: async (path, updatedAt) => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          summary: { id: path, title: 'once', cwd: '/work/project', updatedAt, messageCount: 1 },
          scanned: 0,
        };
      },
    });

    // Two frontends connecting together, or a push landing on an in-flight
    // refresh: one scan, handed to both.
    const [first, second] = await Promise.all([catalog.list(), catalog.list()]);

    expect(reads).toBe(1);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  it('forgets a deleted session instead of keeping it cached', async () => {
    const root = await makeCatalog(ONE_SESSION);
    roots.push(root);
    const catalog = new PiRpcSessionCatalog({ sessionDir: root });

    expect(await catalog.list()).toHaveLength(1);
    await rm(join(root, '--work-project--', 'one.jsonl'));
    expect(await catalog.list()).toHaveLength(0);
  });

  it('refuses to delete anything outside its own session directory', async () => {
    const root = await makeCatalog(ONE_SESSION);
    roots.push(root);
    const catalog = new PiRpcSessionCatalog({ sessionDir: root });

    await expect(catalog.remove(join(root, '..', 'elsewhere.jsonl'))).rejects.toThrow(/outside/);
  });

  it('treats an already-deleted session file as deleted', async () => {
    const root = await makeCatalog(ONE_SESSION);
    roots.push(root);
    const catalog = new PiRpcSessionCatalog({ sessionDir: root });
    const path = join(root, '--work-project--', 'one.jsonl');

    // The file was removed out of band (or by a concurrent delete). Delete must
    // be idempotent: a session that is already gone is what the caller wanted.
    await expect(catalog.remove(join(root, '--work-project--', 'gone.jsonl'))).resolves.toBeUndefined();
    await expect(catalog.remove(path)).resolves.toBeUndefined();
    await expect(catalog.remove(path)).resolves.toBeUndefined();
  });

  it('treats a host-specific not-found (VS Code) as deleted too', async () => {
    const root = await makeCatalog(ONE_SESSION);
    roots.push(root);
    const catalog = new PiRpcSessionCatalog({
      sessionDir: root,
      removeFile: async () => {
        // What `vscode.workspace.fs.delete` throws for a missing file.
        throw Object.assign(new Error('Unable to delete file'), { name: 'FileNotFound' });
      },
    });

    await expect(catalog.remove(join(root, '--work-project--', 'one.jsonl'))).resolves.toBeUndefined();
  });

  it('keeps every project even when one project has many more sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'morse-catalog-'));
    roots.push(root);
    const bucketA = join(root, '--work-busy--');
    const bucketB = join(root, '--work-quiet--');
    await mkdir(bucketA, { recursive: true });
    await mkdir(bucketB, { recursive: true });
    // 30 sessions in the busy project, one in the quiet one. The quiet project
    // must be present no matter how many sessions the busy one holds.
    for (let index = 0; index < 30; index += 1) {
      const at = String(index).padStart(2, '0');
      await writeFile(
        join(bucketA, `busy-${at}.jsonl`),
        `${SESSION.map((line) => line.replace('/work/project', '/work/busy')).join('\n')}\n${userMessage(`busy ${at}`, at)}\n`,
        'utf8',
      );
    }
    await writeFile(
      join(bucketB, 'quiet.jsonl'),
      `${SESSION.map((line) => line.replace('/work/project', '/work/quiet')).join('\n')}\n${userMessage('quiet one', '50')}\n`,
      'utf8',
    );
    const catalog = new PiRpcSessionCatalog({ sessionDir: root, maxSessionsPerProject: 5 });

    const sessions = await catalog.list();
    const byCwd = new Map<string, number>();
    for (const session of sessions) {
      byCwd.set(session.cwd, (byCwd.get(session.cwd) ?? 0) + 1);
    }
    // The quiet project survived even though the busy one's newest 30 would fill
    // a small global cap entirely.
    expect(byCwd.get('/work/busy')).toBe(5);
    expect(byCwd.get('/work/quiet')).toBe(1);
  });

  it('pages one project\'s sessions and reports whether more remain', async () => {
    const root = await makeCatalog({});
    roots.push(root);
    const bucket = join(root, '--work-project--');
    await mkdir(bucket, { recursive: true });
    for (let index = 0; index < 25; index += 1) {
      const at = String(index).padStart(2, '0');
      await writeFile(
        join(bucket, `page-${at}.jsonl`),
        `${SESSION.join('\n')}\n${userMessage(`page ${at}`, at)}\n`,
        'utf8',
      );
    }
    const catalog = new PiRpcSessionCatalog({ sessionDir: root, maxSessionsPerProject: 10 });

    // The first list already shows the first page of ten.
    expect(await catalog.list()).toHaveLength(10);

    const first = await catalog.listPage({ cwd: '/work/project', offset: 0, limit: 10 });
    expect(first.sessions).toHaveLength(10);
    expect(first.hasMore).toBe(true);

    const second = await catalog.listPage({ cwd: '/work/project', offset: 10, limit: 10 });
    expect(second.sessions).toHaveLength(10);
    expect(second.hasMore).toBe(true);

    const third = await catalog.listPage({ cwd: '/work/project', offset: 20, limit: 10 });
    expect(third.sessions).toHaveLength(5);
    expect(third.hasMore).toBe(false);

    // No page repeats an id from another, so "Load more" cannot show a row twice.
    const ids = new Set([...first.sessions, ...second.sessions, ...third.sessions].map((s) => s.id));
    expect(ids.size).toBe(25);
  });

  it('reports the true per-project count from the directory listing, past the page cap', async () => {
    const root = await makeCatalog({});
    roots.push(root);
    const bucket = join(root, '--work-project--');
    await mkdir(bucket, { recursive: true });
    for (let index = 0; index < 13; index += 1) {
      await writeFile(
        join(bucket, `count-${index}.jsonl`),
        `${SESSION.join('\n')}\n${userMessage(`count ${index}`, '1')}\n`,
        'utf8',
      );
    }
    const catalog = new PiRpcSessionCatalog({ sessionDir: root, maxSessionsPerProject: 5 });

    expect(await catalog.list()).toHaveLength(5);
    // The count is the real total, not the five the page held, so the sidebar can
    // say "Load more" and show a true project size.
    expect((await catalog.countByProject()).get('/work/project')).toBe(13);
  });
});
