import type { ConfigScope } from '@morse/protocol';

/** Whether a wire value names one of the two config scopes. */
export function isConfigScope(value: unknown): value is ConfigScope {
  return value === 'global' || value === 'project';
}

/** A usable project cwd: trimmed, with an empty value meaning "no project". */
export function normalizeCwd(cwd: string | undefined): string | undefined {
  const trimmed = cwd?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}
