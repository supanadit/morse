import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES, writeBotAttachments } from './attachments.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'morse-bot-attach-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Base64 of a short text file, the shape the wire carries. */
function payload(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('writeBotAttachments', () => {
  it('writes a file into the bot’s own uploads directory and names it relative', () => {
    const root = workspace();

    const written = writeBotAttachments(root, [
      { name: 'cv.pdf', mimeType: 'application/pdf', data: payload('%PDF-1.4 cv') },
    ]);

    expect(written).toEqual({ paths: ['uploads/cv.pdf'], failed: [] });
    expect(readFileSync(join(root, 'uploads', 'cv.pdf'), 'utf8')).toBe('%PDF-1.4 cv');
    // The path is relative because every bot's cwd is its own workspace.
    expect(written.paths[0]?.startsWith('/')).toBe(false);
  });

  it('keeps the tree private to the reader, since a bot’s data is the reader’s', () => {
    const root = workspace();
    writeBotAttachments(root, [{ name: 'a.txt', mimeType: 'text/plain', data: payload('a') }]);

    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'uploads')).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, 'uploads', 'a.txt')).mode & 0o777).toBe(0o600);
    }
  });

  it('never overwrites: a second file of the same name gets its own path', () => {
    const root = workspace();

    const first = writeBotAttachments(root, [
      { name: 'report.csv', mimeType: 'text/csv', data: payload('one') },
    ]);
    const second = writeBotAttachments(root, [
      { name: 'report.csv', mimeType: 'text/csv', data: payload('two') },
    ]);
    // Two attachments in one message must not collide either.
    const both = writeBotAttachments(root, [
      { name: 'notes.md', mimeType: 'text/markdown', data: payload('x') },
      { name: 'notes.md', mimeType: 'text/markdown', data: payload('y') },
    ]);

    expect(first.paths).toEqual(['uploads/report.csv']);
    expect(second.paths).toEqual(['uploads/report-1.csv']);
    expect(both.paths).toEqual(['uploads/notes.md', 'uploads/notes-1.md']);
    expect(readFileSync(join(root, 'uploads', 'report-1.csv'), 'utf8')).toBe('two');
  });

  it('keeps a file out of a directory of its own: an attachment is not a path instruction', () => {
    const root = workspace();

    const written = writeBotAttachments(root, [
      { name: '../../escape.sh', mimeType: 'text/plain', data: payload('rm -rf /') },
    ]);

    expect(written.paths).toEqual(['uploads/escape.sh']);
    expect(readdirSync(root)).toEqual(['uploads']);
    expect(readdirSync(join(root, 'uploads'))).toEqual(['escape.sh']);
  });

  it('reports a name that leaves nothing usable instead of inventing one', () => {
    const root = workspace();

    const written = writeBotAttachments(root, [
      { name: '...', mimeType: 'text/plain', data: payload('x') },
      { name: '', mimeType: 'text/plain', data: payload('y') },
    ]);

    expect(written.paths).toEqual([]);
    expect(written.failed).toEqual(['...', '']);
  });

  it('refuses an empty or oversized payload by name, and keeps the rest', () => {
    const root = workspace();
    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1).toString('base64');

    const written = writeBotAttachments(root, [
      { name: 'empty.txt', mimeType: 'text/plain', data: '' },
      { name: 'huge.bin', mimeType: 'application/octet-stream', data: huge },
      { name: 'fine.txt', mimeType: 'text/plain', data: payload('ok') },
    ]);

    expect(written.paths).toEqual(['uploads/fine.txt']);
    expect(written.failed).toEqual(['empty.txt', 'huge.bin']);
  });

  it('does nothing at all when nothing was attached', () => {
    const root = workspace();
    writeFileSync(join(root, 'keep.txt'), 'keep');

    expect(writeBotAttachments(root, [])).toEqual({ paths: [], failed: [] });
    // No `uploads/` directory for a message with no attachments.
    expect(readdirSync(root)).toEqual(['keep.txt']);
  });
});
