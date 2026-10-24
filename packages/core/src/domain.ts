/**
 * The domain layer, as one import.
 *
 * The shapes live in `./domain/`, split by subject; this file exists so every
 * importer keeps saying `from '../domain.js'` instead of learning the split.
 * Prefer importing the subject file directly from new code.
 */
export * from './domain/index.js';
