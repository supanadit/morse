/**
 * Morse itself: its own domain, its session index and its use cases.
 *
 * This package owns what is Morse's, as opposed to `@morse/agent`, which owns the
 * contract any harness implements. It may import `@morse/agent`; the reverse is
 * never allowed.
 */
export * from './domain/index.js';
export * from './session/record.js';
export * from './session/identity.js';
export * from './session/ports.js';
export * from './session/reconcile.js';
export * from './session/file-store.js';
export * from './session/agent-router.js';
export * from './session/service.js';
export * from './session/integration.js';

export * from './errors.js';
export * from './logger.js';

export * from './chat/service.js';
export * from './chat/ports.js';
export * from './context/ports.js';
export * from './context/selection-span.js';

export * from './host/index.js';
