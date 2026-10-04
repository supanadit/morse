import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

for (const [name, language] of Object.entries({
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  markdown,
  php,
  python,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, language);
}

/** Short names people actually use (`sh`, `ts`, `yml`) mapped onto a registered language. */
const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  html: 'xml',
  svg: 'xml',
  md: 'markdown',
  yml: 'yaml',
};

/** Extension -> language, for a preview tab that only has a file name. */
const EXTENSIONS: Record<string, string> = {
  bash: 'bash',
  cjs: 'javascript',
  css: 'css',
  diff: 'diff',
  go: 'go',
  html: 'xml',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  patch: 'diff',
  php: 'php',
  py: 'python',
  sh: 'bash',
  svg: 'xml',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

export interface HighlightedCode {
  html: string;
  /** The language that was actually used, or `text` when the source was left plain. */
  language: string;
}

/**
 * The language a file name suggests, or `undefined` when nothing registered
 * matches. Deliberately extension-only: guessing inside a file is a slower,
 * less honest answer than the name the user is looking at.
 */
export function languageForPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()];
}

/**
 * Highlights a block of source. Unknown languages (and language-less blocks) are
 * escaped and left plain — the one instance of highlight.js that the markdown
 * renderer and the file preview share, so a language is registered once.
 */
export function highlightCode(text: string, lang?: string): HighlightedCode {
  const requested = (lang ?? '').trim().toLowerCase();
  const language = ALIASES[requested] ?? requested;
  const known = language.length > 0 && hljs.getLanguage(language) !== undefined;
  return known
    ? { html: hljs.highlight(text, { language, ignoreIllegals: true }).value, language }
    : { html: escapeHtml(text), language: 'text' };
}

/** Plain, escaped text for the places that must not render markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
