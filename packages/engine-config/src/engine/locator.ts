/**
 * The narrow path/file resolver a store needs. An engine instance is the full
 * form; a store only ever asks for a file id's paths or one file by path, so it
 * cannot write an arbitrary path. A chain may hold more than two files (an
 * ancestor or nested config), so every path is opened by path, not by scope.
 */
import type { ConfigScope } from '@morse/protocol';

import type { ConfigFile } from '../core/config-file.js';
import type { ConfigPaths } from '../core/types.js';

export interface ConfigLocator {
  readonly ownership: 'user' | 'isolated';
  paths(fileId: string, scope: ConfigScope, cwd?: string): ConfigPaths;
  file(fileId: string, scope: ConfigScope, cwd?: string): ConfigFile;
  fileAt(fileId: string, path: string, scope: ConfigScope): ConfigFile;
  scopeOf(fileId: string, path: string): ConfigScope;
}

/**
 * The typed refusal an isolated engine throws for a project scope. A store
 * turns exactly this error into an `unsupported` issue; any other thrown error
 * is a real read/write failure and is reported as one.
 */
export class UnsupportedScopeError extends Error {
  constructor(
    readonly fileId: string,
    readonly scope: ConfigScope,
    readonly path?: string,
    message?: string,
  ) {
    super(message ?? `The "${scope}" scope is unsupported for "${fileId}".`);
    this.name = 'UnsupportedScopeError';
  }
}
