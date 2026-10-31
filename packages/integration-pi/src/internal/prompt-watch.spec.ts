import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptWatcher, promptSignature } from './prompt-watch.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'morse-prompt-watch-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('promptSignature', () => {
  it('moves when a template is added or edited', async () => {
    const dir = await tempRoot();
    const empty = promptSignature([dir]);

    writeFileSync(join(dir, 'halo.md'), 'one');
    const added = promptSignature([dir]);
    expect(added).not.toBe(empty);

    writeFileSync(join(dir, 'halo.md'), 'two two two');
    expect(promptSignature([dir])).not.toBe(added);
  });

  it('ignores a directory that is not there', async () => {
    const dir = await tempRoot();
    expect(promptSignature([join(dir, 'missing')])).toBe('');
  });
});

describe('PromptWatcher', () => {
  it('calls onChange when a template appears, then stops', async () => {
    const dir = await tempRoot();
    const onChange = vi.fn();
    const watcher = new PromptWatcher(() => [dir], onChange, 20);
    watcher.start();

    writeFileSync(join(dir, 'halo.md'), 'body');
    await new Promise((resolve) => setTimeout(resolve, 100));
    watcher.stop();
    const calls = onChange.mock.calls.length;
    expect(calls).toBeGreaterThan(0);

    // A stopped watcher is quiet even if the directory moves again.
    writeFileSync(join(dir, 'halo.md'), 'body changed a lot');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onChange.mock.calls.length).toBe(calls);
  });
});
