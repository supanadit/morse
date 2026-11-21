/** The wire arguments every host command shares, read once. */

/** A string argument, or the empty string when the panel sent none. */
export function stringArg(args: Record<string, unknown> | undefined, key: string): string {
  const value = args?.[key];
  return typeof value === 'string' ? value : '';
}

/** A numeric argument, or 0 when the panel did not send one. */
export function numberArg(args: Record<string, unknown> | undefined, key: string): number {
  const value = args?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The scope a mutation edits, when the panel named one. */
export function mcpScope(
  args: Record<string, unknown> | undefined,
): 'global' | 'project' | undefined {
  return args?.scope === 'global' || args?.scope === 'project' ? args.scope : undefined;
}
