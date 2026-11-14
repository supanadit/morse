import { describe, expect, it } from 'vitest';
import { isConfigScope } from './scope.js';

describe('isConfigScope', () => {
  it('accepts the two scopes and nothing else', () => {
    expect(isConfigScope('global')).toBe(true);
    expect(isConfigScope('project')).toBe(true);
    expect(isConfigScope('user')).toBe(false);
    expect(isConfigScope(undefined)).toBe(false);
  });
});
