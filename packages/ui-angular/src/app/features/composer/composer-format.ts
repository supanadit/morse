/** Composer-only command names and the figures its status row prints. */

/**
 * Built-ins pi only serves in its TUI. They are not in `get_commands` (pi would
 * not execute them over RPC), so the composer offers them itself and maps each
 * to the matching native action.
 */
export const BUILTIN_COMMANDS = [
  { name: 'model', description: 'Select a model' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Compact the current context (asks first)' },
  { name: 'settings', description: 'Open Morse settings' },
  { name: 'about', description: 'Credits and licences' },
  { name: 'keys', description: 'Keyboard shortcuts' },
] as const;

/** A prompt that is exactly one built-in command, e.g. `/compact`. */
export function builtinName(value: string): string | undefined {
  const match = /^\/([\w-]+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  return BUILTIN_COMMANDS.some((command) => command.name === match[1]) ? match[1] : undefined;
}

/**
 * `/compact <instructions>`: the command plus what to keep. The instructions are
 * forwarded to pi, so the user's words are not lost — only the *execution* waits
 * for the confirmation dialog, which is the same gate the bare command uses.
 */
export function compactInstructions(value: string): string | undefined {
  const match = /^\/compact\s+([\s\S]+)$/.exec(value);
  return match?.[1]?.trim() || undefined;
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/**
 * Output characters the agent has produced so far: assistant prose plus the
 * thinking it streamed. Both are generated tokens, so the rate must count both —
 * a reasoning model spends most of its output on thinking. Counting the whole
 * transcript (not just the item that is currently streaming) keeps the figure
 * monotonic while a turn moves from one assistant message to the next.
 */
export function outputChars(
  items: readonly { kind: string; text?: string; thinking?: string }[],
): number {
  let total = 0;
  for (const item of items) {
    if (item.kind === 'assistant') {
      total += (item.text ?? '').length + (item.thinking ?? '').length;
    }
  }
  return total;
}
