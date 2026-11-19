import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { editorExtensions } from './editor-setup';
import { extensionOf, grammarFor, loadLanguage } from './languages';

describe('extensionOf', () => {
  it('lowercases the extension', () => expect(extensionOf('src/A.TSX')).toBe('tsx'));
  it('returns empty for a dotfile', () => expect(extensionOf('/repo/.env')).toBe(''));
  it('returns empty for an extensionless path', () => expect(extensionOf('/repo/Makefile')).toBe(''));
  it('reads the last dot only', () => expect(extensionOf('a.test.ts')).toBe('ts'));
});

describe('grammarFor', () => {
  it('maps a known extension', () => expect(grammarFor('a.rs')).not.toBeNull());
  it('returns null for an unknown one', () => expect(grammarFor('a.txt')).toBeNull());
  it('returns null for a dotfile', () => expect(grammarFor('.env')).toBeNull());
  it('maps PHP, with the extensions PHP actually ships under', () => {
    for (const path of ['a.php', 'b.phtml', 'c.php5']) {
      expect(grammarFor(path)).not.toBeNull();
    }
  });
  it('maps Dart', () => expect(grammarFor('lib/main.dart')).not.toBeNull());
  it('maps the C family onto one grammar', () => {
    for (const path of ['a.c', 'a.h', 'a.cpp', 'a.hpp', 'a.cc']) {
      expect(grammarFor(path)).not.toBeNull();
    }
  });
  it('maps a file whose name, not its extension, says what it is', () => {
    expect(grammarFor('Dockerfile')).not.toBeNull();
    expect(grammarFor('deploy/Dockerfile.dev')).not.toBeNull();
  });
  it('still refuses a name nothing covers', () => expect(grammarFor('LICENSE')).toBeNull());
});

describe('loadLanguage', () => {
  it('resolves a language for a mapped path', async () => {
    expect(await loadLanguage('a.py')).not.toBeNull();
  });
  it('resolves null for an unmapped path', async () => {
    expect(await loadLanguage('a.txt')).toBeNull();
  });
  it('resolves null when the loader rejects (Review Focus 1)', async () => {
    expect(await loadLanguage('a.rs', () => Promise.reject(new Error('offline')))).toBeNull();
  });
  it('loads every grammar it advertises', async () => {
    // A lazy import that no longer resolves is a file shown as plain text, so each
    // mapped extension is loaded once rather than trusted.
    const paths = [
      'a.php',
      'a.dart',
      'a.c',
      'a.cs',
      'a.rb',
      'a.swift',
      'a.sh',
      'a.toml',
      'a.lua',
      'Dockerfile',
    ];
    for (const path of paths) {
      expect(await loadLanguage(path), path).not.toBeNull();
    }
  });
});

describe('highlighting a file', () => {
  it('colours PHP and Dart through the editor’s own style', async () => {
    // A grammar is only worth its chunk if tokens reach the screen: a Lezer grammar
    // (PHP) and a CodeMirror 5 stream parser (Dart) both have to produce styled spans.
    for (const [path, doc, keyword] of [
      ['a.php', '<?php\nfunction greet() { return 1; }\n', 'function'],
      ['a.dart', 'void main() { final x = 1; }\n', 'void'],
    ] as const) {
      const language = await loadLanguage(path);
      expect(language, path).not.toBeNull();
      const view = new EditorView({
        parent: document.body,
        state: EditorState.create({ doc, extensions: [language!, editorExtensions()] }),
      });

      const tokens = [...view.dom.querySelectorAll('.cm-line span')].map(
        (span) => span.textContent ?? '',
      );
      expect(tokens, path).toContain(keyword);
      view.destroy();
    }
  });
});
