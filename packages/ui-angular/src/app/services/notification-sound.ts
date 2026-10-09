import { Injectable } from '@angular/core';
import { playChime } from './notification-channel';

/**
 * The audible half of a notification, as a dependency.
 *
 * `playChime` is a plain function because it is a thin wrap over Web Audio; this
 * service exists so the policy in `RunNotifier` can be tested with a stand-in,
 * without a real audio device or a global `AudioContext` (which jsdom does not
 * provide, and which the test builder cannot stub across module boundaries).
 */
@Injectable({ providedIn: 'root' })
export class NotificationSound {
  play(): void {
    playChime();
  }
}
