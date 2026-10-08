import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';

/**
 * The transport is provided by `MORSE_TRANSPORT` (see host/transport.token.ts):
 * VS Code webview bridge, WebSocket to the NestJS host, or the in-memory mock.
 * Nothing else in the app knows which host it runs in.
 */
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners()],
};
