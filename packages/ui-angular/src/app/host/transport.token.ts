import { InjectionToken } from '@angular/core';
import { resolveTransport, type HostTransport } from '@morse/ui-runtime';

/**
 * Port (R2) owned by this frontend: where the host conversation comes from.
 * Tests and stories override it with `MemoryHostTransport`.
 */
export const MORSE_TRANSPORT = new InjectionToken<HostTransport>('morse.transport', {
  providedIn: 'root',
  factory: () => resolveTransport(),
});
