/**
 * The domain layer, split by subject: models, attachments and usage counters,
 * sessions and projects, and the agent itself.
 *
 * Anemic shapes, value objects and the constants a caller needs. No I/O, no
 * ports, no framework imports (clean-architecture R2, R8). Re-exported whole by
 * `../domain.js`, so every existing `from '@morse/core'` import is unchanged.
 */
export * from './model.js';
export * from './usage.js';
export * from './session.js';
export * from './agent.js';
