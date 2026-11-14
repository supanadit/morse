import type { ConfigScope } from '@morse/protocol';

/** Whether a wire value names one of the two config scopes. */
export function isConfigScope(value: unknown): value is ConfigScope {
  return value === 'global' || value === 'project';
}
