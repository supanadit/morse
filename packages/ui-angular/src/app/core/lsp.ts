/**
 * Validating what a host answers for the four LSP commands.
 *
 * A `host/command` reply is `unknown` on the wire (`MorseService.requestHostCommand`
 * says why), and this is the only place that turns it into the protocol's shapes —
 * the same job `asGitStatus` does for the git panel. A host that is older than the
 * frontend, or one that answered `undefined` on a timeout, therefore reaches the
 * preview as "nothing to show" rather than as a half-read object.
 */
import type {
  LspDefinition,
  LspDiagnostic,
  LspDiagnostics,
  LspHover,
  LspLocation,
  LspPosition,
  LspRange,
  LspReferences,
  LspSeverity,
} from '@morse/protocol';

/** A position, or `undefined` when it is not one. */
export function asPosition(value: unknown): LspPosition | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const line = candidate['line'];
  const character = candidate['character'];
  if (!Number.isInteger(line) || !Number.isInteger(character)) {
    return undefined;
  }
  return { line: line as number, character: character as number };
}

export function asRange(value: unknown): LspRange | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const start = asPosition(candidate['start']);
  const end = asPosition(candidate['end']);
  return start === undefined || end === undefined ? undefined : { start, end };
}

/** The hover card's contents, or `undefined` when the answer carried none. */
export function asHover(value: unknown): LspHover | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const contents = candidate['contents'];
  if (typeof contents !== 'string' || contents.trim().length === 0) {
    return undefined;
  }
  const range = asRange(candidate['range']);
  return range === undefined ? { contents } : { contents, range };
}

/** Where a definition is, or `undefined` when the server found none. */
export function asLocation(value: unknown): LspLocation | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const path = candidate['path'];
  const range = asRange(candidate['range']);
  return typeof path === 'string' && path.length > 0 && range !== undefined
    ? { path, range }
    : undefined;
}

export function asReferences(value: unknown): LspReferences | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const path = candidate['path'];
  if (typeof path !== 'string') {
    return undefined;
  }
  const locations = Array.isArray(candidate['locations'])
    ? candidate['locations']
        .map(asLocation)
        .filter((location): location is LspLocation => location !== undefined)
    : [];
  return { path, locations };
}

/** A file's diagnostics, `available` included: it is the difference between
 * "no server covers this file" and "this file is clean". */
export function asDiagnostics(value: unknown): LspDiagnostics | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const path = candidate['path'];
  if (typeof path !== 'string') {
    return undefined;
  }
  const diagnostics = Array.isArray(candidate['diagnostics'])
    ? candidate['diagnostics']
        .map(asDiagnostic)
        .filter((item): item is LspDiagnostic => item !== undefined)
    : [];
  return { path, available: candidate['available'] === true, diagnostics };
}

function asDiagnostic(value: unknown): LspDiagnostic | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const range = asRange(candidate['range']);
  if (range === undefined) {
    return undefined;
  }
  const message = candidate['message'];
  const source = candidate['source'];
  const code = candidate['code'];
  return {
    range,
    severity: asSeverity(candidate['severity']),
    message: typeof message === 'string' ? message : '',
    ...(typeof source === 'string' ? { source } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

/**
 * How bad a problem is. The host maps LSP's numbers to these words, so an
 * unrecognised one is treated as the mildest rather than as an error: a squiggle
 * that claims too much is worse than one that claims too little.
 */
function asSeverity(value: unknown): LspSeverity {
  return value === 'error' || value === 'warning' || value === 'information' || value === 'hint'
    ? value
    : 'information';
}
