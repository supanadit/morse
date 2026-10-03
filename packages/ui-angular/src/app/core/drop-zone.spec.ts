import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from './attachments';
import {
  DropZone,
  dropPaths,
  fileNameFrom,
  looksLikePath,
  parseDrop,
  relativeToWorkspace,
} from './drop-zone';
import { Uploader, type UploadReport } from './uploads';

/** Minimal `DataTransfer` double: jsdom has no DragEvent implementation. */
function transfer(data: Record<string, string>, files: File[] = [], types?: string[]): DataTransfer {
  return {
    files,
    types: types ?? [...Object.keys(data), ...(files.length > 0 ? ['Files'] : [])],
    getData: (key: string) => data[key] ?? '',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

function dragEvent(data: DataTransfer): DragEvent {
  return { dataTransfer: data, preventDefault: () => undefined } as unknown as DragEvent;
}

function imageFile(name = 'shot.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
}

describe('dropPaths', () => {
  it('reads a VS Code explorer drag (file:// URI list)', () => {
    const data = transfer({
      'text/uri-list': 'file:///home/dev/project/src/app.ts\n# comment',
    });

    expect(dropPaths(data)).toEqual(['/home/dev/project/src/app.ts']);
  });

  it('ignores a text selection and web URLs', () => {
    expect(dropPaths(transfer({ 'text/plain': 'some selected sentence' }))).toEqual([]);
    expect(dropPaths(transfer({ 'text/plain': 'https://example.com/file.ts' }))).toEqual([]);
  });

  it('keeps an absolute path dragged out of a terminal, deduplicated', () => {
    const data = transfer({ 'text/plain': '/tmp/a.log\n/tmp/a.log\nnot a path' });

    expect(dropPaths(data)).toEqual(['/tmp/a.log']);
  });
});

describe('relativeToWorkspace', () => {
  it('makes a mention read like the workspace does', () => {
    expect(relativeToWorkspace('/w/project/src/app.ts', '/w/project')).toBe('src/app.ts');
    expect(relativeToWorkspace('/elsewhere/app.ts', '/w/project')).toBe('/elsewhere/app.ts');
  });
});

describe('looksLikePath', () => {
  it('accepts absolute POSIX and Windows paths', () => {
    expect(looksLikePath('/tmp/file')).toBe(true);
    expect(looksLikePath('C:\\dev\\file.ts')).toBe(true);
    expect(looksLikePath('just words')).toBe(false);
  });
});

describe('DropZone', () => {
  let zone: DropZone;
  /** Swapped per test: a stub keeps the service out of the wire transport. */
  let uploads: { available: () => boolean; upload: (files: readonly File[]) => Promise<UploadReport> };

  // The service injects its store, so it comes from the injector like in the app.
  beforeEach(() => {
    uploads = {
      available: () => false,
      upload: async (files) => ({ added: [], failed: files.map((file) => file.name) }),
    };
    TestBed.configureTestingModule({
      providers: [
        DropZone,
        AttachmentStore,
        { provide: Uploader, useValue: uploads },
      ],
    });
    zone = TestBed.inject(DropZone);
  });

  it('highlights for a file drag and survives entering children', () => {
    const data = transfer({}, [imageFile()], ['Files']);

    zone.onDragEnter(dragEvent(data));
    expect(zone.active()).toBe(true);

    // Crossing into a child fires dragleave/dragenter; the counter keeps the
    // highlight steady instead of flickering.
    zone.onDragEnter(dragEvent(data));
    zone.onDragLeave();
    expect(zone.active()).toBe(true);

    zone.onDragLeave();
    expect(zone.active()).toBe(false);
  });

  it('highlights an external drag that only carries text/plain', () => {
    // A VS Code Source Control drag: its private types are hidden from the
    // webview, so `text/plain` is all that arrives.
    zone.onDragEnter(dragEvent(transfer({ 'text/plain': 'service.ts (Working Tree)' })));

    expect(zone.active()).toBe(true);
  });

  it('ignores a drag that started inside the chat (moving selected text)', () => {
    document.dispatchEvent(new Event('dragstart', { bubbles: true }));

    zone.onDragEnter(dragEvent(transfer({ 'text/plain': 'some selected sentence' })));

    expect(zone.active()).toBe(false);
    document.dispatchEvent(new Event('dragend', { bubbles: true }));
  });

  it('mentions a Source Control item that arrived as plain text', async () => {
    const attachments = TestBed.inject(AttachmentStore);

    await zone.onDrop(
      dragEvent(transfer({ 'text/plain': 'service.ts (Working Tree)' })),
      '/w/project',
    );

    expect(attachments.mentions()).toEqual(['service.ts']);
  });

  it('attaches images and turns paths into workspace-relative mentions', async () => {
    const attachments = TestBed.inject(AttachmentStore);
    const data = transfer(
      { 'text/uri-list': 'file:///w/project/src/app.ts' },
      [imageFile()],
      ['Files', 'text/uri-list'],
    );

    await zone.onDrop(dragEvent(data), '/w/project');

    expect(zone.active()).toBe(false);
    expect(attachments.images()).toHaveLength(1);
    expect(attachments.mentions()).toEqual(['src/app.ts']);
    expect(attachments.notice()?.text).toContain('1 image attached');
  });

  it('uploads a dropped File when the host can take it, and mentions the host path', async () => {
    // A browser File has no path; only a host that advertises `fileUpload` can
    // turn its bytes into a mention.
    uploads.available = () => true;
    uploads.upload = async (files) => ({
      added: files.map((file) => ({
        path: `.morse/uploads/${file.name}`,
        name: file.name,
        bytes: file.size,
      })),
      failed: [],
    });
    const attachments = TestBed.inject(AttachmentStore);
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    await zone.onDrop(dragEvent(transfer({}, [file], ['Files'])), '/w/project');

    expect(attachments.mentions()).toEqual(['.morse/uploads/notes.txt']);
  });
});

describe('parseDrop', () => {
  it('turns a Source Control label into a file name', () => {
    const entries = parseDrop(transfer({ 'text/plain': 'service.ts (Working Tree)' }));

    expect(entries.names).toEqual(['service.ts']);
    expect(entries.paths).toEqual([]);
  });

  it('reads a VS Code private URI list when the host exposes it', () => {
    const entries = parseDrop(
      transfer({ 'application/vnd.code.uri-list': '["file:///w/project/src/app.ts"]' }),
    );

    expect(entries.paths).toEqual(['/w/project/src/app.ts']);
  });

  it('reads the absolute path VS Code puts in text/plain for a resource drag', () => {
    const entries = parseDrop(
      transfer({ 'text/plain': '/home/dev/project/src/service.ts' }),
    );

    expect(entries.paths).toEqual(['/home/dev/project/src/service.ts']);
    expect(entries.names).toEqual([]);
  });

  it('splits several resources that VS Code joined with a space', () => {
    const entries = parseDrop(
      transfer({ 'text/plain': '/w/p/src/a.ts /w/p/src/b.ts' }),
    );

    expect(entries.paths).toEqual(['/w/p/src/a.ts', '/w/p/src/b.ts']);
  });

  it('keeps a space that is part of the path', () => {
    const entries = parseDrop(transfer({ 'text/plain': '/w/p/my file.ts' }));

    expect(entries.paths).toEqual(['/w/p/my file.ts']);
  });

  it('leaves a dragged code snippet alone', () => {
    const entries = parseDrop(
      transfer({ 'text/plain': 'export type PromptMode = "new" | "steer";\nconst x = 1;' }),
    );

    expect(entries.names).toEqual([]);
    expect(entries.paths).toEqual([]);
  });
});

describe('fileNameFrom', () => {
  it('accepts labels with and without a tree decoration', () => {
    expect(fileNameFrom('service.ts (Working Tree)')).toBe('service.ts');
    expect(fileNameFrom('src/app.ts')).toBe('src/app.ts');
  });

  it('rejects prose, paths with spaces and directories', () => {
    expect(fileNameFrom('some selected sentence')).toBeUndefined();
    expect(fileNameFrom('/tmp/my file.ts')).toBeUndefined();
    expect(fileNameFrom('src')).toBeUndefined();
  });
});

describe('AttachmentStore', () => {
  it('inlines an image without the data: prefix and clears it once taken', async () => {
    const store = new AttachmentStore();

    const report = await store.accept([imageFile()]);

    expect(report).toEqual({ attached: 1, skipped: [] });
    const [image] = store.images();
    expect(image?.mimeType).toBe('image/png');
    expect(image?.data.startsWith('data:')).toBe(false);
    expect(image?.data.length).toBeGreaterThan(0);

    expect(store.takeImages()).toHaveLength(1);
    expect(store.images()).toHaveLength(0);
  });

  it('reports files it cannot send instead of dropping them silently', async () => {
    const store = new AttachmentStore();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    const report = await store.accept([file]);

    expect(report.attached).toBe(0);
    expect(report.skipped).toEqual(['notes.txt']);
  });

  it('keeps mentions until the composer takes them', () => {
    const store = new AttachmentStore();
    store.addMentions(['src/app.ts', ' ', 'README.md']);

    expect(store.mentions()).toEqual(['src/app.ts', 'README.md']);
    expect(store.takeMentions()).toEqual(['src/app.ts', 'README.md']);
    expect(store.mentions()).toEqual([]);
  });
});
