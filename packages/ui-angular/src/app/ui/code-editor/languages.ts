/**
 * Which grammar a file gets: the path's extension picks a CodeMirror language,
 * and every grammar is its own lazy chunk — a reader who never opens a Rust
 * file never downloads the Rust parser.
 *
 * `@codemirror/language-data` is deliberately not used: it imports every
 * grammar package statically, which would put them all in one chunk.
 */
import type { LanguageSupport } from '@codemirror/language';

/** A grammar loaded on demand; resolves `null` when the file's language has none. */
export type GrammarLoader = () => Promise<LanguageSupport | null>;

/** The extension a path ends with, lowercased, without the dot; `''` for none or a dotfile. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const typescript: GrammarLoader = () =>
  import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true }));

const json: GrammarLoader = () => import('@codemirror/lang-json').then((m) => m.json());

const html: GrammarLoader = () => import('@codemirror/lang-html').then((m) => m.html());

const css: GrammarLoader = () => import('@codemirror/lang-css').then((m) => m.css());

const markdown: GrammarLoader = () => import('@codemirror/lang-markdown').then((m) => m.markdown());

const python: GrammarLoader = () => import('@codemirror/lang-python').then((m) => m.python());

const rust: GrammarLoader = () => import('@codemirror/lang-rust').then((m) => m.rust());

const go: GrammarLoader = () => import('@codemirror/lang-go').then((m) => m.go());

const java: GrammarLoader = () => import('@codemirror/lang-java').then((m) => m.java());

const sql: GrammarLoader = () => import('@codemirror/lang-sql').then((m) => m.sql());

const yaml: GrammarLoader = () => import('@codemirror/lang-yaml').then((m) => m.yaml());

const xml: GrammarLoader = () => import('@codemirror/lang-xml').then((m) => m.xml());

const BY_EXTENSION: Readonly<Record<string, GrammarLoader>> = {
  ts: typescript,
  tsx: typescript,
  js: typescript,
  jsx: typescript,
  mjs: typescript,
  cjs: typescript,
  json,
  html,
  htm: html,
  vue: html,
  svelte: html,
  css,
  scss: css,
  sass: css,
  less: css,
  md: markdown,
  mdx: markdown,
  py: python,
  rs: rust,
  go,
  java,
  kt: java,
  kts: java,
  sql,
  yaml,
  yml: yaml,
  xml,
  svg: xml,
  plist: xml,
};

/** The lazy grammar for a path, or `null` when nothing covers its extension. */
export function grammarFor(path: string): GrammarLoader | null {
  const extension = extensionOf(path);
  return extension === '' ? null : (BY_EXTENSION[extension] ?? null);
}

/**
 * Load a path's grammar, or `null` when it has none or the chunk failed to
 * arrive. A rejection is a file shown as plain text, never a blank pane.
 */
export async function loadLanguage(
  path: string,
  load: GrammarLoader | null = grammarFor(path),
): Promise<LanguageSupport | null> {
  if (load === null) {
    return null;
  }
  return load().catch(() => null);
}
