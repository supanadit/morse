import DOMPurify from 'dompurify';
import { Marked, type RendererObject, type TokenizerAndRendererExtension } from 'marked';
import { highlightCode } from './highlight';

/**
 * The TLDs a bare link may end in. `marked`'s GFM autolink only recognises a
 * scheme (`https://…`) or a `www.` prefix, so the way a link is usually pasted
 * into a chat — `github.com/owner/repo` — stayed dead text. A curated list is
 * what keeps the rule from inventing links out of filenames (`main.ts`,
 * `app.json`) and version numbers (`1.2.3`).
 */
const BARE_LINK_TLDS =
  'com|org|net|edu|gov|io|ai|dev|app|co|me|info|biz|xyz|online|site|tech|' +
  'store|blog|cloud|sh|gg|tv|fm|cc|to|so|id|my|sg|us|uk|de|fr|nl|ru|br|in|' +
  'au|ca|jp|cn|kr|it|es|se|no|fi|dk|pl|ch|at|be|cz|gr|pt|ro|tr|ua|news|page|' +
  'link|tools|wiki|zone|world|today|life|media|agency|digital|design|software|' +
  'systems|network|email|group|team|works|space|fun|games|shop|market|press|' +
  'host|web|art';

const BARE_DOMAIN =
  `(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${BARE_LINK_TLDS})` + `(?::\\d+)?(?:\\/[^\\s<>\"]*)?`;
/** A candidate at the current position, so the tokenizer never eats preceding text. */
const BARE_LINK = new RegExp(`^(${BARE_DOMAIN})`, 'i');
/**
 * A candidate preceded by whitespace or an opening bracket — never the tail of
 * an email (`a@b.com`) or of a longer word (`foo.example.com` is matched whole).
 */
const BARE_LINK_AT = new RegExp(`(^|[^\\w@/.-])(${BARE_DOMAIN})`, 'gi');

/**
 * Turns `github.com/owner/repo` into a link. The scheme is assumed to be HTTPS:
 * a bare host is what the author typed, and the modern default is the safe one.
 */
function bareAutolink(): TokenizerAndRendererExtension {
  return {
    name: 'bareAutolink',
    level: 'inline',
    start(src) {
      BARE_LINK_AT.lastIndex = 0;
      const match = BARE_LINK_AT.exec(src);
      return match ? match.index + match[1].length : undefined;
    },
    tokenizer(src) {
      const match = BARE_LINK.exec(src);
      if (!match) {
        return undefined;
      }
      const url = trimBareLinkTail(match[1]);
      if (url.length === 0) {
        return undefined;
      }
      return { type: 'bareAutolink', raw: url, href: `https://${url}`, text: url };
    },
    renderer(token) {
      const url = String(token['text'] ?? '');
      return (
        `<a href="${escapeHtml(String(token['href'] ?? ''))}" ` +
        `target="_blank" rel="noreferrer noopener">${escapeHtml(url)}</a>`
      );
    },
  };
}

/** Punctuation that ends the sentence, not the URL, stays out of the link. */
function trimBareLinkTail(url: string): string {
  let tail = url;
  for (;;) {
    const last = tail.slice(-1);
    if (!'.,;:!?)]'.includes(last)) {
      return tail;
    }
    if (last === ')' && count(tail, ')') <= count(tail, '(')) {
      return tail;
    }
    if (last === ']' && count(tail, ']') <= count(tail, '[')) {
      return tail;
    }
    tail = tail.slice(0, -1);
  }
}

function count(text: string, char: string): number {
  let total = 0;
  for (const candidate of text) {
    if (candidate === char) {
      total += 1;
    }
  }
  return total;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
marked.use({ renderer: renderer(), extensions: [bareAutolink()] });

// A user prompt keeps its line breaks (`breaks: true`), so a multi-line message
// reads the way it was typed instead of being reflowed into one paragraph.
const userMarked = new Marked({ gfm: true, breaks: true });
userMarked.use({ renderer: renderer(), extensions: [bareAutolink()] });

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
