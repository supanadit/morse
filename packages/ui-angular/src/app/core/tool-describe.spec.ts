import { describe, expect, it } from 'vitest';
import type { ToolTranscriptItem } from '@morse/protocol';
import { toolChangedFile, toolFileName, toolGerund, toolKind, toolTitle, toolVerb } from './tool-describe';

function tool(name: string, title: string): ToolTranscriptItem {
  return { kind: 'tool', id: 't', at: 0, name, title, status: 'ok' };
}

describe('toolKind', () => {
  it('classifies the editor tools', () => {
    expect(toolKind('edit')).toBe('edit');
    expect(toolKind('write')).toBe('edit');
    expect(toolKind('str_replace_patch')).toBe('edit');
    expect(toolKind('read_file')).toBe('read');
    expect(toolKind('grep_search')).toBe('search');
    expect(toolKind('bash')).toBe('shell');
    expect(toolKind('mcp__something')).toBe('other');
  });
});

describe('toolTitle / toolFileName', () => {
  it('drops the `name: ` prefix pi adds, and only that prefix', () => {
    expect(toolTitle(tool('edit', 'edit: src/app.ts'))).toBe('src/app.ts');
    expect(toolTitle(tool('edit', 'something else'))).toBe('something else');
  });

  it('keeps the last segment of a path', () => {
    expect(toolFileName('src/app/file.ts')).toBe('file.ts');
    expect(toolFileName('C:\\work\\file.ts')).toBe('file.ts');
    expect(toolFileName('dir/')).toBe('dir');
  });
});

describe('verbs', () => {
  it('names the call the way the timeline and the status line each need it', () => {
    const edit = tool('edit', 'edit: notes.md');
    expect(toolVerb(edit)).toBe('Edit');
    expect(toolGerund(edit)).toBe('Editing');
    expect(toolGerund(tool('bash', 'bash: npm test'))).toBe('Running');
    expect(toolVerb(tool('mcp__x', 'mcp__x'))).toBe('mcp__x');
  });
});

describe('toolChangedFile', () => {
  it('is the edited path, and nothing for a read or a shell call', () => {
    expect(toolChangedFile(tool('edit', 'edit: src/app.ts'))).toBe('src/app.ts');
    expect(toolChangedFile(tool('read', 'read: src/app.ts'))).toBeNull();
    expect(toolChangedFile(tool('bash', 'bash: ls'))).toBeNull();
    // A tool that reported no path keeps its own name, which is not a file.
    expect(toolChangedFile(tool('edit', 'edit'))).toBeNull();
  });
});
