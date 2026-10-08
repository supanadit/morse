import { describe, expect, it } from 'vitest';
import { APP_ROUTES, DEFAULT_ROUTE, hashPath, resolveAppRoute } from './routes';

/**
 * The route table is what lets one bundle serve several surfaces (the chat app
 * plus any editor panel the host opens). These tests lock the parsing and the
 * fallback, which are the parts a new route row relies on.
 */
describe('app routes', () => {
  it('reads a path out of a hash, with or without a query', () => {
    expect(hashPath('#/mcp')).toBe('/mcp');
    expect(hashPath('#/mcp?server=1')).toBe('/mcp');
    expect(hashPath('#/')).toBe('/');
    expect(hashPath('')).toBe('/');
  });

  it('resolves a registered route and falls back to the chat app', () => {
    expect(resolveAppRoute('#/mcp')).toBe(APP_ROUTES[0]);
    expect(resolveAppRoute('#/not-a-route')).toBe(DEFAULT_ROUTE);
    expect(resolveAppRoute('')).toBe(DEFAULT_ROUTE);
  });

  it('resolves the code-split prompt editor route with a lazy loader', () => {
    const route = resolveAppRoute('#/prompts');
    expect(route.path).toBe('/prompts');
    expect(route.component).toBeUndefined();
    expect(route.load).toBeTypeOf('function');
  });

  it('resolves the code-split session route with a lazy loader', () => {
    const route = resolveAppRoute('#/session?id=s1');
    expect(route.path).toBe('/session');
    expect(route.component).toBeUndefined();
    expect(route.load).toBeTypeOf('function');
  });
});
