// src-attributed unit coverage for src/oauth.ts (OAuthService/exchangeGoogle/createOAuthService).
// test/auth-oauth-wx.e2e.test.ts already exercises the Google exchange end-to-end, but through
// buildApp imported from '../dist/app.js' (compiled output) — vitest's v8 coverage provider only
// attributes coverage to src/*.ts when the module was loaded via vitest's own transform (same
// rationale as this task's other client-wrapper test files). This file imports OAuthService /
// createOAuthService directly from '../src/oauth.js' and stubs global fetch, so every branch of
// exchangeGoogle (including ones the e2e happy-path scenarios don't reach) gets attributed to src.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthService, OAuthError, createOAuthService } from '../src/oauth.js';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function textResp(body: string, status: number): Response {
  return new Response(body, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NW_OAUTH_GOOGLE_CLIENT_ID;
  delete process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET;
});

describe('OAuthService.supports', () => {
  it('true only for "google" when configured; false when unconfigured or for any other provider string', () => {
    const configured = new OAuthService({ google: { clientId: 'id', clientSecret: 'secret' } });
    expect(configured.supports('google')).toBe(true);
    expect(configured.supports('facebook')).toBe(false);

    const unconfigured = new OAuthService({});
    expect(unconfigured.supports('google')).toBe(false);
  });
});

describe('OAuthService.exchangeCode', () => {
  it('unsupported provider (outside the switch\'s "google" case) → OAuthError "unsupported provider: X"', async () => {
    const svc = new OAuthService({});
    await expect(svc.exchangeCode('facebook' as never, 'code', 'https://x')).rejects.toThrow(OAuthError);
    await expect(svc.exchangeCode('facebook' as never, 'code', 'https://x')).rejects.toThrow('unsupported provider: facebook');
  });

  it('provider="google" but not configured → OAuthError mentioning the missing env vars', async () => {
    const svc = new OAuthService({});
    await expect(svc.exchangeCode('google', 'code', 'https://x')).rejects.toThrow(OAuthError);
    await expect(svc.exchangeCode('google', 'code', 'https://x')).rejects.toThrow(/NW_OAUTH_GOOGLE_CLIENT_ID\/SECRET missing/);
  });

  it('provider="google" configured → delegates to exchangeGoogle and returns {sub, email}', async () => {
    const svc = new OAuthService({ google: { clientId: 'id', clientSecret: 'secret' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('oauth2.googleapis.com/token')) return jsonResp({ access_token: 'tok' });
        if (String(url).includes('googleapis.com/oauth2/v3/userinfo')) return jsonResp({ sub: 'sub-1', email: 'x@example.com' });
        throw new Error(`unexpected url ${url}`);
      }),
    );
    const r = await svc.exchangeCode('google', 'code-1', 'https://cb');
    expect(r).toEqual({ sub: 'sub-1', email: 'x@example.com' });
  });
});

describe('exchangeGoogle (via OAuthService.exchangeCode) — every failure branch', () => {
  const svc = () => new OAuthService({ google: { clientId: 'id', clientSecret: 'secret' } });

  it('token endpoint returns non-ok → OAuthError including status + response body text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResp('invalid_grant body', 400)));
    await expect(svc().exchangeCode('google', 'bad', 'https://cb')).rejects.toThrow(/Google token exchange failed \(400\): invalid_grant body/);
  });

  it('token endpoint ok but no access_token, with tokens.error set → OAuthError includes that error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResp({ error: 'invalid_grant' })));
    await expect(svc().exchangeCode('google', 'bad', 'https://cb')).rejects.toThrow(/Google token exchange: no access_token \(invalid_grant\)/);
  });

  it('token endpoint ok but no access_token AND no tokens.error → falls back to "unknown"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResp({})));
    await expect(svc().exchangeCode('google', 'bad', 'https://cb')).rejects.toThrow(/Google token exchange: no access_token \(unknown\)/);
  });

  it('userinfo endpoint returns non-ok → OAuthError including status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('token')) return jsonResp({ access_token: 'tok' });
        return textResp('forbidden', 403);
      }),
    );
    await expect(svc().exchangeCode('google', 'c', 'https://cb')).rejects.toThrow(/Google userinfo failed \(403\)/);
  });

  it('userinfo ok but missing sub → OAuthError "missing sub"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('token')) return jsonResp({ access_token: 'tok' });
        return jsonResp({ email: 'no-sub@example.com' });
      }),
    );
    await expect(svc().exchangeCode('google', 'c', 'https://cb')).rejects.toThrow(/Google userinfo: missing sub/);
  });

  it('success with no email in userinfo → {sub, email: undefined}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('token')) return jsonResp({ access_token: 'tok' });
        return jsonResp({ sub: 'sub-no-email' });
      }),
    );
    const r = await svc().exchangeCode('google', 'c', 'https://cb');
    expect(r).toEqual({ sub: 'sub-no-email', email: undefined });
  });

  it('the POST to the token endpoint carries code/client_id/client_secret/redirect_uri/grant_type as form-urlencoded', async () => {
    let capturedBody: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('token')) {
          capturedBody = init?.body as string;
          return jsonResp({ access_token: 'tok' });
        }
        return jsonResp({ sub: 'sub-x' });
      }),
    );
    await svc().exchangeCode('google', 'the-code', 'https://my-app/cb');
    const params = new URLSearchParams(capturedBody);
    expect(params.get('code')).toBe('the-code');
    expect(params.get('client_id')).toBe('id');
    expect(params.get('client_secret')).toBe('secret');
    expect(params.get('redirect_uri')).toBe('https://my-app/cb');
    expect(params.get('grant_type')).toBe('authorization_code');
  });
});

describe('OAuthError', () => {
  it('is a real Error subclass named "OAuthError" carrying the given message', () => {
    const e = new OAuthError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('OAuthError');
    expect(e.message).toBe('boom');
  });
});

describe('createOAuthService', () => {
  it('both env vars set → google config populated, supports("google")===true', () => {
    process.env.NW_OAUTH_GOOGLE_CLIENT_ID = 'env-id';
    process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET = 'env-secret';
    const svc = createOAuthService();
    expect(svc.supports('google')).toBe(true);
  });

  it('missing either env var → google not configured, supports("google")===false', () => {
    delete process.env.NW_OAUTH_GOOGLE_CLIENT_ID;
    delete process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET;
    expect(createOAuthService().supports('google')).toBe(false);

    process.env.NW_OAUTH_GOOGLE_CLIENT_ID = 'only-id';
    expect(createOAuthService().supports('google')).toBe(false);
  });
});
