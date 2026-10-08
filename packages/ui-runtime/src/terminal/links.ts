/** A URL found in one rendered line, with the column it starts at (0-based). */
export interface TerminalLink {
  url: string;
  start: number;
}

/** What a line of terminal output can contain; the shell prints URLs as text. */
const URL_PATTERN = /(?:https?|file):\/\/[^\s"'`<>()[\]{}]+/g;

/** Trailing punctuation a sentence or log line puts after a URL, not part of it. */
const TRAILING = '.,;:!?)]}\'"';

/**
 * The URLs in one line of terminal output. xterm has no link detection of its
 * own, so this is what makes `http://localhost:5199/` clickable instead of
 * something the reader has to copy by hand.
 */
export function findTerminalLinks(text: string): TerminalLink[] {
  const links: TerminalLink[] = [];
  URL_PATTERN.lastIndex = 0;
  for (let match = URL_PATTERN.exec(text); match !== null; match = URL_PATTERN.exec(text)) {
    const url = trimTrailing(match[0]);
    if (url.length > 0) {
      links.push({ url, start: match.index });
    }
  }
  return links;
}

function trimTrailing(raw: string): string {
  let url = raw;
  while (url.length > 0 && TRAILING.includes(url[url.length - 1]!)) {
    url = url.slice(0, -1);
  }
  return url;
}
