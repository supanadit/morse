import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from 'node:events';
type Req = { headers: Record<string, unknown>; path: string; method?: string; body?: unknown };
type Res = { status(c: number): Res; set(n: string, v: string): Res; end(body?: string): void };
import { basicAuthMiddleware, hasSingleAuth, isAuthorized, SINGLE_AUTH_COOKIE } from './basic-auth.js';

function api(header?: string): { req: Request; res: Response; next: jest.Mock } {
  const req: Req = { headers: header === undefined ? {} : { authorization: header }, path: '/api/sessions' } as unknown as Req;
  const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), end: vi.fn() } as unknown as Res;
  const next = vi.fn();
  return { req, res, next };
}

function get(path: string): { req: Request; res: Response; next: jest.Mock } {
  const req: Req = { headers: {}, path, method: 'GET' } as unknown as Req;
  const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), end: vi.fn() } as unknown as Res;
  const next = vi.fn();
  return { req, res, next };
}

function endBody(res: Response): string | undefined {
  const end = (res as unknown as { end: jest.Mock }).end;
  return end.mock.calls[0]?.[0] as string | undefined;
}

describe('basicAuthMiddleware', () => {
  it('passes everything through when no password is configured', () => {
    const { req, res, next } = api('Basic ' + Buffer.from('u:wrong').toString('base64'));
    basicAuthMiddleware(undefined)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('accepts the right password and ignores the user name by default', () => {
    const { req, res, next } = api('Basic ' + Buffer.from('anyone:secret').toString('base64'));
    basicAuthMiddleware('secret', undefined)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('requires the user name when MORSE_AUTH_USERNAME is set', () => {
    const good = 'Basic ' + Buffer.from('alice:secret').toString('base64');
    const wrongUser = 'Basic ' + Buffer.from('bob:secret').toString('base64');
    for (const header of [good, wrongUser]) {
      const { req, res, next } = api(header);
      basicAuthMiddleware('secret', 'alice')(req, res, next);
      if (header === good) {
        expect(next).toHaveBeenCalled();
        expect(res.end).not.toHaveBeenCalled();
      } else {
        expect(next).not.toHaveBeenCalled();
        expect(res.end).toHaveBeenCalled();
      }
    }
  });

  it('rejects unauthenticated data routes with 401 JSON and no native prompt', () => {
    for (const path of ['/api/sessions', '/internal/metrics', '/ws']) {
      const { req, res, next } = get(path);
      basicAuthMiddleware('secret', undefined)(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(endBody(res)).toContain('Login required');
    }
    const { res } = api(undefined);
    const calls = (res.set as unknown as jest.Mock).mock.calls;
    expect(calls.some(([name]) => name === 'WWW-Authenticate')).toBe(false);
  });

  it('lets the bundle and the auth exchange through so the shared login page can render', () => {
    for (const path of ['/', '/index.html', '/main-abc123.js', '/assets/icon.svg', '/api/auth/status']) {
      const { req, res, next } = get(path);
      basicAuthMiddleware('secret', undefined)(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    }
  });

  it('never gates the CLI health probe or the bot bus', () => {
    for (const path of ['/api/health', '/internal/bot-bus/chat']) {
      const req: Req = { headers: {}, path } as unknown as Req;
      const res = { status: vi.fn(), end: vi.fn() } as unknown as Res;
      const next = vi.fn();
      basicAuthMiddleware('secret', undefined)(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    }
  });

  it('logs in with the password alone and accepts the minted cookie', async () => {
    const loginReq: Req = { headers: {}, path: '/api/auth/single-login', method: 'POST', body: { password: 'secret' } } as unknown as Req;
    const loginRes = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), end: vi.fn() } as unknown as Res;
    basicAuthMiddleware('secret', undefined)(loginReq, loginRes, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loginRes.status).toHaveBeenCalledWith(200);
    const setCookie = (loginRes.set as unknown as jest.Mock).mock.calls.find(([name]) => name === 'Set-Cookie')?.[1] as string;
    expect(setCookie).toContain(`${SINGLE_AUTH_COOKIE}=`);
    const cookie = setCookie.split(';')[0];
    const dataReq: Req = { headers: { cookie }, path: '/api/sessions' } as unknown as Req;
    const dataRes = { status: vi.fn(), set: vi.fn(), end: vi.fn() } as unknown as Res;
    const next = vi.fn();
    basicAuthMiddleware('secret', undefined)(dataReq, dataRes, next);
    expect(next).toHaveBeenCalled();
    expect(hasSingleAuth({ cookie }, 'secret')).toBe(true);
    expect(hasSingleAuth({ cookie }, 'wrong')).toBe(false);
    expect(isAuthorized({ headers: { cookie } }, 'secret')).toBe(true);
  });

  it('reads the login body off a real request stream', async () => {
    // The receiver matters: EventEmitter's `on` throws when called unbound.
    const stream = Object.assign(new EventEmitter(), {
      headers: {},
      path: '/api/auth/single-login',
      method: 'POST',
    });
    const req = stream as unknown as Req;
    const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), end: vi.fn() } as unknown as Res;
    basicAuthMiddleware('secret', undefined)(req as unknown as Request, res as unknown as Response, vi.fn());
    process.nextTick(() => {
      stream.emit('data', Buffer.from(JSON.stringify({ password: 'secret' })));
      stream.emit('end');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.set as unknown as jest.Mock).mock.calls.some(([name]) => name === 'Set-Cookie')).toBe(true);
  });

  it('rejects a wrong password with 401 JSON after a beat', async () => {
    const req: Req = { headers: {}, path: '/api/auth/single-login', method: 'POST', body: { password: 'nope' } } as unknown as Req;
    const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), end: vi.fn() } as unknown as Res;
    basicAuthMiddleware('secret', undefined)(req, res, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(endBody(res)).toContain('Wrong password');
  });

  it('requires the configured user name on the login endpoint too', async () => {
    const attempt = async (body: unknown): Promise<number> => {
      const req: Req = { headers: {}, path: '/api/auth/single-login', method: 'POST', body } as unknown as Req;
      const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), end: vi.fn() } as unknown as Res;
      basicAuthMiddleware('secret', 'alice')(req, res, vi.fn());
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return ((res.status as unknown as jest.Mock).mock.calls[0]?.[0] as number);
    };
    expect(await attempt({ password: 'secret', username: 'alice' })).toBe(200);
    expect(await attempt({ password: 'secret', username: 'bob' })).toBe(401);
  });
});

describe('isAuthorized', () => {
  it('mirrors the middleware for the WebSocket upgrade check', () => {
    const headers = { authorization: 'Basic ' + Buffer.from('u:secret').toString('base64') };
    expect(isAuthorized({ headers }, 'secret')).toBe(true);
    expect(isAuthorized({ headers }, 'secret', 'u')).toBe(true);
    expect(isAuthorized({ headers }, 'secret', 'admin')).toBe(false);
    expect(isAuthorized({ headers: {} }, 'secret')).toBe(false);
  });
});
