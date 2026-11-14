import type { ConfigIssue, ConfigMutation } from '@morse/protocol';

/**
 * The config complaints a host attached to an answer, dropping anything of the
 * wrong shape: a malformed issue must not take a panel down with it. Both the
 * MCP and the prompt-template surfaces read the same `ConfigIssue`.
 */
export function asConfigIssues(value: unknown): ConfigIssue[] {
  return Array.isArray(value) ? value.filter(isConfigIssue) : [];
}

function isConfigIssue(value: unknown): value is ConfigIssue {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['file'] === 'string' &&
    typeof row['fileId'] === 'string' &&
    (row['scope'] === 'global' || row['scope'] === 'project') &&
    typeof row['code'] === 'string' &&
    typeof row['message'] === 'string' &&
    typeof row['fixable'] === 'boolean'
  );
}

/** A config mutation as a panel renders it: a refusal always says why. */
export function asConfigMutation(value: unknown): ConfigMutation {
  if (typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true) {
    const row = value as { path?: unknown; scope?: unknown; issues?: unknown };
    return {
      ok: true,
      ...(typeof row.path === 'string' ? { path: row.path } : {}),
      ...(row.scope === 'global' || row.scope === 'project' ? { scope: row.scope } : {}),
      issues: asConfigIssues(row.issues),
    };
  }
  const row = (typeof value === 'object' && value !== null ? value : undefined) as
    | { message?: unknown; path?: unknown; scope?: unknown; issues?: unknown }
    | undefined;
  return {
    ok: false,
    message: typeof row?.message === 'string' ? row.message : 'The host did not apply the change.',
    ...(typeof row?.path === 'string' ? { path: row.path } : {}),
    ...(row?.scope === 'global' || row?.scope === 'project' ? { scope: row.scope } : {}),
    issues: asConfigIssues(row?.issues),
  };
}
