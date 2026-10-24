/**
 * The harness contract's domain: model and thinking vocabulary, the working
 * directory, what a harness reports about itself, its conversation history and
 * the questions it asks.
 *
 * Shapes only — no I/O, no ports, no framework imports, and nothing from
 * `@morse/system`.
 */
export * from './model.js';
export * from './usage.js';
export * from './workspace.js';
export * from './agent/index.js';
