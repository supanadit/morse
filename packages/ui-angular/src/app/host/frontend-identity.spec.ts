import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FRONTEND_IDENTITY } from './morse.service';

/**
 * The handshake announces which bundle is talking, and the host logs it. The
 * version is a literal because the browser has nothing to read at runtime — so a
 * test reads it instead: a release bump that forgets this file would otherwise
 * leave the log claiming an older build.
 */

interface PackageManifest {
  name: string;
  version: string;
}

describe('frontend identity', () => {
  it('matches the package manifest it is compiled from', () => {
    // `fileURLToPath` rather than `new URL(...)`: the test bundler rewrites the
    // latter into an asset URL, which is not a file:// path.
    const manifestPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'package.json',
    );
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;

    expect(FRONTEND_IDENTITY).toEqual({ name: pkg.name, version: pkg.version });
  });
});
