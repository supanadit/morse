import { describe, expect, it } from 'vitest';
import { UNTITLED_SESSION } from '@morse/system';
import type { OpenCodeApi, OpenCodePage } from './internal/client.js';
import { OpenCodeSessionCatalog } from './opencode-session-catalog.js';

/**
 * The catalog groups OpenCode's flat newest-first session list by directory and
 * pages per project, because that is the shape the sidebar reads. A fake server
 * supplies a cursor so paging is exercised, an archived row the installed server
 * does not send yet, and two projects of different sizes.
 */

interface Row {
  id: string;
  title?: string;
  time?: { created?: number; updated?: number; archived?: number };
  location?: { directory?: string };
  archived?: boolean;
  fork?: { sessionID?: string };
  parentID?: string;
}

class FakeApi {
  readonly deleted: string[] = [];

  constructor(private readonly pages: { data: Row[]; cursor?: { next?: string } }[]) {}

  page<T>(_path: string, query?: Record<string, string | undefined>): Promise<OpenCodePage<T>> {
    const index = query?.['cursor'] === undefined ? 0 : Number(query['cursor']);
    return Promise.resolve((this.pages[index] ?? { data: [] }) as OpenCodePage<T>);
  }

  delete(path: string): Promise<void> {
    this.deleted.push(path.split('/').at(-1) ?? path);
    return Promise.resolve();
  }
}

function project(count: number, directory: string, start: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ses_${directory.split('/').at(-1)}_${index}`,
    title: `${directory} session ${index}`,
    time: { created: start + index, updated: start + index },
    location: { directory },
  }));
}

function buildCatalog(
  rows: Row[],
  options: { maxSessionsPerProject?: number; maxSessions?: number } = {},
): {
  catalog: OpenCodeSessionCatalog;
  api: FakeApi;
} {
  // Two pages: the first is linked to the second by a numeric cursor.
  const half = Math.ceil(rows.length / 2);
  const api = new FakeApi([
    { data: rows.slice(0, half), cursor: { next: '1' } },
    { data: rows.slice(half) },
  ]);
  return {
    api,
    catalog: new OpenCodeSessionCatalog({
      api: api as unknown as OpenCodeApi,
      ...(options.maxSessionsPerProject === undefined
        ? {}
        : { maxSessionsPerProject: options.maxSessionsPerProject }),
      ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    }),
  };
}

describe('OpenCodeSessionCatalog', () => {
  it('lists every project newest first, capping each at a first page', async () => {
    const rows = [...project(12, '/work/a', 1_000), ...project(2, '/work/b', 1_100)];
    const { catalog } = buildCatalog(rows);

    const listed = await catalog.list();
    const fromA = listed.filter((session) => session.cwd === '/work/a');
    const fromB = listed.filter((session) => session.cwd === '/work/b');
    expect(fromA).toHaveLength(10);
    expect(fromB).toHaveLength(2);
    // a's newest rows are shown (sorted by updatedAt, both projects merged).
    expect(listed.map((session) => session.updatedAt)).toEqual(
      [...listed.map((session) => session.updatedAt)].sort((left, right) => right - left),
    );
    expect(listed[0]?.title).toContain('/work/b');
  });

  it('reads both pages of the server cursor', async () => {
    const rows = project(6, '/work/a', 1_000);
    const { catalog } = buildCatalog(rows, { maxSessionsPerProject: 10 });
    const listed = await catalog.list();
    // The oldest rows live on page two; all six arrive, proving the cursor walk.
    expect(listed).toHaveLength(6);
    expect(listed.some((session) => session.title?.endsWith('session 0'))).toBe(true);
  });

  it('leaves archived sessions out', async () => {
    const rows = [
      ...project(2, '/work/a', 1_000),
      {
        id: 'ses_archived',
        title: 'old',
        time: { created: 2_000, updated: 2_000 },
        location: { directory: '/work/a' },
        archived: true,
      },
      {
        id: 'ses_archived_at',
        title: 'older',
        time: { created: 2_100, updated: 2_100, archived: 2_200 },
        location: { directory: '/work/a' },
      },
    ];
    const { catalog } = buildCatalog(rows);
    const listed = await catalog.list();
    expect(listed.map((session) => session.id).sort()).toEqual(['ses_a_0', 'ses_a_1']);
  });

  it('pages one project from an offset for "Load more"', async () => {
    const rows = project(15, '/work/a', 1_000);
    const { catalog } = buildCatalog(rows, { maxSessionsPerProject: 10 });
    const page = await catalog.listPage({
      cwd: '/work/a',
      offset: 10,
      limit: 10,
    });
    expect(page.sessions).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    expect(page.sessions.at(-1)?.title).toBe('/work/a session 0');
  });

  it('searches titles and paths, and counts per project', async () => {
    const rows = [
      {
        id: 'ses_1',
        title: 'Fix the parser',
        time: { created: 1, updated: 3 },
        location: { directory: '/work/a' },
      },
      {
        id: 'ses_2',
        title: 'Other work',
        time: { created: 2, updated: 2 },
        location: { directory: '/work/b' },
      },
      {
        id: 'ses_3',
        time: { created: 3, updated: 1 },
        location: { directory: '/work/a' },
      },
    ];
    const { catalog } = buildCatalog(rows);

    expect((await catalog.search('parser')).map((session) => session.id)).toEqual(['ses_1']);
    expect((await catalog.search('/work/a')).map((session) => session.id)).toEqual([
      'ses_1',
      'ses_3',
    ]);
    expect(await catalog.countByProject()).toEqual(
      new Map([
        ['/work/a', 2],
        ['/work/b', 1],
      ]),
    );
    // A session without a title gets the shared placeholder.
    expect((await catalog.list()).find((session) => session.id === 'ses_3')?.title).toBe(
      UNTITLED_SESSION,
    );
  });

  it('deletes through the server and keeps the fork parent', async () => {
    const rows = [
      {
        id: 'ses_child',
        title: 'child',
        time: { created: 2, updated: 2 },
        location: { directory: '/work/a' },
        fork: { sessionID: 'ses_parent' },
      },
    ];
    const { catalog, api } = buildCatalog(rows);
    const [listed] = await catalog.list();
    expect(listed?.parentId).toBe('ses_parent');

    await catalog.remove('ses_child');
    expect(api.deleted).toEqual(['ses_child']);
  });
});

/**
 * A subagent child nests under its parent and is watched read-only; a fork
 * nests too but stays a normal session the reader prompts in. OpenCode
 * separates the two on the record — `parentID` for delegation children (one per
 * `task` call, several possibly in parallel), `fork.sessionID` for forks — and
 * the catalog must carry that distinction through, not flatten it.
 */
describe('OpenCodeSessionCatalog · subagent children', () => {
  it('marks a parentID child as a subagent under its parent', async () => {
    const { catalog } = buildCatalog([
      {
        id: 'ses_parent',
        title: 'Parent',
        time: { created: 1, updated: 2 },
        location: { directory: '/repo' },
      },
      {
        id: 'ses_kid',
        title: 'explore',
        parentID: 'ses_parent',
        time: { created: 2, updated: 3 },
        location: { directory: '/repo' },
      },
    ]);

    const kid = (await catalog.list()).find((session) => session.id === 'ses_kid');
    expect(kid).toMatchObject({ parentId: 'ses_parent', subagent: true });
  });

  it('keeps a fork a normal session', async () => {
    const { catalog } = buildCatalog([
      {
        id: 'ses_fork',
        title: 'Fork',
        fork: { sessionID: 'ses_parent' },
        time: { created: 1, updated: 2 },
        location: { directory: '/repo' },
      },
    ]);

    const fork = (await catalog.list()).find((session) => session.id === 'ses_fork');
    expect(fork).toMatchObject({ parentId: 'ses_parent' });
    expect(fork?.subagent).toBeUndefined();
  });

  it('keeps parallel siblings under the same parent', async () => {
    const { catalog } = buildCatalog([
      {
        id: 'ses_a',
        title: 'one',
        parentID: 'ses_parent',
        time: { created: 1, updated: 2 },
        location: { directory: '/repo' },
      },
      {
        id: 'ses_b',
        title: 'two',
        parentID: 'ses_parent',
        time: { created: 2, updated: 3 },
        location: { directory: '/repo' },
      },
    ]);

    const kids = (await catalog.list()).filter((session) => session.parentId === 'ses_parent');
    expect(kids.map((kid) => kid.id).sort()).toEqual(['ses_a', 'ses_b']);
    expect(kids.every((kid) => kid.subagent === true)).toBe(true);
  });
});
