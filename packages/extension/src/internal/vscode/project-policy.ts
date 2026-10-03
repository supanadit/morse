import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ProjectPolicy } from '@morse/host-runtime';

/**
 * A local VS Code window already trusts whatever the user can open, so the
 * policy only rejects nonsense: relative paths and directories that do not exist.
 * The browser host's `ServerProjectPolicy` is the strict one (allow-list).
 */
export class VsCodeProjectPolicy implements ProjectPolicy {
  canOpen(path: string): boolean {
    if (!isAbsolute(path)) {
      return false;
    }
    try {
      return existsSync(path) && statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
}
