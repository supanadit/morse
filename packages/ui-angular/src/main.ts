import { bootstrapApplication, createApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { DEFAULT_ROUTE, resolveAppRoute } from './app/routes';

/**
 * One bundle, several surfaces. The route table (`app/routes.ts`) maps a URL
 * hash to a component; the shell HTML ships `<app-root>` for the default chat
 * app, so that case bootstraps by selector. Any other route is bootstrapped into
 * an element created here, which is why a route component never has to match a
 * selector that exists in the HTML (the NG05104 blank-panel trap).
 *
 * The host sets the hash before this module runs (`renderWebviewHtml({ route })`).
 */
async function bootstrap(): Promise<void> {
  const route = resolveAppRoute(typeof location !== 'undefined' ? location.hash : '');
  const shell = typeof document !== 'undefined' ? document.querySelector('app-root') : null;

  if (route === DEFAULT_ROUTE && shell !== null) {
    await bootstrapApplication(route.component, appConfig);
    return;
  }

  const host = document.createElement('morse-route');
  shell?.remove();
  document.body.appendChild(host);
  const app = await createApplication(appConfig);
  app.bootstrap(route.component, host);
}

bootstrap().catch((error) => console.error(error));
