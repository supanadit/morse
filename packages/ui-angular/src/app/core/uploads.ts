import { Injectable, computed, inject } from '@angular/core';
import { readBase64 } from './attachments';
import { MorseService } from './morse.service';

/** Keep in sync with the server's `MAX_UPLOAD_BYTES`. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** One file the host stored on its disk, ready to `@mention`. */
export interface UploadedFile {
  /** cwd-relative (or absolute) path the agent can resolve. */
  path: string;
  name: string;
  bytes: number;
}

export interface UploadReport {
  added: UploadedFile[];
  /** Names of files that never made it; the caller turns these into a warning. */
  failed: string[];
}

/**
 * Sends a browser file to the host, because a browser cannot hand a dragged
 * file's path to pi. The host writes the bytes down and answers with a path the
 * composer turns into an `@mention` — the same reference a workspace picker or a
 * drop in VS Code produces.
 *
 * Availability is a capability, not a guess: a host that cannot write files
 * leaves `fileUpload` off, and callers fall back to the bare name.
 */
@Injectable({ providedIn: 'root' })
export class Uploader {
  private readonly morse = inject(MorseService);

  readonly available = computed(() => this.morse.capabilities()?.fileUpload === true);

  async upload(files: readonly File[]): Promise<UploadReport> {
    const added: UploadedFile[] = [];
    const failed: string[] = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        failed.push(file.name);
        continue;
      }
      const data = await readBase64(file);
      if (!data) {
        failed.push(file.name);
        continue;
      }
      const result = (await this.morse.requestHostCommand('uploadFile', {
        name: file.name,
        mimeType: file.type,
        data,
      })) as { path?: unknown; bytes?: unknown } | undefined;
      const path = typeof result?.path === 'string' ? result.path : undefined;
      if (!path) {
        failed.push(file.name);
        continue;
      }
      added.push({
        path,
        name: file.name,
        bytes: typeof result?.bytes === 'number' ? result.bytes : file.size,
      });
    }
    return { added, failed };
  }
}
