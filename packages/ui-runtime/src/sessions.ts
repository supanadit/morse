import type { SessionSummary } from '@morse/protocol';

/**
 * Reads the `sessions` array out of a host command's answer (`searchSessions`).
 * The frontend only offers a row it can open, so a malformed payload is treated
 * as "nothing found" rather than trusted field by field.
 */
export function asSessionSummaries(value: unknown): SessionSummary[] | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const sessions = (value as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) {
    return undefined;
  }
  return sessions.filter(isSessionSummary);
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const session = value as Record<string, unknown>;
  return (
    typeof session['id'] === 'string' &&
    typeof session['title'] === 'string' &&
    typeof session['cwd'] === 'string' &&
    typeof session['updatedAt'] === 'number' &&
    typeof session['messageCount'] === 'number'
  );
}
