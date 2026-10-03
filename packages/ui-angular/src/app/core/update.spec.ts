import { TestBed } from '@angular/core/testing';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MORSE_TRANSPORT } from './transport.token';
import {
  UPDATE_LOADER,
  UpdateCheck,
  isNewerRelease,
  latestFromRegistry,
  releasePage,
  updateHint,
  type VersionLoader,
} from './update';

/** A loader that answers whatever the test says, without a network in sight. */
function loader(document: unknown): VersionLoader & { mock: { calls: unknown[] } } {
  return vi.fn(async () => document) as unknown as VersionLoader & {
    mock: { calls: unknown[] };
  };
}

function service(load?: VersionLoader): UpdateCheck {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      // The mock host reports `updateCheck: false`, so the constructor's own check
      // never runs: what is under test here is `check()` and the comparison.
      { provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() },
      // The default loader is a network call, and a test must not be able to reach it
      // by accident: an explicit `undefined` argument to `check()` falls back to this,
      // which is also what a host without a loader looks like in production.
      { provide: UPDATE_LOADER, useValue: load },
    ],
  });
  return TestBed.inject(UpdateCheck);
}

/**
 * Nothing in this file may touch the network. `check()` falls back to the injected
 * loader when a test passes `undefined`, so the injected loader is what keeps that
 * honest — and this spy is what proves it (it caught a real registry call once).
 */
let requests: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  requests = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
  TestBed.resetTestingModule();
  const calls = requests?.mock.calls.length ?? 0;
  requests?.mockRestore();
  requests = undefined;
  if (calls > 0) {
    throw new Error(`a test in update.spec.ts made ${calls} real network request(s)`);
  }
});

describe('isNewerRelease', () => {
  it('compares the numbers, not the text', () => {
    expect(isNewerRelease('0.2.2', '0.2.1')).toBe(true);
    expect(isNewerRelease('0.3.0', '0.2.9')).toBe(true);
    expect(isNewerRelease('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerRelease('0.2.1', '0.2.1')).toBe(false);
    expect(isNewerRelease('0.2.0', '0.2.1')).toBe(false);
  });

  it('puts a prerelease before the release it leads to', () => {
    expect(isNewerRelease('0.3.0', '0.3.0-beta.1')).toBe(true);
    expect(isNewerRelease('0.3.0-beta.1', '0.3.0')).toBe(false);
    expect(isNewerRelease('0.3.0-beta.2', '0.3.0-beta.1')).toBe(true);
    // A prerelease is not an upgrade for the release before it.
    expect(isNewerRelease('0.2.1-beta.1', '0.2.1')).toBe(false);
  });

  it('ignores build metadata and refuses to compare nonsense', () => {
    expect(isNewerRelease('0.3.0+build.5', '0.2.1')).toBe(true);
    expect(isNewerRelease('latest', '0.2.1')).toBe(false);
    expect(isNewerRelease('1.0', '0.2.1')).toBe(false);
    expect(isNewerRelease('0.3.0', 'not-a-version')).toBe(false);
    expect(isNewerRelease('', '')).toBe(false);
  });
});

describe('latestFromRegistry', () => {
  it('reads the version the registry published', () => {
    expect(latestFromRegistry({ name: '@supanadit/morse-web', version: '0.3.0' })).toBe('0.3.0');
  });

  it('stays quiet on any other shape, including npm’s own 404 document', () => {
    expect(latestFromRegistry(null)).toBeUndefined();
    expect(latestFromRegistry({ error: 'Not found' })).toBeUndefined();
    expect(latestFromRegistry({ version: 3 })).toBeUndefined();
    expect(latestFromRegistry('0.3.0')).toBeUndefined();
  });
});

describe('where the reader goes next', () => {
  it('points at the release notes for that version', () => {
    expect(releasePage('0.3.0')).toBe('https://github.com/supanadit/morse/releases/tag/v0.3.0');
  });

  it('says how each host is updated, in its own terms', () => {
    // The browser host is an npm install, so the hint is the command that does it.
    expect(updateHint('server', '0.3.0')).toContain('npm install -g @supanadit/morse-web@0.3.0');
    expect(updateHint('server', '0.3.0')).toContain('start the host again');
    // VS Code has its own update path, and a hand-installed VSIX has to be named.
    expect(updateHint('vscode', '0.3.0')).toContain('VSIX');
    expect(updateHint('vscode', '0.3.0')).toContain('Marketplace');
  });
});

describe('UpdateCheck', () => {
  it('records a notice for a newer release, with the keys the UI needs', async () => {
    const update = service();
    expect(update.available()).toBeUndefined();

    await update.check('0.2.1', 'server', loader({ version: '0.3.0' }));

    expect(update.available()).toMatchObject({
      current: '0.2.1',
      latest: '0.3.0',
      url: 'https://github.com/supanadit/morse/releases/tag/v0.3.0',
    });
    expect(update.available()?.hint).toContain('@supanadit/morse-web@0.3.0');
  });

  it('says nothing when the registry has nothing newer', async () => {
    const update = service();

    await update.check('0.2.1', 'server', loader({ version: '0.2.1' }));
    await update.check('0.2.1', 'server', loader({ version: '0.1.9' }));
    await update.check('0.2.1', 'server', loader({ error: 'Not found' }));

    expect(update.available()).toBeUndefined();
  });

  it('treats a failed or unreadable request as silence, never as an error', async () => {
    const update = service();
    const offline: VersionLoader = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    const garbage: VersionLoader = () => Promise.resolve('<!doctype html>');

    await expect(update.check('0.2.1', 'server', offline)).resolves.toBeUndefined();
    await update.check('0.2.1', 'server', garbage);
    await update.check('0.2.1', 'server', undefined);

    expect(update.available()).toBeUndefined();
  });

  it('can be reviewed with ?newer, without a release and without a request', async () => {
    const update = service();
    const request = loader({ version: '0.2.1' });
    window.history.replaceState({}, '', '/?newer=0.9.9');

    await update.check('0.2.1', 'server', request);

    // The badge has to be reviewable before it matters, so the fake version wins
    // and nothing is fetched to contradict it.
    expect(update.available()?.latest).toBe('0.9.9');
    expect(request.mock.calls).toHaveLength(0);
  });
});
