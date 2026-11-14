/**
 * MCP server names are also JSON block keys, so they stay to the alphabet every
 * engine accepts and never collide with JavaScript's own object machinery.
 */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** Keys that would address an object's prototype rather than an entry. */
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

/** Whether an engine will accept `name` as an MCP server name. */
export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME.test(name) && !RESERVED.has(name);
}

/** The refusal every surface uses for an unusable name. */
export function invalidMcpServerNameMessage(name: string): string {
  return `"${name}" is not a valid MCP server name (letters, digits, "_" and "-").`;
}

/**
 * Refuse an unusable name. Stores report the same message as a `name` issue;
 * callers that would rather throw (a host command validating input) use this.
 */
export function assertMcpServerName(name: string): void {
  if (!isValidMcpServerName(name)) {
    throw new Error(invalidMcpServerNameMessage(name));
  }
}
