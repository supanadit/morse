/**
 * One engine context, resolved from the caller's roots and environment. XDG
 * variables win when set; an empty or absent variable falls back to the
 * documented defaults under the resolved home.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { EngineContext } from '../core/types.js';

export interface EngineContextInput {
  ownership?: 'user' | 'isolated';
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** An isolated instance's bot root. */
  root?: string;
}

export function resolveEngineContext(input: EngineContextInput = {}): EngineContext {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const context: EngineContext = {
    ownership: input.ownership ?? 'user',
    home,
    env,
    xdgConfigHome: nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, '.config'),
    xdgDataHome: nonEmpty(env.XDG_DATA_HOME) ?? join(home, '.local', 'share'),
  };
  if (input.cwd !== undefined) {
    context.cwd = input.cwd;
  }
  if (input.root !== undefined) {
    context.root = input.root;
  }
  return context;
}

/** An environment variable counts only when it has content. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}
