/**
 * A cheap poll over the `mcp.json` files pi reads, so the panel can react to a
 * change made outside Morse — a hand-edited config, `pi mcp add` in a terminal,
 * another window. `pi mcp list` is expensive (it dials every server), so the
 * watcher compares file signatures instead and only the reader's own store runs
 * the CLI, when it hears a signature moved.
 *
 * The watcher is ref-counted: it polls only while a controller is subscribed,
 * and it forgets every baseline when the last one leaves.
 */
export interface McpWatchOptions {
  /** The fingerprint of the files that decide this directory's servers. */
  signature: (cwd: string) => Promise<string>;
  /**
   * The project directories to watch, read every tick so a session opening (or
   * closing) is picked up without the watcher having to be told. The user-level
   * file (`''`) is always watched in addition.
   */
  cwds: () => readonly string[];
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 2_000;

export class McpWatcher {
  private readonly listeners = new Set<(cwd: string) => void>();
  /** Last seen signature per directory, including `''` for the user file. */
  private readonly signatures = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(private readonly options: McpWatchOptions) {}

  /**
   * Notifies with the directory whose config moved (`''` is the user-level file,
   * which every project inherits). The first observation of a directory only
   * records a baseline: opening a session is not a change.
   */
  subscribe(listener: (cwd: string) => void): () => void {
    this.listeners.add(listener);
    this.timer ??= setInterval(
      () => void this.poll(),
      this.options.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    // A watch must never be the reason the host stays alive on its own.
    (this.timer as { unref?: () => void }).unref?.();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer !== undefined) {
        clearInterval(this.timer);
        this.timer = undefined;
        this.signatures.clear();
      }
    };
  }

  private async poll(): Promise<void> {
    if (this.polling || this.listeners.size === 0) {
      return;
    }
    this.polling = true;
    try {
      const cwds = new Set(['', ...this.options.cwds()]);
      await Promise.all([...cwds].map((cwd) => this.check(cwd)));
    } catch {
      // A watcher must never take the host down; a bad tick is simply retried.
    } finally {
      this.polling = false;
    }
  }

  private async check(cwd: string): Promise<void> {
    let signature: string;
    try {
      signature = await this.options.signature(cwd);
    } catch {
      return;
    }
    const previous = this.signatures.get(cwd);
    this.signatures.set(cwd, signature);
    if (previous !== undefined && previous !== signature) {
      for (const listener of [...this.listeners]) {
        listener(cwd);
      }
    }
  }
}
