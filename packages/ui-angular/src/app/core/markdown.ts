import DOMPurify from 'dompurify';
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
import { Marked, type RendererObject } from 'marked';

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

const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'xml',
  svg: 'xml',
  md: 'markdown',
  yml: 'yaml',
};

/**
 * The custom renderer both Marked instances share: highlighted code blocks with
 * a copy button, and links that always open in a new tab.
 */
function renderer(): RendererObject {
  return {
    code({ text, lang }) {
      const requested = (lang ?? '').trim().toLowerCase();
      const language = ALIASES[requested] ?? requested;
      const known = language.length > 0 && hljs.getLanguage(language) !== undefined;
      const highlighted = known
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escapeHtml(text);
      const label = language.length > 0 ? language : 'text';
      return (
        `<div class="code"><div class="code-head"><span class="code-lang">${label}</span>` +
        `<button type="button" class="copy" data-copy>Copy</button></div>` +
        `<pre><code class="hljs">${highlighted}</code></pre></div>`
      );
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safeHref = href.replace(/"/g, '&quot;');
      const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
      return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noreferrer noopener">${text}</a>`;
    },
  };
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({ renderer: renderer() });

// A user prompt keeps its line breaks (`breaks: true`), so a multi-line message
// reads the way it was typed instead of being reflowed into one paragraph.
const userMarked = new Marked({ gfm: true, breaks: true });
userMarked.use({ renderer: renderer() });

const cache = new Map<string, string>();
const userCache = new Map<string, string>();
const CACHE_LIMIT = 200;

function sanitize(raw: string): string {
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'iframe'],
    ADD_ATTR: [
      'target',
      'rel',
      'data-copy',
      // The `@mention` chips `userMessageMarkdown()` injects.
      'data-mention-path',
      'data-mention-start',
      'data-mention-end',
    ],
  });
}

function cachedRender(store: Map<string, string>, instance: Marked, text: string): string {
  const cached = store.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const clean = sanitize(instance.parse(text, { async: false }) as string);
  if (store.size >= CACHE_LIMIT) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) {
      store.delete(oldest);
    }
  }
  store.set(text, clean);
  return clean;
}

/**
 * Model output is untrusted text: it can contain markdown, code, links and —
 * in theory — markup. Everything is rendered from HTML that DOMPurify cleaned,
 * and scripts are additionally blocked by the webview's CSP.
 */
export function renderMarkdown(text: string): string {
  return cachedRender(cache, marked, text);
}

/**
 * A user prompt as sanitised HTML: the same pipeline as the agent's output, but
 * with line breaks preserved and the `@mention` chip attributes kept. The text
 * passed in must be the output of `userMessageMarkdown()`.
 */
export function renderUserMarkdown(text: string): string {
  return cachedRender(userCache, userMarked, text);
}

/** Plain, escaped text for the places that must not render markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
