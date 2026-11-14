import { describe, expect, it } from 'vitest';
import { JsonFormat } from './json-format.js';

const format = new JsonFormat();

describe('JsonFormat', () => {
  it('parses strict JSON with strict true', () => {
    const result = format.parse('{"a":1}', '/x.json', 'config', 'global');
    expect(result.value).toEqual({ a: 1 });
    expect(result.strict).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('parses comments and trailing commas, marking them non-strict and fixable', () => {
    const result = format.parse(
      '{\n  // note\n  "a": 1,\n}\n',
      '/x.json',
      'config',
      'global',
    );
    expect(result.value).toEqual({ a: 1 });
    expect(result.strict).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: 'normalize', fixable: true, file: '/x.json' });
  });

  it('reports a syntax error with a line and a bounded snippet', () => {
    const result = format.parse('{\n  "a":\n}', '/x.json', 'config', 'global');
    expect(result.value).toBeUndefined();
    expect(result.issues[0]).toMatchObject({ code: 'parse', fixable: false });
    expect(result.issues[0].message).toContain('/x.json');
    expect(result.issues[0].snippet).toContain('"a":');
  });

  it('strips a leading byte-order mark and reads the file as strict JSON', () => {
    const result = format.parse('\uFEFF{"a": 1}\n', '/x.json', 'config', 'global');
    expect(result.value).toEqual({ a: 1 });
    expect(result.strict).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('serializes with two spaces and a trailing newline', () => {
    expect(format.serialize({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it('treats whitespace- and comment-only text as an empty document, not an error', () => {
    expect(format.parse(' \n\t', '/x.json', 'config', 'global')).toEqual({
      value: undefined,
      strict: true,
      issues: [],
    });
    expect(format.parse('// todo\n', '/x.json', 'config', 'global')).toEqual({
      value: undefined,
      strict: true,
      issues: [],
    });
  });
});
