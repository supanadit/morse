import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { MorseService } from './morse.service';

/**
 * The host's workspace file list, fetched once and kept.
 *
 * It is requested as soon as a host that can list files is ready, not when the
 * picker opens: waiting for a workspace walk after a click is what makes a picker
 * feel broken, and the list is small enough to hold.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceFiles {
  private readonly morse = inject(MorseService);
  private readonly cache = signal<string[]>([]);
  private readonly loading = signal(false);
  private requested = false;
  /** The cwd the cached list belongs to; a global host can switch projects. */
  private loadedFor: string | undefined;

  readonly files = this.cache.asReadonly();
  readonly busy = this.loading.asReadonly();
  readonly available = computed(() => this.morse.capabilities()?.filePicker === true);

  constructor() {
    effect(() => {
      if (!this.available()) {
        return;
      }
      const cwd = this.morse.workspace().cwd;
      // The browser host is global: switching projects must not keep offering
      // the previous project's files to the `@` picker.
      this.ensureLoaded(this.loadedFor !== undefined && this.loadedFor !== cwd);
    });
  }

  /** Loads the list if it is missing or stale; safe to call repeatedly. */
  ensureLoaded(force = false): void {
    if (this.loading() || (this.requested && !force)) {
      return;
    }
    this.requested = true;
    const cwd = this.morse.workspace().cwd;
    this.loading.set(true);
    void this.morse.requestHostCommand('listFiles').then((data) => {
      this.loading.set(false);
      if (this.morse.workspace().cwd !== cwd) {
        // The project changed while this request was in flight; drop the stale
        // list and ask again for the directory the user is actually in.
        this.ensureLoaded(true);
        return;
      }
      this.loadedFor = cwd;
      const files = (data as { files?: unknown } | undefined)?.files;
      if (Array.isArray(files)) {
        this.cache.set(files.filter((file): file is string => typeof file === 'string'));
      }
    });
  }
}
