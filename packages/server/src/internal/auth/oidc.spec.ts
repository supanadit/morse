import { describe, expect, it } from 'vitest';
import { buildLoginUrl, normalizeProfile, resolveEndpoints } from './oidc.js';
import { isOidcUsable } from '../../db/oidc-config.js';

const BASE = {
  enabled: true,
  displayName: 'Keycloak',
  scopes: 'openid profile email',
  allowSignup: true,
};

describe('generic OIDC provider', () => {
  it('starts a PKCE login against the configured endpoints', () => {
    const url = new URL(
      buildLoginUrl(
        { ...BASE, clientId: 'morse' },
        { authUrl: 'https://id.example.com/auth' },
        'https://morse.example.com/api/auth/oidc/callback',
        'state-1',
        'verifier-1',
      ),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('morse');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).not.toBe('verifier-1');
  });

  it('normalizes a userinfo answer into a linkable profile', () => {
    const profile = normalizeProfile(
      {
        sub: 'abc-123',
        email: 'Adit@Example.com',
        name: 'Adit Pratama',
        preferred_username: 'Adit Pratama!',
      },
      undefined,
      'https://id.example.com/userinfo',
    );
    expect(profile).toEqual({
      sub: 'abc-123',
      issuer: 'https://id.example.com/userinfo',
      email: 'adit@example.com',
      name: 'Adit Pratama',
      username: 'aditpratama',
    });
  });

  it('refuses a userinfo answer with no subject or email', () => {
    expect(() => normalizeProfile({ name: 'Nobody' }, undefined, 'https://id.example.com')).toThrow(
      /no user id/,
    );
    expect(() => normalizeProfile({ sub: 'x' }, undefined, 'https://id.example.com')).toThrow(
      /no email/,
    );
  });

  it('prefers explicit endpoints and needs the trio to be usable', async () => {
    const explicit = {
      ...BASE,
      authUrl: 'https://id.example.com/auth',
      tokenUrl: 'https://id.example.com/token',
      userinfoUrl: 'https://id.example.com/userinfo',
      clientId: 'morse',
    };
    await expect(resolveEndpoints(explicit)).resolves.toEqual({
      authUrl: 'https://id.example.com/auth',
      tokenUrl: 'https://id.example.com/token',
      userinfoUrl: 'https://id.example.com/userinfo',
      endSessionUrl: undefined,
    });
    expect(isOidcUsable(explicit)).toBe(true);
    expect(isOidcUsable({ ...BASE, clientId: 'morse' })).toBe(false);
    expect(isOidcUsable({ ...explicit, clientId: undefined })).toBe(false);
  });
});
