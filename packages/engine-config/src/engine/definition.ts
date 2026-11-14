/**
 * An engine's definition: what it is called and how to build one instance for
 * a context. The isolated form is the bot (and future Code Mode) case: a tree
 * Morse generated, with no user or project discovery.
 */
import type { EngineContext } from '../core/types.js';
import { resolveEngineContext } from './context.js';
import type { EngineInstance } from './instance.js';

export interface EngineInstanceOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export abstract class EngineDefinition {
  abstract readonly kind: string;

  /** The instance for one resolved context (the user's, a project's or an isolated tree's). */
  abstract create(context: EngineContext): EngineInstance;

  /** An instance over a generated root, owned by Morse rather than by the user. */
  isolated(root: string, options?: EngineInstanceOptions): EngineInstance {
    return this.create(
      resolveEngineContext({
        ownership: 'isolated',
        root,
        env: options?.env,
        home: options?.home,
      }),
    );
  }
}
