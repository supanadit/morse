import type {
  AssistantTranscriptItem,
  CompactionTranscriptItem,
  NoticeTranscriptItem,
  ToolTranscriptItem,
  TranscriptItem,
  UserTranscriptItem,
} from '@morse/protocol';

/**
 * One step of a turn: a tool call or a note the agent thought out loud.
 * Interleaving these in a single timeline is what makes a long turn readable —
 * you see the reasoning and the actions in the order they happened.
 */
export type ProcessStep =
  | { kind: 'tool'; key: string; item: ToolTranscriptItem }
  | { kind: 'thinking'; key: string; item: AssistantTranscriptItem };

export type TranscriptRow =
  | { kind: 'user'; key: string; item: UserTranscriptItem }
  | { kind: 'assistant'; key: string; item: AssistantTranscriptItem }
  | { kind: 'process'; key: string; steps: ProcessStep[] }
  | { kind: 'notice'; key: string; item: NoticeTranscriptItem }
  | { kind: 'compaction'; key: string; item: CompactionTranscriptItem };

/**
 * Turns the flat transcript into rows:
 *
 * - consecutive tool calls and thinking notes collapse into one `process` row,
 *   shown as a collapsible "Worked for 6s · 5 actions" timeline;
 * - assistant prose stays outside, so the answer is never buried in mechanics.
 */
export function groupTranscriptItems(items: TranscriptItem[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let pending: ProcessStep[] = [];

  const flush = (): void => {
    if (pending.length === 0) {
      return;
    }
    // Keyed by the group's first step, which is unique and stable while the
    // turn grows. Never fold the step count in: a changing key makes `@for`
    // tear the whole `morse-tool-group` down and rebuild it on every new tool
    // call, replaying the entrance animation from the top of the timeline.
    rows.push({
      kind: 'process',
      key: `process-${pending[0]?.key ?? rows.length}`,
      steps: pending,
    });
    pending = [];
  };

  for (const item of items) {
    if (item.kind === 'tool') {
      pending.push({ kind: 'tool', key: item.id, item });
      continue;
    }

    if (item.kind === 'assistant') {
      const thinking = item.thinking.trim();
      if (thinking.length > 0) {
        pending.push({ kind: 'thinking', key: `${item.id}:thinking`, item });
      }
      // While a note streams on its own, the thinking step is the live indicator.
      // Pushing an empty assistant row here would only add a stray caret below it.
      const hasProse = item.text.trim().length > 0;
      if (hasProse || (item.streaming && thinking.length === 0)) {
        flush();
        rows.push({ kind: 'assistant', key: item.id, item });
      } else if (thinking.length === 0) {
        flush();
      }
      continue;
    }

    flush();
    if (item.kind === 'user') {
      rows.push({ kind: 'user', key: item.id, item });
    } else if (item.kind === 'notice') {
      rows.push({ kind: 'notice', key: item.id, item });
    } else if (item.kind === 'compaction') {
      // A boundary in its own row, like pi's TUI: it closes the turn above it
      // and marks the point where the agent's context was summarized.
      rows.push({ kind: 'compaction', key: item.id, item });
    }
  }
  flush();

  return rows;
}

/**
 * Key of the newest process row, or `null` when there is none.
 *
 * The transcript keeps the live section open while a turn runs, so only this
 * timeline auto-expands: as soon as a newer section starts, the previous one is
 * collapsed instead of leaving a wall of open timelines behind.
 */
export function activeProcessKey(rows: readonly TranscriptRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === 'process') {
      return row.key;
    }
  }
  return null;
}

/** One slice of a user message: plain text, or an `@mention` rendered as a chip. */
export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; token: string; path: string; startLine?: number; endLine?: number };

const MENTION_TOKEN = /(^|\s)@([^\s:]+(?::\d+(?:-\d+)?)?)(?=$|\s)/g;

/**
 * Splits a user message into text and `@mention` segments without losing a
 * byte: concatenating every segment (chips included) reproduces the input.
 * This is what renders `@README.md` as a file chip (like the pi TUI does)
 * while the words around it stay ordinary text.
 */
export function splitMentionTokens(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  MENTION_TOKEN.lastIndex = 0;
  for (let match = MENTION_TOKEN.exec(text); match !== null; match = MENTION_TOKEN.exec(text)) {
    // The separator before the mention stays plain text; the chip itself
    // carries the `@`, like pi's TUI renders it.
    const separatorEnd = match.index + match[1].length;
    if (separatorEnd > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, separatorEnd) });
    }
    const token = `@${match[2]}`;
    const parsed = parseMentionToken(match[2] ?? '');
    if (parsed) {
      segments.push({ kind: 'mention', token, ...parsed });
    } else {
      segments.push({ kind: 'text', text: token });
    }
    cursor = MENTION_TOKEN.lastIndex;
  }
  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) });
  }
  return segments;
}

/** Parses `path`, `path:37`, or `path:37-52` (without the leading `@`). */
export function parseMentionToken(
  token: string,
): { path: string; startLine?: number; endLine?: number } | undefined {
  if (token.length === 0) {
    return undefined;
  }
  const colon = token.indexOf(':');
  if (colon === -1) {
    return { path: token };
  }
  const path = token.slice(0, colon);
  const range = token.slice(colon + 1);
  const match = /^(\d+)(?:-(\d+))?$/.exec(range);
  if (path.length === 0 || !match) {
    return undefined;
  }
  const startLine = Number(match[1]);
  const endLine = match[2] === undefined ? startLine : Number(match[2]);
  return { path, startLine, endLine };
}

/**
 * The markdown source for a user message: the prompt as typed, with every
 * `@mention` outside code replaced by an inline chip. `renderUserMarkdown()`
 * turns the result into sanitised HTML, so a fenced code block in a prompt
 * renders like the agent's own code while a file mention stays a clickable chip.
 *
 * A mention inside a fenced block or an inline code span is left alone — that is
 * code the user pasted, not a reference.
 */
export function userMessageMarkdown(text: string): string {
  let fence: string | undefined;
  return text
    .split('\n')
    .map((line) => {
      const opening = /^\s*(`{3,}|~{3,})/.exec(line);
      if (opening) {
        const marker = opening[1]?.charAt(0) ?? '';
        if (fence === undefined) {
          fence = marker;
        } else if (marker === fence) {
          fence = undefined;
        }
        return line;
      }
      return fence === undefined ? chipifyLine(line) : line;
    })
    .join('\n');
}

/** Chips the mentions on one line, leaving inline code spans untouched. */
function chipifyLine(line: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < line.length) {
    const tick = line.indexOf('`', cursor);
    if (tick === -1) {
      result += chipifyText(line.slice(cursor));
      break;
    }
    result += chipifyText(line.slice(cursor, tick));
    const close = line.indexOf('`', tick + 1);
    if (close === -1) {
      result += line.slice(tick);
      break;
    }
    result += line.slice(tick, close + 1);
    cursor = close + 1;
  }
  return result;
}

/** The chip HTML for every mention in a plain-text run. */
function chipifyText(text: string): string {
  return text.replace(MENTION_TOKEN, (match, separator: string, token: string) => {
    const parsed = parseMentionToken(token);
    if (!parsed) {
      return match;
    }
    const name = basename(parsed.path);
    const label =
      parsed.startLine === undefined
        ? `@${name}`
        : `@${name}:${parsed.startLine}-${parsed.endLine}`;
    const path = escapeHtml(parsed.path);
    const range =
      parsed.startLine === undefined
        ? ''
        : ` data-mention-start="${parsed.startLine}" data-mention-end="${parsed.endLine}"`;
    return (
      `${separator}<span class="mention" data-mention-path="${path}" title="${path}"${range}>` +
      `<span class="mention-label">${escapeHtml(label)}</span></span>`
    );
  });
}

/** File name of a mention path; a directory keeps its own name, not `''`. */
function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, '');
  const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return cut === -1 ? clean : clean.slice(cut + 1);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One chip's annotation, shortened for display: the first line only, cut to a
 * hint — the whole note lives in the chip's tooltip. `undefined` when there is
 * nothing, which keeps an `@if (pin.note)` call site plain.
 */
export function pinNoteHint(note: string | undefined, max = 26): string | undefined {
  if (note === undefined) {
    return undefined;
  }
  const [first = ''] = note.split('\n');
  if (first.length > max) {
    return `${first.slice(0, max)}…`;
  }
  return note.includes('\n') ? `${first}…` : first;
}
