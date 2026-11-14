/**
 * The narrow path/file resolver a store needs. An engine instance is the full
 * form; a store only ever asks for a file id's paths or its file, so it cannot
 * write an arbitrary path.
 */
import type { ConfigScope } from '@morse/protocol';

import type { ConfigFile } from '../core/config-file.js';
import type { ConfigPaths } from '../core/types.js';

export interface ConfigLocator {
  readonly ownership: 'user' | 'isolated';
  paths(fileId: string, scope: ConfigScope, cwd?: string): ConfigPaths;
  file(fileId: string, scope: ConfigScope, cwd?: string): ConfigFile;
}
