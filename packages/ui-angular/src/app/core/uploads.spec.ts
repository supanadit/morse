import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostCapabilities } from '@morse/protocol';
import { MorseService } from './morse.service';
import { MAX_UPLOAD_BYTES, Uploader } from './uploads';

function textFile(name: string, body = 'hello'): File {
  return new File([body], name, { type: 'text/plain' });
}

describe('Uploader', () => {
  let capabilities: ReturnType<typeof signal<HostCapabilities | undefined>>;
  let requestHostCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capabilities = signal<HostCapabilities | undefined>({ hostKind: 'server', fileUpload: true } as HostCapabilities);
    requestHostCommand = vi.fn(async () => ({ path: '.morse/uploads/notes.txt', bytes: 5 }));
    TestBed.configureTestingModule({
      providers: [
        Uploader,
        {
          provide: MorseService,
          useValue: { capabilities: capabilities.asReadonly(), requestHostCommand },
        },
      ],
    });
  });

  it('is available only when the host advertises fileUpload', () => {
    const uploader = TestBed.inject(Uploader);
    expect(uploader.available()).toBe(true);

    capabilities.set({ hostKind: 'vscode', fileUpload: false } as HostCapabilities);
    expect(uploader.available()).toBe(false);
  });

  it('uploads a file and returns the host path for an @mention', async () => {
    const uploader = TestBed.inject(Uploader);

    const report = await uploader.upload([textFile('notes.txt')]);

    expect(requestHostCommand).toHaveBeenCalledWith(
      'uploadFile',
      expect.objectContaining({ name: 'notes.txt', mimeType: 'text/plain' }),
    );
    expect(report.added[0]).toEqual({
      path: '.morse/uploads/notes.txt',
      name: 'notes.txt',
      bytes: 5,
    });
    expect(report.failed).toEqual([]);
  });

  it('refuses an oversized file without a round trip', async () => {
    const uploader = TestBed.inject(Uploader);
    const big = textFile('big.bin');
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 });

    const report = await uploader.upload([big]);

    expect(requestHostCommand).not.toHaveBeenCalled();
    expect(report.added).toEqual([]);
    expect(report.failed).toEqual(['big.bin']);
  });

  it('reports a file the host would not store', async () => {
    requestHostCommand.mockResolvedValueOnce(undefined);
    const uploader = TestBed.inject(Uploader);

    const report = await uploader.upload([textFile('notes.txt')]);

    expect(report.added).toEqual([]);
    expect(report.failed).toEqual(['notes.txt']);
  });
});
