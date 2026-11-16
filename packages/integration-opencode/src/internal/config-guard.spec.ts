import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@morse/system';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OpenCodeConfigGuard } from './config-guard.js';
import type { OpenCodeApi } from './client.js';

/** Every temp tree this spec made, removed once the test is over. */
const roots: string[] = [];

function root(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** The XDG config home a guard scans; never the machine's real `~/.config`. */
let configHome: string;
/** The workspace the guard fingerprints; a temp directory, never `/work`. */
let work: string;

beforeEach(() => {
  configHome = root('morse-config-guard-home-');
  work = root('morse-config-guard-work-');
  mkdirSync(join(configHome, 'opencode'), { recursive: true });
  writeFileSync(join(configHome, 'opencode', 'opencode.json'), '{"default_agent":"build"}');
});

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A client whose `post` records the path and answers `204`. */
function fakeApi(posts: string[]): Pick<OpenCodeApi, 'post'> {
  return {
    post: async (path: string): Promise<undefined> => {
      posts.push(path);
      return undefined;
    },
  };
}

function makeGuard(options: { owned: boolean }): {
  guard: OpenCodeConfigGuard;
  posts: string[];
} {
  const posts: string[] = [];
  const guard = new OpenCodeConfigGuard({
    api: fakeApi(posts),
    logger: silentLogger,
    owned: options.owned,
    env: { XDG_CONFIG_HOME: configHome },
  });
  return { guard, posts };
}

/** The global file the guard reads, with its mtime bumped past its seed. */
function touchGlobal(): void {
  utimesSync(
    join(configHome, 'opencode', 'opencode.json'),
    new Date(),
    new Date(Date.now() + 5_000),
  );
}

describe('OpenCodeConfigGuard', () => {
  it('seeds the first signature without reloading', async () => {
    mkdirSync(join(configHome, 'opencode'), { recursive: true });
    writeFileSync(join(configHome, 'opencode', 'opencode.json'), '{"default_agent":"build"}');
    const { guard, posts } = makeGuard({ owned: true });
    await expect(guard.ensureFresh(work)).resolves.toBe(false);
    expect(posts).toEqual([]);
  });

  it('reloads once when the global file changes, then stays quiet', async () => {
    const { guard, posts } = makeGuard({ owned: true });
    await guard.ensureFresh(work);
    touchGlobal();
    await expect(guard.ensureFresh(work)).resolves.toBe(true);
    await expect(guard.ensureFresh(work)).resolves.toBe(false);
    expect(posts).toEqual(['/location/reload']);
  });

  it('defers a reload while a tracked session is streaming', async () => {
    const { guard, posts } = makeGuard({ owned: true });
    await guard.ensureFresh(work);
    guard.setStreaming('ses_1', true);
    touchGlobal();
    await expect(guard.ensureFresh(work)).resolves.toBe(false);
    expect(posts).toEqual([]);
    guard.setStreaming('ses_1', false);
    await expect(guard.ensureFresh(work)).resolves.toBe(true);
    expect(posts).toEqual(['/location/reload']);
  });

  it('never reloads an attached server automatically, but reloads on demand', async () => {
    const { guard, posts } = makeGuard({ owned: false });
    await guard.ensureFresh(work);
    touchGlobal();
    await expect(guard.ensureFresh(work)).resolves.toBe(false);
    expect(posts).toEqual([]);
    await guard.reloadNow(work);
    expect(posts).toEqual(['/location/reload']);
  });

  it('covers a project .opencode/opencode.json as well as the global file', async () => {
    mkdirSync(join(work, '.opencode'), { recursive: true });
    writeFileSync(join(work, '.opencode', 'opencode.json'), '{"default_agent":"plan"}');
    const { guard, posts } = makeGuard({ owned: true });
    await guard.ensureFresh(work);
    utimesSync(join(work, '.opencode', 'opencode.json'), new Date(), new Date(Date.now() + 5_000));
    await expect(guard.ensureFresh(work)).resolves.toBe(true);
    expect(posts).toEqual(['/location/reload']);
  });

  it('reloads when a workspace gains its first project config', async () => {
    const { guard, posts } = makeGuard({ owned: true });
    await guard.ensureFresh(work);
    writeFileSync(join(work, 'opencode.json'), '{"default_agent":"plan"}');
    await expect(guard.ensureFresh(work)).resolves.toBe(true);
    expect(posts).toEqual(['/location/reload']);
  });

  it('reloads when a workspace gains a .opencode/opencode.jsonc', async () => {
    const { guard, posts } = makeGuard({ owned: true });
    await guard.ensureFresh(work);
    mkdirSync(join(work, '.opencode'), { recursive: true });
    writeFileSync(join(work, '.opencode', 'opencode.jsonc'), '{\n  // first project config\n}\n');
    await expect(guard.ensureFresh(work)).resolves.toBe(true);
    expect(posts).toEqual(['/location/reload']);
  });

  it('fingerprints an explicit config dir instead of XDG_CONFIG_HOME', async () => {
    // A bot's own tree: `configDir` wins over the XDG path the env names.
    const botDir = join(root('morse-config-guard-bot-'), 'opencode');
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(botDir, 'opencode.json'), '{"default_agent":"build"}');
    const posts: string[] = [];
    const guard = new OpenCodeConfigGuard({
      api: fakeApi(posts),
      logger: silentLogger,
      owned: true,
      configDir: botDir,
      env: { XDG_CONFIG_HOME: configHome },
    });
    await guard.ensureFresh(work);
    expect(guard.signature(work)).toContain(join(botDir, 'opencode.json'));
    utimesSync(join(botDir, 'opencode.json'), new Date(), new Date(Date.now() + 5_000));
    await expect(guard.ensureFresh(work)).resolves.toBe(true);
    expect(posts).toEqual(['/location/reload']);
  });

  it('fingerprints each config file and marks a missing one', () => {
    const { guard } = makeGuard({ owned: true });
    const global = join(configHome, 'opencode', 'opencode.json');
    const seeded = guard.signature(work);
    expect(seeded).toContain(global);
    expect(seeded).not.toContain(`${global}:missing`);
    touchGlobal();
    expect(guard.signature(work)).not.toBe(seeded);
    rmSync(global);
    expect(guard.signature(work)).toContain(`${global}:missing`);
  });

  it('stops tracking a session it is told to forget', async () => {
    const { guard, posts } = makeGuard({ owned: true });
    await guard.ensureFresh(work);
    guard.setStreaming('ses_1', true);
    guard.forget('ses_1');
    touchGlobal();
    await expect(guard.ensureFresh(work)).resolves.toBe(true);
    expect(posts).toEqual(['/location/reload']);
  });

  it('logs a failed reload instead of throwing, and retries it next time', async () => {
    const posts: string[] = [];
    let refuse = true;
    const guard = new OpenCodeConfigGuard({
      api: {
        post: async (path: string): Promise<undefined> => {
          posts.push(path);
          if (refuse) {
            throw new Error('the server is busy');
          }
          return undefined;
        },
      },
      logger: silentLogger,
      owned: true,
      env: { XDG_CONFIG_HOME: configHome },
    });
    await guard.ensureFresh(work);
    touchGlobal();
    await expect(guard.ensureFresh(work)).resolves.toBe(false);
    refuse = false;
    await expect(guard.ensureFresh(work)).resolves.toBe(true);
    expect(posts).toEqual(['/location/reload', '/location/reload']);
  });

  it('reports a failed manual reload and keeps the edit for a later retry', async () => {
    const posts: string[] = [];
    let refuse = true;
    const guard = new OpenCodeConfigGuard({
      api: {
        post: async (path: string): Promise<undefined> => {
          posts.push(path);
          if (refuse) {
            throw new Error('the server is busy');
          }
          return undefined;
        },
      },
      logger: silentLogger,
      owned: true,
      env: { XDG_CONFIG_HOME: configHome },
    });
    await guard.ensureFresh(work);
    touchGlobal();

    // The explicit reload failed; it must not claim success or reseed the
    // signature, or the next automatic probe would see no change to retry.
    await expect(guard.reloadNow(work)).resolves.toBe(false);
    expect(posts).toEqual(['/location/reload']);

    refuse = false;
    await expect(guard.ensureFresh(work)).resolves.toBe(true);
    expect(posts).toEqual(['/location/reload', '/location/reload']);
  });
});
