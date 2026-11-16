import { resolveEngineContext } from '@morse/engine-config';
import type { MorseLogger } from '@morse/system';

import { openCodeConfigSignature } from '../engine/config-discovery.js';
import type { OpenCodeApi } from './client.js';

/**
 * Guards the running OpenCode server against a config file that moved
 * underneath it.
 *
 * OpenCode watches its global and project `opencode.json[c]` files and reloads
 * them on its own, but when it notices is its own timing, not a guarantee about
 * what the next catalog read sees. `POST /api/location/reload` makes that
 * deterministic, and it is disruptive to a turn already in progress, so this
 * guard holds three rules:
 *
 * - the first signature a workspace sees is only seeded, never reloaded: the
 *   server already started from those files;
 * - a changed signature reloads only when this instance owns the server (a
 *   shared, attached server is somebody else's process) and no tracked session
 *   is streaming;
 * - a change that was skipped keeps the old signature, so the next idle call
 *   reloads then instead of forgetting it.
 */
export interface OpenCodeConfigGuardOptions {
  /** The client that can ask the server to reload: `post('/location/reload')`. */
  api: Pick<OpenCodeApi, 'post'>;
  logger: MorseLogger;
  /** True only when this instance started the server it drives. */
  owned: boolean;
  /** An injected app-level config directory, as the engine instance resolves it. */
  configDir?: string;
  /** The environment the server was started with; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
}

export class OpenCodeConfigGuard {
  /** The signature each workspace showed when it was last reloaded (or seeded). */
  private readonly signatures = new Map<string, string>();
  /** Sessions with a turn in progress: a reload waits for all of them. */
  private readonly streaming = new Set<string>();

  constructor(private readonly options: OpenCodeConfigGuardOptions) {}

  /** The fingerprint of every config file `cwd` reads right now. */
  signature(cwd: string): string {
    const context = resolveEngineContext({ env: this.options.env, cwd });
    return openCodeConfigSignature(context, this.options.configDir, cwd);
  }

  /**
   * Reload the server when `cwd`'s config changed since it was last seeded or
   * reloaded. Returns `true` exactly when a reload was posted; a seed, an
   * unchanged config, a streaming session and an attached server all resolve
   * `false` without posting. A failed reload also resolves `false` and leaves
   * the old signature in place, so a later call retries it.
   */
  async ensureFresh(cwd: string): Promise<boolean> {
    const current = this.signature(cwd);
    const previous = this.signatures.get(cwd);
    if (previous === undefined) {
      this.signatures.set(cwd, current);
      return false;
    }
    if (previous === current) {
      return false;
    }
    if (!this.options.owned) {
      this.options.logger.debug('Skipping an automatic OpenCode reload for an attached server.', {
        cwd,
      });
      return false;
    }
    if (this.streaming.size > 0) {
      this.options.logger.debug('Deferring an OpenCode config reload while a session streams.', {
        cwd,
        sessions: [...this.streaming],
      });
      return false;
    }
    if (!(await this.postReload(cwd))) {
      return false;
    }
    this.signatures.set(cwd, current);
    return true;
  }

  /**
   * Reload regardless of ownership or streaming: the explicit, user-asked-for
   * path. Clears every remembered signature, then seeds `cwd` anew so the
   * caller's own next `ensureFresh` does not reload a second time.
   */
  async reloadNow(cwd?: string): Promise<void> {
    await this.postReload(cwd);
    this.signatures.clear();
    if (cwd !== undefined) {
      this.signatures.set(cwd, this.signature(cwd));
    }
  }

  /** Track whether `sessionId` has a turn in progress. */
  setStreaming(sessionId: string, streaming: boolean): void {
    if (streaming) {
      this.streaming.add(sessionId);
    } else {
      this.streaming.delete(sessionId);
    }
  }

  /** Stop tracking a session; a disposed session never blocks a reload. */
  forget(sessionId: string): void {
    this.streaming.delete(sessionId);
  }

  /** One reload request; failures are logged, never thrown. */
  private async postReload(cwd: string | undefined): Promise<boolean> {
    try {
      await this.options.api.post('/location/reload');
    } catch (error: unknown) {
      this.options.logger.warn(
        'OpenCode could not reload its config; it may still serve the old files.',
        { cwd, error },
      );
      return false;
    }
    this.options.logger.info('Reloaded the OpenCode config.', { cwd });
    return true;
  }
}
