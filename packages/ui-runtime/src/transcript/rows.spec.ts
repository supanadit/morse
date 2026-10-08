import { describe, expect, it } from 'vitest';
import type {
  AssistantTranscriptItem,
  CompactionTranscriptItem,
  ToolTranscriptItem,
  TranscriptItem,
} from '@morse/protocol';
import { activeProcessKey, groupTranscriptItems, parseMentionToken, pinNoteHint, splitMentionTokens, userMessageMarkdown } from './rows.js';

function tool(id: string, status: ToolTranscriptItem['status'] = 'ok'): ToolTranscriptItem {
  return { kind: 'tool', id, at: 0, name: 'read', title: `read: ${id}`, status };
}

function thinking(id: string): AssistantTranscriptItem {
  return { kind: 'assistant', id, at: 0, text: '', thinking: `note ${id}`, streaming: false };
}

function answer(id: string, streaming = false): AssistantTranscriptItem {
  return { kind: 'assistant', id, at: 0, text: `answer ${id}`, thinking: '', streaming };
}

/** A note that is still streaming, before the message has produced prose. */
function liveThinking(id: string): AssistantTranscriptItem {
  return { kind: 'assistant', id, at: 0, text: '', thinking: `note ${id}`, streaming: true };
}

describe('groupTranscriptItems', () => {
  it('collapses consecutive steps into one process row', () => {
    const rows = groupTranscriptItems([tool('a'), thinking('b'), tool('c')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('process');
    expect(rows[0]?.kind === 'process' ? rows[0].steps : []).toHaveLength(3);
  });

  it('splits sections that are separated by assistant prose', () => {
    const items: TranscriptItem[] = [tool('a'), answer('b'), tool('c'), answer('d')];
    const rows = groupTranscriptItems(items);
    expect(rows.map((row) => row.kind)).toEqual(['process', 'assistant', 'process', 'assistant']);
  });

  it('gives a compaction boundary its own row between the folded and kept turns', () => {
    const boundary: CompactionTranscriptItem = {
      kind: 'compaction',
      id: 'cmp-1',
      at: 42,
      summary: '## Summary',
      tokensBefore: 150_000,
    };
    const rows = groupTranscriptItems([tool('a'), answer('b'), boundary, tool('c')]);
    expect(rows.map((row) => row.kind)).toEqual(['process', 'assistant', 'compaction', 'process']);
    expect(rows[2]).toMatchObject({ kind: 'compaction', item: boundary });
  });

  it('keeps a process row key stable as the live group grows', () => {
    // Streaming appends steps one at a time. A key that changed with every new
    // tool call would make `@for` destroy and rebuild the timeline component,
    // replaying the entrance animation from the top (the reported glitch).
    const keyOf = (items: TranscriptItem[]): string => {
      const row = groupTranscriptItems(items)[0];
      if (row?.kind !== 'process') {
        throw new Error('expected a process row');
      }
      return row.key;
    };

    const first = keyOf([tool('a')]);
    expect(keyOf([tool('a'), tool('b')])).toBe(first);
    expect(keyOf([tool('a'), tool('b'), thinking('c'), tool('d')])).toBe(first);
  });

  it('does not add an empty assistant row while a note streams on its own', () => {
    // The thinking step is the live indicator; an assistant placeholder would
    // only render a stray caret below the note until the prose starts.
    const rows = groupTranscriptItems([liveThinking('a')]);
    expect(rows.map((row) => row.kind)).toEqual(['process']);
  });

  it('adds the assistant row once the streaming message has prose', () => {
    const rows = groupTranscriptItems([{ ...liveThinking('a'), text: 'hello' }]);
    expect(rows.map((row) => row.kind)).toEqual(['process', 'assistant']);
  });
});

describe('activeProcessKey', () => {
  it('is the newest process row, not the first', () => {
    const rows = groupTranscriptItems([tool('a'), answer('b'), tool('c'), thinking('d')]);
    const processKeys = rows.filter((row) => row.kind === 'process').map((row) => row.key);

    expect(processKeys).toHaveLength(2);
    expect(activeProcessKey(rows)).toBe(processKeys[1]);
  });

  it('is the last process row even when prose follows it', () => {
    const rows = groupTranscriptItems([tool('a'), answer('b'), tool('c'), answer('d', true)]);
    const processKeys = rows.filter((row) => row.kind === 'process').map((row) => row.key);

    expect(activeProcessKey(rows)).toBe(processKeys.at(-1));
  });

  it('is null when there is no process row at all', () => {
    const rows = groupTranscriptItems([answer('a')]);
    expect(activeProcessKey(rows)).toBeNull();
  });
});

describe('parseMentionToken', () => {
  it('parses a plain path (no range)', () => {
    expect(parseMentionToken('README.md')).toEqual({ path: 'README.md' });
  });

  it('parses a selection range like the pi mention syntax', () => {
    expect(parseMentionToken('src/app/chat/tool.ts:37-52')).toEqual({
      path: 'src/app/chat/tool.ts',
      startLine: 37,
      endLine: 52,
    });
  });

  it('parses a single line range into start and end', () => {
    expect(parseMentionToken('src/app.ts:9')).toEqual({ path: 'src/app.ts', startLine: 9, endLine: 9 });
  });

  it('rejects non line ranges so prose stays prose', () => {
    expect(parseMentionToken('readme:rug')).toBeUndefined();
    expect(parseMentionToken('')).toBeUndefined();
  });
});

describe('splitMentionTokens', () => {
  it('renders a mid-sentence mention as a chip and keeps the words around it', () => {
    const segments = splitMentionTokens('Bacakan @README.md dulu');
    expect(segments).toEqual([
      { kind: 'text', text: 'Bacakan ' },
      { kind: 'mention', token: '@README.md', path: 'README.md' },
      { kind: 'text', text: ' dulu' },
    ]);
  });

  it('carries selection ranges into mention chips', () => {
    const segments = splitMentionTokens('\n@packages/chat/tool.ts:37-52\n\nIni apa?');
    expect(segments.filter((segment) => segment.kind === 'mention')).toEqual([
      { kind: 'mention', token: '@packages/chat/tool.ts:37-52', path: 'packages/chat/tool.ts', startLine: 37, endLine: 52 },
    ]);
  });

  it('is lossless: joining segments reproduces the message', () => {
    const text = 'hey @tool.ts:3-5 and a lone @ symbol';
    const joined = splitMentionTokens(text)
      .map((segment) => (segment.kind === 'mention' ? segment.token : segment.text))
      .join('');
    expect(joined).toBe(text);
  });

  it('does not treat email-like text after a word as a mention', () => {
    const segments = splitMentionTokens('mail me user@example.com');
    expect(segments.every((segment) => segment.kind === 'text')).toBe(true);
  });
});

describe('userMessageMarkdown', () => {
  it('turns a prose mention into a clickable chip', () => {
    const markdown = userMessageMarkdown('Bacakan @README.md dulu');
    expect(markdown).toContain('Bacakan ');
    expect(markdown).toContain(' dulu');
    expect(markdown).toContain('data-mention-path="README.md"');
    expect(markdown).toContain('<span class="mention-label">@README.md</span>');
  });

  it('labels a directory mention by its own name, and keeps a line range', () => {
    expect(userMessageMarkdown('@docs/ isi apa')).toContain(
      '<span class="mention-label">@docs</span>',
    );
    const ranged = userMessageMarkdown('@src/chat/tool.ts:37-52');
    expect(ranged).toContain('data-mention-start="37" data-mention-end="52"');
    expect(ranged).toContain('@tool.ts:37-52');
  });

  it('leaves mentions inside a fenced code block alone', () => {
    const text = 'Contoh:\n```bash\n@echo hello\n```';
    expect(userMessageMarkdown(text)).toBe(text);
  });

  it('leaves mentions inside an inline code span alone', () => {
    expect(userMessageMarkdown('run `@README.md` now')).toBe('run `@README.md` now');
  });
});

describe('pinNoteHint', () => {
  it('is undefined without a note', () => {
    expect(pinNoteHint(undefined)).toBeUndefined();
  });

  it('keeps a short single-line note whole', () => {
    expect(pinNoteHint('fix the loop')).toBe('fix the loop');
  });

  it('cuts a long first line to the hint cap', () => {
    expect(pinNoteHint('a'.repeat(30))).toBe(`${'a'.repeat(26)}…`);
  });

  it('shows the first line and hints there is more', () => {
    expect(pinNoteHint('fix the loop\nand guard the empty case')).toBe('fix the loop…');
  });
});
