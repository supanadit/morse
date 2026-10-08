import { describe, expect, it } from 'vitest';
import { findTerminalLinks } from './links.js';

/**
 * xterm has no link detection, so this is what turns a dev-server banner into
 * something clickable. The parsing has to survive the punctuation a log line
 * puts after a URL, and find more than one on a line.
 */
describe('findTerminalLinks', () => {
  it('finds a localhost URL, as Vite prints it', () => {
    const line = '  ➜  Local:   http://localhost:5199/';
    expect(findTerminalLinks(line)).toEqual([
      { url: 'http://localhost:5199/', start: line.indexOf('http') },
    ]);
  });

  it('does not swallow trailing sentence punctuation', () => {
    expect(findTerminalLinks('see http://example.com/docs.')).toEqual([
      { url: 'http://example.com/docs', start: 4 },
    ]);
    expect(findTerminalLinks('(https://a.dev/x)')).toEqual([{ url: 'https://a.dev/x', start: 1 }]);
  });

  it('finds several links on one line, and file URLs', () => {
    expect(
      findTerminalLinks('api http://localhost:3000 web http://localhost:4200 file:///tmp/x.log').map(
        (link) => link.url,
      ),
    ).toEqual(['http://localhost:3000', 'http://localhost:4200', 'file:///tmp/x.log']);
  });

  it('stays quiet on a line with no URL', () => {
    expect(findTerminalLinks('ready in 200 ms')).toEqual([]);
    expect(findTerminalLinks('http://')).toEqual([]);
  });
});
