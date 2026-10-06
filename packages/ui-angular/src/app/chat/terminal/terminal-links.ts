import type { ILink, ILinkProvider, Terminal as XTermInstance } from '@xterm/xterm';

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

/**
 * Registers the link provider with an xterm instance. xterm calls it for the
 * hovered line; the match under the cursor is underlined and, on click or
 * Cmd/Ctrl-click, handed to `open`.
 */
export function registerTerminalLinks(term: XTermInstance, open: (url: string) => void): void {
  const provider: ILinkProvider = {
    provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const line = term.buffer.active.getLine(lineNumber - 1);
      if (line === undefined) {
        callback(undefined);
        return;
      }
      const links: ILink[] = findTerminalLinks(line.translateToString(true)).map((link) => ({
        text: link.url,
        range: {
          start: { x: link.start + 1, y: lineNumber },
          end: { x: link.start + link.url.length, y: lineNumber },
        },
        activate: () => open(link.url),
      }));
      callback(links.length > 0 ? links : undefined);
    },
  };
  term.registerLinkProvider(provider);
}
