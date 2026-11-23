/**
 * The harness contract: what any coding-agent engine must expose so that Morse can
 * drive it without knowing which one it is.
 *
 * This package has **no dependencies by design**. It must never import
 * `@morse/system` or any application symbol — a harness adapter depends on this
 * package alone. Hoisting in npm workspaces can hide a bad import, so
 * `scripts/check-agent-boundary.mjs` is the check that actually enforces this;
 * the empty `dependencies` in `package.json` is only the declaration.
 */
export * from './domain/index.js';
export * from './ports.js';
export * from './session.js';
export * from './engine.js';
