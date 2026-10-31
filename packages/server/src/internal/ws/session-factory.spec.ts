import { describe, expect, it } from 'vitest';
import { UnsupportedByHostError, type AgentExtras } from '@morse/system';
import { isLoopback, resolveMcpExtras, resolvePromptExtras } from './session-factory.service.js';

/**
 * The per-engine MCP resolution: the rule that keeps pi's and OpenCode's
 * servers from mixing. A command naming an engine gets that engine's port, one
 * naming none gets the default's, and a named engine without administration is
 * a refusal — never another engine's config.
 */
describe('resolveMcpExtras', () => {
  const mcpOf = (label: string) => ({
    configSignature: async () => label,
    status: async () => label,
    add: async () => label,
    remove: async () => label,
    setEnabled: async () => label,
    trustProject: async () => label,
  });
  const routerFor = (engines: Record<string, AgentExtras | undefined>, fallback = 'pi') => ({
    extrasFor: (kind: string) => engines[kind]?.mcp === undefined ? undefined : engines[kind],
    defaultExtras: () => engines[fallback],
  });
  const pi = { mcp: mcpOf('pi') } as unknown as AgentExtras;
  const openCode = { mcp: mcpOf('opencode') } as unknown as AgentExtras;
  const router = routerFor({ pi, opencode: openCode });

  it('resolves the engine a command names', async () => {
    await expect(resolveMcpExtras(router, 'pi').status()).resolves.toBe('pi');
    await expect(resolveMcpExtras(router, 'opencode').status()).resolves.toBe('opencode');
  });

  it('falls back to the default engine when none is named', async () => {
    await expect(resolveMcpExtras(router, undefined).status()).resolves.toBe('pi');
    await expect(resolveMcpExtras(router, '').status()).resolves.toBe('pi');
    await expect(resolveMcpExtras(router, 42).status()).resolves.toBe('pi');
  });

  it('refuses an unknown kind instead of falling back to another engine', () => {
    expect(() => resolveMcpExtras(router, 'codex')).toThrow(UnsupportedByHostError);
    expect(() => resolveMcpExtras(router, 'codex')).toThrow(/codex engine has no MCP/);
  });

  it('refuses a default engine without administration', () => {
    const bare = routerFor({ opencode: openCode }, 'none');
    expect(() => resolveMcpExtras(bare, undefined)).toThrow(/no MCP administration/);
  });
});

/**
 * The gate on `updateHost`. A `--lan` Morse serves an unauthenticated UI, so an
 * address this function lets through is an address that may run `npm install -g`
 * on the host. Every case below is a real spelling a socket can hand over.
 */
describe('isLoopback', () => {
  it('accepts the loopback spellings a socket actually uses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.0.0.5')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    // A dual-stack listener maps IPv4 callers into IPv6.
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
  });

  it('refuses a LAN or public address', () => {
    expect(isLoopback('192.168.1.20')).toBe(false);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback('::ffff:192.168.1.20')).toBe(false);
    expect(isLoopback('fe80::1')).toBe(false);
    expect(isLoopback('8.8.8.8')).toBe(false);
  });

  it('refuses an address it cannot see, rather than guessing', () => {
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback('')).toBe(false);
  });
});

/** The same rule set for the prompt-template port: named engine, default, refusal. */
describe('resolvePromptExtras', () => {
  const promptsOf = (label: string) => ({
    list: async () => label,
    save: async () => label,
    delete: async () => label,
  });
  const routerFor = (engines: Record<string, AgentExtras | undefined>, fallback = 'pi') => ({
    extrasFor: (kind: string) => engines[kind]?.prompts === undefined ? undefined : engines[kind],
    defaultExtras: () => engines[fallback],
  });
  const pi = { prompts: promptsOf('pi') } as unknown as AgentExtras;
  const openCode = { prompts: promptsOf('opencode') } as unknown as AgentExtras;
  const router = routerFor({ pi, opencode: openCode });

  it('resolves the engine a command names', async () => {
    await expect(resolvePromptExtras(router, 'pi').list('')).resolves.toBe('pi');
    await expect(resolvePromptExtras(router, 'opencode').list('')).resolves.toBe('opencode');
  });

  it('falls back to the default engine when none is named', async () => {
    await expect(resolvePromptExtras(router, undefined).list('')).resolves.toBe('pi');
    await expect(resolvePromptExtras(router, '').list('')).resolves.toBe('pi');
  });

  it('refuses an engine without prompt templates, never cross-reads', () => {
    const fileOnly = routerFor({ pi, opencode: { mcp: pi.mcp } as unknown as AgentExtras });
    expect(() => resolvePromptExtras(fileOnly, 'opencode')).toThrow(UnsupportedByHostError);
    expect(() => resolvePromptExtras(fileOnly, 'opencode')).toThrow(/opencode engine has no prompt templates/);
    expect(() => resolvePromptExtras(fileOnly, 'codex')).toThrow(/codex engine has no prompt templates/);
  });

  it('delete passes the source through', async () => {
    let seen: unknown;
    const router2 = {
      extrasFor: () => ({ prompts: { ...promptsOf('x'), delete: async (...args: unknown[]) => { seen = args; } } }),
      defaultExtras: () => undefined,
    };
    await resolvePromptExtras(router2, 'opencode').delete('n', 'global', '/w', 'config');
    expect(seen).toEqual(['n', 'global', '/w', 'config']);
  });
});
