import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpWatcher } from './mcp-watch.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('McpWatcher', () => {
  it('reports only the directory whose signature moved', async () => {
    vi.useFakeTimers();
    const signatures = new Map<string, string>([
      ['', 'global-1'],
      ['/work/a', 'a-1'],
      ['/work/b', 'b-1'],
    ]);
    const watcher = new McpWatcher({
      signature: async (cwd) => signatures.get(cwd) ?? '-',
      cwds: () => ['/work/a', '/work/b'],
      intervalMs: 10,
    });
    const seen: string[] = [];
    const unsubscribe = watcher.subscribe((cwd) => seen.push(cwd));

    // The first tick only records a baseline: opening a session is not a change.
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([]);

    signatures.set('/work/b', 'b-2');
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual(['/work/b']);

    unsubscribe();
  });

  it('reports the user-level file when only the global signature moves', async () => {
    vi.useFakeTimers();
    const signatures = new Map<string, string>([['', 'g-1']]);
    const watcher = new McpWatcher({
      signature: async (cwd) => signatures.get(cwd) ?? '-',
      cwds: () => [],
      intervalMs: 10,
    });
    const seen: string[] = [];
    const unsubscribe = watcher.subscribe((cwd) => seen.push(cwd));

    await vi.advanceTimersByTimeAsync(10);
    signatures.set('', 'g-2');
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual(['']);

    unsubscribe();
  });

  it('polls nothing once the last subscriber leaves, and re-baselines on return', async () => {
    vi.useFakeTimers();
    const signature = vi.fn(async () => 'same');
    const watcher = new McpWatcher({ signature, cwds: () => [], intervalMs: 10 });

    const unsubscribe = watcher.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const afterFirst = signature.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(50);
    expect(signature.mock.calls.length).toBe(afterFirst);

    // A new subscriber starts a fresh baseline: the same signature is not a
    // change, so it must not wake the frontend just because the watch resumed.
    const seen: string[] = [];
    const again = watcher.subscribe((cwd) => seen.push(cwd));
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([]);
    again();
  });
});
