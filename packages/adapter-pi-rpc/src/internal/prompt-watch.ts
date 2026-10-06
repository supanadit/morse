import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A cheap fingerprint of the `.md` files in the prompt directories: name, size
 * and mtime. Only the direct children pi loads are counted, so the signature is
 * a few stat calls even in a busy agent directory.
 */
export function promptSignature(dirs: readonly string[]): string {
  const parts: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.md'));
      names.sort();
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const stat = statSync(join(dir, name));
        parts.push(`${dir}/${name}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        // A file that vanished between readdir and stat is simply not counted.
      }
    }
  }
  return parts.join('|');
}

/**
 * Watches the prompt directories a session loads and calls `onChange` when
 * their fingerprint moves.
 *
 * It polls rather than using `fs.watch`: the directories may not exist yet (the
 * user prompt directory, a project that has never had a `.pi/prompts`), and a
 * recursive watcher is not portable. A poll of a handful of stat calls is the
 * price of catching a template written by `vim` or `nano` — pi itself only reads
 * these files at spawn, so without this a new `/command` would need a reload.
 */
export class PromptWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private last = '';

  constructor(
    private readonly dirs: () => readonly string[],
    private readonly onChange: () => void,
    private readonly intervalMs = 1_500,
  ) {}

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.last = promptSignature(this.dirs());
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    // Never keep the host process alive just to watch prompts.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private poll(): void {
    const next = promptSignature(this.dirs());
    if (next === this.last) {
      return;
    }
    this.last = next;
    this.onChange();
  }
}
