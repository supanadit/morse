/**
 * The delivery half of notifications: the browser's Notification API, its
 * permission, whether the window is even looking, and the audible chime.
 *
 * Nothing here knows about sessions or preferences — `RunNotifier` decides *when*
 * to say something and this file says it. Keeping the two apart is what lets the
 * policy live in `services/` without either side reaching into the other's job.
 */

/** The browser's answer for this origin, or `unsupported` when there is no API. */
export type NotificationPermissionState = NotificationPermission | 'unsupported';

function notificationApi(): typeof Notification | undefined {
  return (globalThis as { Notification?: typeof Notification }).Notification;
}

/** The API's answer for this origin, without asking for anything. */
export function readPermission(): NotificationPermissionState {
  const api = notificationApi();
  return api === undefined ? 'unsupported' : api.permission;
}

/** The Permission API's live status, where the browser implements it. */
function queryPermission(): Promise<PermissionStatus> | undefined {
  const permissions = (
    globalThis as {
      navigator?: {
        permissions?: { query?: (descriptor: { name: string }) => Promise<PermissionStatus> };
      };
    }
  ).navigator?.permissions;
  try {
    return permissions?.query?.({ name: 'notifications' });
  } catch {
    return undefined;
  }
}

/**
 * Re-reads the permission whenever the reader could have changed it: a focus or
 * visibility change, and the Permission API's own `onchange` where it exists.
 * Without this, turning notifications on and then resetting the permission left
 * the nudge gone for good while desktop notifications silently never arrived.
 *
 * Returns the disposer that takes the listeners back down.
 */
export function trackNotificationPermission(refresh: () => void): () => void {
  const doc = (globalThis as { document?: Document }).document;
  const win = globalThis as {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  doc?.addEventListener('visibilitychange', refresh);
  win.addEventListener?.('focus', refresh);
  void queryPermission()
    ?.then((status) => {
      status.onchange = refresh;
    })
    .catch(() => undefined);
  return () => {
    doc?.removeEventListener('visibilitychange', refresh);
    win.removeEventListener?.('focus', refresh);
  };
}

/** Whether the panel is on screen *and* focused — the answer is already visible. */
export function isWindowFocused(): boolean {
  const doc = (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    return true;
  }
  return !doc.hidden && doc.hasFocus();
}

/**
 * Asks the browser for permission. Called from a user gesture, which is what makes
 * the native prompt appear. `unsupported` means there is no API at all (the in-app
 * toast is then all there is); `denied` means the reader said no.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  const api = notificationApi();
  if (api === undefined) {
    return 'unsupported';
  }
  let permission = api.permission;
  if (permission === 'default') {
    try {
      permission = await api.requestPermission();
    } catch {
      permission = 'denied';
    }
  }
  return permission;
}

/**
 * Shows one desktop notification, when the browser is already willing. Synchronous
 * on purpose: the caller falls back to an in-app toast in the same turn it decided
 * there was nothing to send through, exactly as it did before delivery moved out
 * of `RunNotifier`.
 */
export function showWebNotification(body: string): boolean {
  const api = notificationApi();
  if (api === undefined || api.permission !== 'granted') {
    return false;
  }
  const notification = new api('Morse', { body });
  notification.onclick = () => {
    (globalThis as { focus?: () => void }).focus?.();
    notification.close();
  };
  return true;
}

/**
 * The audio context is created once and reused: browsers cap how many a page may
 * open, and a context resumed by the first chime stays usable for the rest.
 */
let audioContext: AudioContext | undefined;

function audioConstructor(): typeof AudioContext | undefined {
  const win = globalThis as { AudioContext?: typeof AudioContext };
  return win.AudioContext;
}

/**
 * Plays a short two-note chime, synthesized rather than shipped as a file so the
 * webview bundle carries no media asset and needs no MIME handling. Best-effort:
 * a host without Web Audio (or one that blocks it) simply stays silent, which is
 * exactly what the feature being off would sound like.
 */
export function playChime(): void {
  const Context = audioConstructor();
  if (Context === undefined) {
    return;
  }
  try {
    audioContext ??= new Context();
    const context = audioContext;
    // A context created before any user gesture starts suspended; resume it inside
    // the (asynchronous) delivery path so later chimes are not swallowed.
    void context.resume?.();
    const start = context.currentTime;
    for (const [offset, frequency] of [
      [0, 660],
      [0.16, 990],
    ] as const) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      const at = start + offset;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.16);
    }
  } catch {
    // An unavailable or restricted audio context must not break the notification.
  }
}
