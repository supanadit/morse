/**
 * The agent vocabulary, as one import.
 *
 * The shapes live in `./agent/`, split by subject; this file exists so every
 * importer keeps saying `from './agent.js'`. Prefer the subject file directly from
 * new code.
 */
export * from './agent/index.js';
