import { describe, expect, it, vi } from "vitest";
type Req = { headers: Record<string, unknown>; path: string };
type Res = { status(c: number): unknown; set(n: string, v: string): unknown; end(): void };
import { basicAuthMiddleware, isAuthorized } from './basic-auth.js';

function pair(header?: string): { req: Request; res: Response; next: jest.Mock } {
  const req: Req = { headers: header === undefined ? {} : { authorization: header }, path: '/api/sessions' } as unknown as Req;
  const res: Res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), end: vi.fn() } as unknown as Res;
  const next = vi.fn();
  return { req, res, next };
}

describe('basicAuthMiddleware', () => {
  it('passes everything through when no password is configured', () => {
    const { req, res, next } = pair('Basic ' + Buffer.from('u:wrong').toString('base64'));
    basicAuthMiddleware(undefined)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('accepts the right password and ignores the user name by default', () => {
    const { req, res, next } = pair('Basic ' + Buffer.from('anyone:secret').toString('base64'));
    basicAuthMiddleware('secret', undefined)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('requires the user name when MORSE_AUTH_USERNAME is set', () => {
    const good = 'Basic ' + Buffer.from('alice:secret').toString('base64');
    const wrongUser = 'Basic ' + Buffer.from('bob:secret').toString('base64');
    for (const header of [good, wrongUser]) {
      const { req, res, next } = pair(header);
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

  it('challenges wrong or missing credentials with 401 + WWW-Authenticate', () => {
    for (const header of [undefined, 'Basic ' + Buffer.from('u:nope').toString('base64'), 'Bearer x']) {
      const { req, res, next } = pair(header);
      basicAuthMiddleware('secret', undefined)(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('Basic'));
    }
  });

  it('never challenges the CLI health probe or the bot bus', () => {
    for (const path of ['/api/health', '/internal/bot-bus/chat']) {
      const req: Req = { headers: {}, path } as unknown as Req;
      const res: Res = { status: vi.fn(), end: vi.fn() } as unknown as Res;
      const next = vi.fn();
      basicAuthMiddleware('secret', undefined)(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    }
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
