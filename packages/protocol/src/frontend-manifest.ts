import type { FrontendIdentity } from './dto.js';
import { FRONTEND_MANIFEST_FILE, PROTOCOL_VERSION } from './version.js';

/**
 * A frontend build writes this next to its index.html. It is what makes the
 * frontend swappable without touching host code: the host reads the manifest,
 * checks `protocolVersion`, and serves whatever is in the directory.
 */
export interface FrontendManifest extends FrontendIdentity {
  protocolVersion: number;
  entry: string;
  generatedAt: string;
}

export function createFrontendManifest(input: {
  name: string;
  version: string;
  entry?: string;
  generatedAt?: string;
}): FrontendManifest {
  return {
    name: input.name,
    version: input.version,
    protocolVersion: PROTOCOL_VERSION,
    entry: input.entry ?? 'index.html',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

export function isFrontendManifest(value: unknown): value is FrontendManifest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof FrontendManifest, unknown>>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.version === 'string' &&
    typeof candidate.protocolVersion === 'number' &&
    typeof candidate.entry === 'string'
  );
}

export function parseFrontendManifest(raw: string | undefined | null): FrontendManifest | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isFrontendManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function frontendIdentity(manifest: FrontendManifest | undefined): FrontendIdentity | undefined {
  return manifest ? { name: manifest.name, version: manifest.version } : undefined;
}

export { FRONTEND_MANIFEST_FILE, PROTOCOL_VERSION };
