import type { ILink, ILinkProvider, Terminal as XTermInstance } from '@xterm/xterm';
import { findTerminalLinks } from '@morse/ui-runtime';

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
