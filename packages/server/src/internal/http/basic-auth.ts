import { createHash, timingSafeEqual } from 'node:crypto';
import { DEFAULT_WS_PATH } from '@morse/protocol';

/** The slice of Express's req/res/next this middleware touches. */
interface AuthRequest {
  path: string;
  method?: string;
  body?: unknown;
  headers: Record<string, unknown>;
}
interface AuthResponse {
  status(code: number): AuthResponse;
  set(name: string, value: string): AuthResponse;
  end(body?: string): void;
}
type Next = () => void;

/**
 * Routes that stay open when `MORSE_AUTH_PASSWORD` is set. `/api/health` is the
 * CLI's liveness probe (`morse status`/`stop` must not need a password), and
 * `/internal/bot-bus` is a bot-engine endpoint that already authenticates with
 * its own loopback + bearer-token check.
 */
const OPEN_PATHS = ['/api/health', '/internal/bot-bus'];

/** Login/logout endpoints for the single-user login page (always open). */
const SINGLE_LOGIN_PATH = '/api/auth/single-login';
const SINGLE_LOGOUT_PATH = '/api/auth/single-logout';
/** The status the shared login page reads to decide whether to step aside. */
const SINGLE_STATUS_PATH = '/api/auth/status';

/** Data routes stay behind the password; everything else is the public bundle. */
function isGatedPath(path: string): boolean {
  if (path === DEFAULT_WS_PATH) {
    return true;
  }
  for (const prefix of ['/api', '/internal']) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Cookie carrying the single-user login. Its value is the sha256 of a fixed
 * prefix plus the password, so only someone who knows the password can mint
 * it — with no server-side session to store and nothing to migrate.
 */
export const SINGLE_AUTH_COOKIE = 'morse_single';
const SINGLE_AUTH_MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * Single-user gate (`MORSE_AUTH_PASSWORD`). The static frontend and the auth
 * exchange load openly so the shared login page can render; every data route
 * (`/api/*`, `/internal/*`, the WebSocket upgrade) needs the password instead.
 * A login mints a cookie and plain HTTP Basic keeps working beside it, so
 * scripts and `curl -u` behave as before. Failures are plain 401 JSON with no
 * `WWW-Authenticate` challenge, so the browser never shows its native prompt.
 */
export function basicAuthMiddleware(
  password: string | undefined,
  username: string | undefined,
) {
  return (request: AuthRequest, response: AuthResponse, next: Next): void => {
    const path = request.path;
    if (password === undefined || OPEN_PATHS.some((p) => path.startsWith(p))) {
      next();
      return;
    }
    if (path === SINGLE_LOGIN_PATH) {
      if (request.method === 'POST') {
        void singleLogin(request, response, password, username);
        return;
      }
      response.status(404).end();
      return;
    }
    if (path === SINGLE_LOGOUT_PATH) {
      clearSingleAuth(response);
      if (request.method === 'GET') {
        response.set('Location', '/').status(302).end();
        return;
      }
      if (request.method === 'POST') {
        json(response, 200, { ok: true });
        return;
      }
      response.status(404).end();
      return;
    }
    if (OPEN_PATHS.some((p) => path.startsWith(p)) || path === SINGLE_STATUS_PATH) {
      next();
      return;
    }
    // The bundle itself is public code (same as multi-user hosts, where no gate
    // runs at all): it boots, reads the status, and shows the shared login page
    // when the gate is on. Only data routes stay behind the password.
    if (!isGatedPath(path)) {
      next();
      return;
    }
    if (matchesBasic(request.headers.authorization, password, username) || hasSingleAuth(request.headers, password)) {
      next();
      return;
    }
    json(response, 401, { error: 'Login required.' });
  };
}

function decode(encoded: string): string | undefined {
  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

// Hash first: timingSafeEqual throws on length mismatch, and sha256 keeps
// the comparison constant-time without leaking the password length.
function sha(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function safeEqual(a: string, b: string): boolean {
  const left = sha(a);
  const right = sha(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `user:password` — the password must match; the user only when one is set. */
function matches(
  credentials: string | undefined,
  password: string,
  username: string | undefined,
): boolean {
  if (credentials === undefined) {
    return false;
  }
  const separator = credentials.indexOf(':');
  const givenUser = separator === -1 ? '' : credentials.slice(0, separator);
  const given = separator === -1 ? '' : credentials.slice(separator + 1);
  const userOk = username === undefined || safeEqual(givenUser, username);
  return userOk && safeEqual(given, password);
}

function matchesBasic(
  header: unknown,
  password: string,
  username: string | undefined,
): boolean {
  const [scheme, encoded] = String(header ?? '').split(' ');
  return scheme === 'Basic' && encoded !== undefined && matches(decode(encoded), password, username);
}

/** The same check the WebSocket gateway applies to its upgrade request. */
export function isAuthorized(
  request: { headers: Record<string, unknown> },
  password: string,
  username?: string,
): boolean {
  return matchesBasic(request.headers.authorization, password, username) || hasSingleAuth(request.headers, password);
}

function singleAuthToken(password: string): string {
  return createHash('sha256').update(`morse-single:${password}`).digest('hex');
}

function cookieOf(header: unknown, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : String(header ?? '');
  if (raw.length === 0) {
    return undefined;
  }
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index !== -1 && part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

/** True when the request carries the cookie minted by a successful login. */
export function hasSingleAuth(headers: Record<string, unknown>, password: string): boolean {
  const token = cookieOf(headers['cookie'] ?? headers['Cookie'], SINGLE_AUTH_COOKIE);
  return token !== undefined && safeEqual(token, singleAuthToken(password));
}

function singleAuthCookie(token: string): string {
  return `${SINGLE_AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SINGLE_AUTH_MAX_AGE_S}`;
}

function clearSingleAuth(response: AuthResponse): void {
  response.set('Set-Cookie', `${SINGLE_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function json(response: AuthResponse, code: number, payload: unknown): void {
  response.set('Content-Type', 'application/json').status(code).end(JSON.stringify(payload));
}

async function readJsonBody(request: AuthRequest): Promise<unknown> {
  if (request.body !== undefined) {
    return typeof request.body === 'string' && request.body.length > 0 ? JSON.parse(request.body) : request.body;
  }
  // Method calls, not a detached reference: EventEmitter's `on` needs its receiver.
  const stream = request as unknown as {
    on?: {
      (event: 'data', listener: (chunk: Buffer) => void): unknown;
      (event: 'end', listener: () => void): unknown;
      (event: 'error', listener: (error: unknown) => void): unknown;
    };
  };
  if (typeof stream.on !== 'function') {
    return undefined;
  }
  const text = await new Promise<string>((resolve, reject) => {
    let data = '';
    stream.on!('data', (chunk) => {
      data += String(chunk);
      if (data.length > 1_000_000) {
        reject(new Error('Body too large.'));
      }
    });
    stream.on!('end', () => resolve(data));
    stream.on!('error', (error) => reject(error instanceof Error ? error : new Error(String(error))));
  });
  return text.length > 0 ? JSON.parse(text) : undefined;
}

/** Verifies one login attempt: the password must match, the user only when one is set. */
async function singleLogin(
  request: AuthRequest,
  response: AuthResponse,
  password: string,
  username: string | undefined,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    json(response, 400, { error: 'Could not read the login.' });
    return;
  }
  const given = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const passwordOk = typeof given['password'] === 'string' && safeEqual(given['password'], password);
  const userOk = username === undefined || (typeof given['username'] === 'string' && safeEqual(given['username'], username));
  if (passwordOk && userOk) {
    response.set('Set-Cookie', singleAuthCookie(singleAuthToken(password)));
    json(response, 200, { ok: true });
    return;
  }
  // A beat against credential stuffing: every miss costs the same second.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  json(response, 401, { error: username === undefined ? 'Wrong password.' : 'Wrong username or password.' });
}
