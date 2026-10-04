import DOMPurify from 'dompurify';
import { Marked, type RendererObject } from 'marked';
import { highlightCode } from './highlight';

/**
 * The custom renderer both Marked instances share: highlighted code blocks with
 * a copy button, and links that always open in a new tab.
 */
function renderer(): RendererObject {
  return {
    code({ text, lang }) {
      const { html, language } = highlightCode(text, lang ?? undefined);
      return (
        `<div class="code"><div class="code-head"><span class="code-lang">${language}</span>` +
        `<button type="button" class="copy" data-copy>Copy</button></div>` +
        `<pre><code class="hljs">${html}</code></pre></div>`
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
