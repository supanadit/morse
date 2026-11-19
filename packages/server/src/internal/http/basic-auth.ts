import { createHash, timingSafeEqual } from 'node:crypto';

/** The slice of Express's req/res/next this middleware touches. */
interface AuthRequest {
  path: string;
  headers: Record<string, unknown>;
}
interface AuthResponse {
  status(code: number): AuthResponse;
  set(name: string, value: string): AuthResponse;
  end(): void;
}
type Next = () => void;

/**
 * Routes that stay open when `MORSE_AUTH_PASSWORD` is set. `/api/health` is the
 * CLI's liveness probe (`morse status`/`stop` must not need a password), and
 * `/internal/bot-bus` is a bot-engine endpoint that already authenticates with
 * its own loopback + bearer-token check.
 */
const OPEN_PATHS = ['/api/health', '/internal/bot-bus'];

/**
 * HTTP Basic auth over every other route, including the static frontend. The
 * 401 carries `WWW-Authenticate: Basic`, so the browser shows its native login
 * prompt and then replays the same credentials on the same-origin WebSocket
 * upgrade — no frontend change needed. Comparison is timing-safe; the user
 * name is ignored, only the password gates.
 */
export function basicAuthMiddleware(
  password: string | undefined,
  username: string | undefined,
) {
  return (request: AuthRequest, response: AuthResponse, next: Next): void => {
    if (password === undefined || OPEN_PATHS.some((p) => request.path.startsWith(p))) {
      next();
      return;
    }
    const header = String(request.headers.authorization ?? '');
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded !== undefined && matches(decode(encoded), password, username)) {
      next();
      return;
    }
    response
      .status(401)
      .set('WWW-Authenticate', 'Basic realm="morse", charset="UTF-8"')
      .end();
  };
}

function decode(encoded: string): string | undefined {
  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
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
  // Hash first: timingSafeEqual throws on length mismatch, and sha256 keeps
  // the comparison constant-time without leaking the password length.
  const sha = (value: string): Buffer => createHash('sha256').update(value).digest();
  const userOk = username === undefined || timingSafeEqual(sha(givenUser), sha(username));
  return userOk && timingSafeEqual(sha(given), sha(password));
}

/** The same check the WebSocket gateway applies to its upgrade request. */
export function isAuthorized(
  request: { headers: Record<string, unknown> },
  password: string,
  username?: string,
): boolean {
  const header = String(request.headers.authorization ?? '');
  const [scheme, encoded] = header.split(' ');
  return scheme === 'Basic' && encoded !== undefined && matches(decode(encoded), password, username);
}
