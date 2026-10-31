/**
 * The harness contract: what any coding-agent engine must expose so that Morse can
 * drive it without knowing which one it is.
 *
 * This package has **no dependencies by design**. It must never import
 * `@morse/system` or any application symbol — a harness adapter depends on this
 * package alone, and the empty `dependencies` in `package.json` is what makes that
 * mechanical rather than a convention.
 *
 * Still to come in this package: `ports.ts` (AgentGateway, AgentGatewayFactory, …),
 * `session.ts` (abstract class Session) and `engine.ts` (abstract class SessionEngine).
 */
export * from './domain/index.js';
export * from './ports.js';
export * from './session.js';
export * from './engine.js';
