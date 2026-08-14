// Unit coverage for src/accounts/wxAuth.ts (exchangeWxCode). No Mongo, no app — pure function with a
// stubbed global fetch, same mocking convention as auth-oauth-wx.e2e.test.ts's mockGoogleFetch.
//
// Why this file exists: test/auth-oauth-wx.e2e.test.ts exercises the dev-mode branch of this function
// indirectly through POST /auth/wx, but imports `buildApp` from '../dist/app.js' (v8 coverage doesn't
// attribute dist-loaded execution back to src), and it never configures NW_WX_APPID/NW_WX_SECRET, so the
// real jscode2session HTTP branch (success + failure) has never run against src/accounts/wxAuth.ts at all.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeWxCode } from '../src/accounts/wxAuth.js';

const ORIGINAL_APPID = process.env.NW_WX_APPID;
const ORIGINAL_SECRET = process.env.NW_WX_SECRET;

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_APPID === undefined) delete process.env.NW_WX_APPID; else process.env.NW_WX_APPID = ORIGINAL_APPID;
  if (ORIGINAL_SECRET === undefined) delete process.env.NW_WX_SECRET; else process.env.NW_WX_SECRET = ORIGINAL_SECRET;
});

describe('exchangeWxCode', () => {
  it('dev mode (NW_WX_APPID/NW_WX_SECRET unset): returns the code verbatim as a "dev-openid:" prefixed value, no fetch call', async () => {
    delete process.env.NW_WX_APPID;
    delete process.env.NW_WX_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const openid = await exchangeWxCode('raw-code-123');
    expect(openid).toBe('dev-openid:raw-code-123');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dev mode when only NW_WX_APPID is set (secret still missing) is still dev mode', async () => {
    process.env.NW_WX_APPID = 'appid-only';
    delete process.env.NW_WX_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const openid = await exchangeWxCode('code-x');
    expect(openid).toBe('dev-openid:code-x');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('configured (appid+secret set): calls the real jscode2session endpoint with the expected query params, returns openid', async () => {
    process.env.NW_WX_APPID = 'my-appid';
    process.env.NW_WX_SECRET = 'my-secret';
    const fetchMock = vi.fn(async (url: string) => ({
      json: async () => ({ openid: 'real-openid-1' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const openid = await exchangeWxCode('real-code-with spaces&stuff');
    expect(openid).toBe('real-openid-1');
    const calledUrl = fetchMock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('https://api.weixin.qq.com/sns/jscode2session');
    expect(calledUrl).toContain('appid=my-appid');
    expect(calledUrl).toContain('secret=my-secret');
    expect(calledUrl).toContain('grant_type=authorization_code');
    // The code is URI-encoded before being embedded in the query string.
    expect(calledUrl).toContain(`js_code=${encodeURIComponent('real-code-with spaces&stuff')}`);
  });

  it('configured but WeChat responds with an error (no openid) -> throws with errcode/errmsg in the message', async () => {
    process.env.NW_WX_APPID = 'my-appid';
    process.env.NW_WX_SECRET = 'my-secret';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ errcode: 40029, errmsg: 'invalid code' }),
    })));
    await expect(exchangeWxCode('bad-code')).rejects.toThrow(/40029/);
    await expect(exchangeWxCode('bad-code')).rejects.toThrow(/invalid code/);
  });
});
