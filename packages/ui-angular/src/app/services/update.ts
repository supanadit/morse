import { InjectionToken, Injectable, effect, inject, signal } from '@angular/core';
import { MorseService } from '../host/morse.service';

/**
 * Where a newer release announces itself. One tag publishes both artifacts (the
 * VSIX and the npm package) with the same version, so reading the npm one covers
 * a Morse installed either way.
 */
export const LATEST_VERSION_URL = 'https://registry.npmjs.org/@supanadit/morse-web/latest';

/**
 * pi is not published in this repo, so its notice reads its own package. The
 * registry origin is the same one the Morse check already reaches, so a webview
 * CSP that allows this notice needs no extra origin for pi.
 */
export const PI_LATEST_VERSION_URL =
  'https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest';

/** Release notes for a version, so the notice can be a link rather than a number. */
export function releasePage(version: string): string {
  return `https://github.com/supanadit/morse/releases/tag/v${version}`;
}

/** Where pi's own "Update Available" block points. */
export const PI_CHANGELOG_URL = 'https://pi.dev/changelog';

export interface UpdateNotice {
  /** Which of the two notices this is, so the UI can label it. */
  product: 'morse' | 'pi';
  /** The build this host is serving — the number printed beside the notice. */
  current: string;
  latest: string;
  /** How *this* host gets a newer Morse, in the words its user expects. */
  hint: string;
  /** Where the release notes are. */
  url: string;
}

/**
 * Reads the published version. It is a seam because this is the only thing the
 * frontend ever fetches off-machine: a test replaces it, and so does a deployment
 * that has the check switched off.
 */
export type VersionLoader = (url: string) => Promise<unknown>;

export const UPDATE_LOADER = new InjectionToken<VersionLoader | undefined>('morse.update.loader', {
  providedIn: 'root',
  factory: (): VersionLoader | undefined => {
    // Bound: a detached `fetch` throws in browsers.
    const request = (globalThis as { fetch?: typeof fetch }).fetch;
    if (request === undefined) {
      return undefined;
    }
    const load = request.bind(globalThis);
    return async (url) => (await load(url, { headers: { accept: 'application/json' } })).json();
  },
});

/** The version out of a registry document, or nothing when the shape is not one. */
export function latestFromRegistry(payload: unknown): string | undefined {
  const document = payload as { version?: unknown } | null;
  return typeof document?.version === 'string' ? document.version : undefined;
}

/**
 * True when `latest` is a later release than `current`, comparing the numbers
 * first. A prerelease sorts before the release it leads to (`0.3.0-beta.1` is
 * older than `0.3.0`), and two prereleases compare as strings — npm's own
 * ordering is finer than a badge needs.
 */
export function isNewerRelease(latest: string, current: string): boolean {
  const release = parseRelease(latest);
  const running = parseRelease(current);
  if (release === undefined || running === undefined) {
    return false;
  }
  for (let index = 0; index < release.numbers.length; index += 1) {
    if (release.numbers[index] !== running.numbers[index]) {
      return release.numbers[index] > running.numbers[index];
    }
  }
  if (release.prerelease === running.prerelease) {
    return false;
  }
  if (release.prerelease === undefined) {
    return true;
  }
  if (running.prerelease === undefined) {
    return false;
  }
  return release.prerelease > running.prerelease;
}

/** How each host is updated, said the way that host's user can act on it. */
export function updateHint(hostKind: string, latest: string): string {
  return hostKind === 'vscode'
    ? `Update the Morse extension — VS Code does that on its own for a Marketplace install — or install the ${latest} VSIX and reload the window.`
    : `Run npm install -g @supanadit/morse-web@${latest}, then start the host again.`;
}

/**
 * pi is not this repo's package, so the notice only says what pi itself says:
 * `pi update`. A pi supplied by another package manager has to say so, because
 * `pi update` refuses to replace it.
 */
export function piUpdateHint(latest: string): string {
  return `Run \`pi update\` to get ${latest} — or, when another package manager supplied pi, update it there.`;
}

/**
 * `?newer=<version>` reviews the notice without publishing a release: the badge
 * has to be visible before it matters, and the registry cannot be asked to fake a
 * version. Review only, like `?boot=1`.
 */
function previewVersion(): string | undefined {
  if (typeof location === 'undefined') {
    return undefined;
  }
  const value = new URL(location.href, 'http://localhost/').searchParams.get('newer');
  return value !== null && value.length > 0 ? value : undefined;
}

/** `?newer-pi=<version>` reviews the pi notice the same way `?newer=` does. */
function previewPiVersion(): string | undefined {
  if (typeof location === 'undefined') {
    return undefined;
  }
  const value = new URL(location.href, 'http://localhost/').searchParams.get('newer-pi');
  return value !== null && value.length > 0 ? value : undefined;
}

function parseRelease(
  version: string,
): { numbers: [number, number, number]; prerelease?: string } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(version.trim());
  if (match === null) {
    return undefined;
  }
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4],
  };
}

/**
 * The "a newer Morse is out" notice.
 *
 * It runs once per load, and only when the host says it may
 * (`capabilities.updateCheck`) — a frontend does not decide for itself that it is
 * allowed to call the internet. The review-only `?newer=<version>` is the
 * exception, because it fetches nothing. Anything that goes wrong on the way
 * (offline, a proxy, a registry that answers a different shape) is silence: a
 * version nobody could fetch is never worth an error in the footer.
 */
@Injectable({ providedIn: 'root' })
export class UpdateCheck {
  private readonly morse = inject(MorseService);
  private readonly loader = inject(UPDATE_LOADER);
  private readonly notice = signal<UpdateNotice | undefined>(undefined);
  private readonly piNotice = signal<UpdateNotice | undefined>(undefined);
  private started = false;

  /** The newer Morse release, if there is one and the host allowed asking. */
  readonly available = this.notice.asReadonly();

  /** The newer pi release, when the host named its pi version. */
  readonly piAvailable = this.piNotice.asReadonly();

  constructor() {
    effect(() => {
      const capabilities = this.morse.capabilities();
      const allowed = capabilities?.updateCheck === true;
      const morsePreview = previewVersion();
      const piPreview = previewPiVersion();
      // The host decides whether the real check may run; a review-only query
      // (`?newer=`/`?newer-pi=`) fetches nothing, so it needs no permission —
      // and it runs only the product it previews, never a background fetch for
      // the other one.
      if (this.started || (!allowed && morsePreview === undefined && piPreview === undefined)) {
        return;
      }
      this.started = true;
      if (allowed || morsePreview !== undefined) {
        void this.check(this.morse.version(), capabilities?.hostKind ?? 'server');
      }
      if (allowed || piPreview !== undefined) {
        // pi is only checked when the host could read its installed version; a
        // host without one (or an install with no readable package.json) stays
        // quiet instead of guessing.
        if (capabilities?.piVersion !== undefined || piPreview !== undefined) {
          void this.checkPi(capabilities?.piVersion ?? '');
        }
      }
    });
  }

  /** Confirms a newer release and records it; a no-op everywhere else. */
  async check(current: string, hostKind: string, load = this.loader): Promise<void> {
    try {
      const latest =
        previewVersion() ??
        (load === undefined ? undefined : latestFromRegistry(await load(LATEST_VERSION_URL)));
      if (latest === undefined || !isNewerRelease(latest, current)) {
        return;
      }
      this.notice.set({
        product: 'morse',
        current,
        latest,
        hint: updateHint(hostKind, latest),
        url: releasePage(latest),
      });
    } catch {
      // Nothing to say, and nothing worth breaking: the footer stays as it was.
    }
  }

  /** The same check for pi, whose current version the host read from disk. */
  async checkPi(current: string, load = this.loader): Promise<void> {
    if (current.length === 0 && previewPiVersion() === undefined) {
      return;
    }
    try {
      const latest =
        previewPiVersion() ??
        (load === undefined ? undefined : latestFromRegistry(await load(PI_LATEST_VERSION_URL)));
      if (latest === undefined || !isNewerRelease(latest, current)) {
        return;
      }
      this.piNotice.set({
        product: 'pi',
        current,
        latest,
        hint: piUpdateHint(latest),
        url: PI_CHANGELOG_URL,
      });
    } catch {
      // Same silence as the Morse check.
    }
  }
}
