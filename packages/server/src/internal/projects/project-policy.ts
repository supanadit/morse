import { isAbsolute, resolve, sep } from 'node:path';
import type { ProjectPolicy } from '@morse/host-runtime';

/**
 * Which directories the server lets the agent work in.
 *
 * With `MORSE_PROJECTS` set, only those roots (and their subdirectories) are
 * allowed. Without it the host trusts the operator: any absolute path is
 * accepted, which is the right default for a server bound to 127.0.0.1 and for
 * the UI, which only offers discovered pi projects plus the default workspace.
 */
export class ServerProjectPolicy implements ProjectPolicy {
  private readonly roots: string[];

  constructor(roots: string[]) {
    this.roots = roots.filter((root) => root.trim().length > 0).map((root) => resolve(root));
  }

  get allowList(): string[] {
    return [...this.roots];
  }

  canOpen(path: string): boolean {
    if (!isAbsolute(path)) {
      return false;
    }
    if (this.roots.length === 0) {
      return true;
    }
    const target = resolve(path);
    return this.roots.some(
      (root) => target === root || target.startsWith(`${root}${sep}`),
    );
  }
}
