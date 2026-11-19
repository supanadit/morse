/**
 * Which grammar a file gets: the path's extension picks a CodeMirror language,
 * and every grammar is its own lazy chunk — a reader who never opens a Rust
 * file never downloads the Rust parser.
 *
 * `@codemirror/language-data` is deliberately not used: it imports every
 * grammar package statically, which would put them all in one chunk.
 *
 * Two families are in use. A language with a real Lezer grammar (`lang-php`,
 * `lang-cpp`, `lang-<x>`) gets that; everything else comes from
 * `@codemirror/legacy-modes`, the CodeMirror 5 stream parsers, wrapped into a
 * language by `StreamLanguage`. A stream parser is line-at-a-time and knows no
 * syntax tree, so folding and sticky declarations simply do nothing in those
 * files — colour is what it buys, and it is worth more than plain text.
 */
import { LanguageSupport, StreamLanguage } from '@codemirror/language';

/** A grammar loaded on demand; resolves `null` when the file's language has none. */
export type GrammarLoader = () => Promise<LanguageSupport | null>;

/** A CodeMirror 5 stream parser, as `StreamLanguage.define` takes it. */
type StreamMode = Parameters<typeof StreamLanguage.define>[0];

/** The extension a path ends with, lowercased, without the dot; `''` for none or a dotfile. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The last path segment, lowercased: `Dockerfile` has no extension to go on. */
function filenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}

/** Wrap a legacy stream parser so the editor can install it like any grammar. */
function stream(load: () => Promise<StreamMode>): GrammarLoader {
  return () => load().then((mode) => new LanguageSupport(StreamLanguage.define(mode)));
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

const php: GrammarLoader = () => import('@codemirror/lang-php').then((m) => m.php());

const cpp: GrammarLoader = () => import('@codemirror/lang-cpp').then((m) => m.cpp());

// Dart and C# share one chunk: the CodeMirror 5 C-like mode holds both.
const dart = stream(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.dart));

const csharp = stream(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp));

const ruby = stream(() => import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby));

const swift = stream(() => import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift));

const shell = stream(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell));

const toml = stream(() => import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml));

const lua = stream(() => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua));

const dockerfile = stream(() =>
  import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile),
);

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
  php,
  php3: php,
  php4: php,
  php5: php,
  phtml: php,
  c: cpp,
  h: cpp,
  cc: cpp,
  cpp: cpp,
  cxx: cpp,
  hpp: cpp,
  hxx: cpp,
  hh: cpp,
  cs: csharp,
  dart,
  rb: ruby,
  rake: ruby,
  gemspec: ruby,
  swift,
  sh: shell,
  bash: shell,
  zsh: shell,
  ksh: shell,
  toml,
  lua,
};

/**
 * Files whose name, not their extension, says what they are — an exact name, or that
 * name plus a suffix: `Dockerfile`, `Dockerfile.dev` and `Dockerfile.prod` are one
 * language.
 */
const BY_FILENAME: Readonly<Record<string, GrammarLoader>> = {
  dockerfile: dockerfile,
  containerfile: dockerfile,
};

/** The lazy grammar for a path, or `null` when nothing covers its name. */
export function grammarFor(path: string): GrammarLoader | null {
  // An extension wins, so `dockerfile.js` stays JavaScript; the name is for a file
  // whose extension says nothing (`Dockerfile.dev`) or that has none (`Dockerfile`).
  const extension = extensionOf(path);
  const byExtension = extension === '' ? undefined : BY_EXTENSION[extension];
  if (byExtension !== undefined) {
    return byExtension;
  }
  const name = filenameOf(path);
  for (const [base, load] of Object.entries(BY_FILENAME)) {
    if (name === base || name.startsWith(`${base}.`)) {
      return load;
    }
  }
  return null;
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
