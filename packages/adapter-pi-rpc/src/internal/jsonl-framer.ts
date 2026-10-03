import { StringDecoder } from 'node:string_decoder';

/**
 * Strict JSONL framing for the pi RPC stream.
 *
 * The docs are explicit: split only on LF, strip an optional preceding CR, and
 * never use `readline` (it also splits on U+2028/U+2029, which are legal inside
 * JSON strings). `StringDecoder` keeps multi-byte UTF-8 sequences intact when a
 * chunk boundary falls inside a character.
 */
export class JsonlFramer {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const records: string[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = stripCarriageReturn(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        records.push(line);
      }
      newline = this.buffer.indexOf('\n');
    }
    return records;
  }

  /** Returns a trailing record that never got its LF, if any. */
  flush(): string | undefined {
    const rest = stripCarriageReturn(this.buffer + this.decoder.end());
    this.buffer = '';
    return rest.trim().length > 0 ? rest : undefined;
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
