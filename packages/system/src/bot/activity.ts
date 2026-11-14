/**
 * Turning what an engine reports into what a reader sees while it works.
 *
 * A bot conversation has no trace to scroll: the chat shows one line of presence
 * ("Reading launch-brief.md") where the answer will appear, and it is replaced as
 * the bot moves on and dropped when the answer lands. So this module's whole job
 * is wording — an engine names its tools and hands over raw JSON arguments, and
 * a reader should be told *what is being done to what*, in the bot's voice.
 *
 * Kept out of the service so it can be read and tested on its own: the mapping is
 * the only place a tool name becomes English, and it is deliberately forgiving —
 * extensions add tools Morse has never heard of, and an unknown one must still
 * produce a sentence rather than nothing.
 */

import type { AgentEvent } from '@morse/agent';
import type { BotActivity } from '@morse/protocol';

/**
 * What `activityForEvent` says: a new activity, `clear` when the answer arrived
 * (so the row goes), or nothing at all when the event says nothing about work in
 * progress (a state change, a ready report, a fatal error's own handling).
 */
export type ActivitySignal = BotActivity | 'clear' | undefined;

/** Before the engine has said anything: starting one can take seconds. */
const STARTING_LABEL = 'Getting started…';
/** An engine is working out what to do; thinking tokens included. */
const THINKING_LABEL = 'Wait, let me think…';
/** The answer itself is being written, so the row is about to become a message. */
const WRITING_LABEL = 'Writing the answer…';
/** A tool came back and the engine is deciding what to do with it. */
const REVIEWING_LABEL = 'Thinking it over…';

/**
 * The verb a reader expects for a tool. Extensions bring their own names, so the
 * table covers the common ones in both engines' vocabularies and every other tool
 * falls back to its own name ("Using memory_search …").
 */
const VERBS: Record<string, string> = {
  read: 'Reading',
  view: 'Reading',
  open: 'Reading',
  cat: 'Reading',
  write: 'Writing',
  create: 'Writing',
  edit: 'Editing',
  patch: 'Editing',
  apply_patch: 'Editing',
  multiedit: 'Editing',
  replace: 'Editing',
  bash: 'Running',
  shell: 'Running',
  sh: 'Running',
  exec: 'Running',
  execute: 'Running',
  run: 'Running',
  glob: 'Searching for',
  grep: 'Searching for',
  search: 'Searching for',
  ripgrep: 'Searching for',
  ls: 'Listing',
  list: 'Listing',
  tree: 'Listing',
  webfetch: 'Fetching',
  fetch: 'Fetching',
  websearch: 'Looking up',
  web_search: 'Looking up',
  task: 'Briefing a teammate',
  subagent: 'Briefing a teammate',
  todo_write: 'Planning',
  todowrite: 'Planning',
  todo_read: 'Checking the plan',
  todoread: 'Checking the plan',
};

/** Keys an engine uses for the thing being worked on, most specific first. */
const DETAIL_KEYS = [
  'path',
  'file_path',
  'filePath',
  'filepath',
  'file',
  'target',
  'command',
  'cmd',
  'pattern',
  'query',
  'url',
  'description',
] as const;

/** How much of a command or path a one-line presence can hold. */
const DETAIL_MAX = 72;

/**
 * One engine event, as the line a chat shows. `at` is the host's clock, so a
 * changed timestamp restarts the row's animation even when the words repeat.
 */
export function activityForEvent(event: AgentEvent, at: number): ActivitySignal {
  switch (event.type) {
    case 'agent/run-start':
      return { kind: 'thinking', label: THINKING_LABEL, at };
    case 'agent/delta':
      // Thinking and writing are both "the bot is busy", but a reader watching an
      // empty row for a long think deserves to be told which one it is.
      return event.channel === 'text'
        ? { kind: 'writing', label: WRITING_LABEL, at }
        : { kind: 'thinking', label: THINKING_LABEL, at };
    case 'agent/tool-start': {
      const described = describeTool(event.name, event.title, event.input);
      return { kind: 'tool', tool: described.tool, label: described.label, at };
    }
    case 'agent/tool-end':
      return { kind: 'thinking', label: REVIEWING_LABEL, at };
    case 'agent/message':
      // The answer is in: the row is what the message replaces, so it goes now
      // rather than blinking on until run-end.
      return 'clear';
    default:
      return undefined;
  }
}

/** The row a round starts with, before its engine has reported any work. */
export function startingActivity(at: number): BotActivity {
  return { kind: 'starting', label: STARTING_LABEL, at };
}

/**
 * A tool call as one phrase: "Reading launch-brief.md", "Running npm test".
 *
 * The engine's own `title` is the best source (pi builds "bash: <command>",
 * "read: <path>"), so it wins when it carries more than the bare tool name — and
 * its `<tool>: ` prefix is dropped, because the verb is spelled properly here.
 * Otherwise the raw arguments are probed for the usual keys, and a tool Morse has
 * never seen still reads as "Using <name>".
 */
export function describeTool(
  name: string,
  title?: string,
  input?: string,
): { tool: string; label: string } {
  const tool = name.trim() === '' ? 'tool' : name.trim();
  const verb = VERBS[tool.toLowerCase()];
  const detail = detailOf(tool, title) ?? detailOfInput(input);
  if (detail === undefined) {
    return { tool, label: verb === undefined ? `Using ${tool}…` : `${verb}…` };
  }
  return { tool, label: `${verb ?? `Using ${tool}`} ${detail}…` };
}

/** A `title` with the tool's own name stripped, when it says something more. */
function detailOf(tool: string, title: string | undefined): string | undefined {
  if (title === undefined) {
    return undefined;
  }
  const flat = oneLine(title);
  if (flat === '' || flat.toLowerCase() === tool.toLowerCase()) {
    return undefined;
  }
  const prefix = `${tool.toLowerCase()}:`;
  const stripped = flat.toLowerCase().startsWith(prefix) ? flat.slice(prefix.length).trim() : flat;
  return stripped === '' ? undefined : clip(stripped);
}

/** The usual argument keys, read out of the JSON an engine handed over. */
function detailOfInput(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return clip(oneLine(value));
    }
  }
  return undefined;
}

/** One line, because the row is a single line however long the command is. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clip(value: string): string {
  return value.length > DETAIL_MAX ? `${value.slice(0, DETAIL_MAX).trimEnd()}…` : value;
}
