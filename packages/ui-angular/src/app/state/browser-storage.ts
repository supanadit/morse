/** Boolean preferences kept in `localStorage`; storage is a nicety, never a requirement. */
export function readFlag(key: string, fallback = false): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null || raw === undefined ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

export function storeFlag(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? '1' : '0');
  } catch {
    // The signal still holds the state; only the reload loses it.
  }
}
