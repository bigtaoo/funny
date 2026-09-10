// Sliding token renewal (ACCOUNT_DESIGN.md §5, 2026-09-10).
//
// Context: signToken's only call sites are the four credential endpoints + oauthBind, i.e. an
// explicit login/register/OAuth-bind. Nothing renewed a token afterwards, so the 30d TTL ran from
// the last time the player typed a password regardless of how active the account was — a player
// who opened the app daily was still logged out on day 30 (iPhone 13 / Capacitor field report:
// the lobby showed "登录已失效，请重新登录" and every subsequent request 401'd).
//
// Two halves are tested here, and the second is the one that silently breaks the whole mechanism:
//   1. auth.ts's bearerAuth attaches `x-nw-token` only inside the last TOKEN_RENEW_WINDOW_MS.
//   2. app.ts's CORS registration lists that header in `exposedHeaders`. It is not one of the
//      seven CORS-safelisted response headers, so without it a browser / WKWebView refuses to let
//      the client read it — the server would renew, the client would never see it, and nothing
//      anywhere would report an error. Every real client is cross-origin here (the Capacitor
//      shell's origin is `capacitor://localhost`).
import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  RENEWED_TOKEN_HEADER,
  TOKEN_RENEW_WINDOW_MS,
  signToken,
  verifyToken,
  verifyTokenPayload,
  type Collections,
} from '@nw/shared';
import jwtLib from 'jsonwebtoken';
import { makeSecurityHandlers } from '../src/auth.js';
import { buildApp } from '../src/app.js';

const jwt = { secret: 'test-secret' };
const ACC = 'acc-renew-1';

/** Minimal FastifyReply stand-in: bearerAuth only ever calls `.header()`. */
function fakeReply(): { headers: Record<string, string>; reply: FastifyReply } {
  const headers: Record<string, string> = {};
  const reply = { header: (k: string, v: string) => { headers[k] = v; } } as unknown as FastifyReply;
  return { headers, reply };
}

function requestWith(token: string): FastifyRequest {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as FastifyRequest;
}

/** A token whose remaining life is exactly `remainingMs`, as seen from `now`. */
function tokenExpiringIn(remainingMs: number, now: number): string {
  return jwtLib.sign({ sub: ACC, exp: Math.floor((now + remainingMs) / 1000) }, jwt.secret);
}

describe('bearerAuth: sliding renewal threshold', () => {
  const NOW = 1_800_000_000_000;
  const at = (t: number) => makeSecurityHandlers(jwt, () => t);

  it('a token close to expiry gets a freshly-signed one in x-nw-token', () => {
    const { headers, reply } = fakeReply();
    const req = requestWith(tokenExpiringIn(TOKEN_RENEW_WINDOW_MS - 60_000, NOW));
    at(NOW).bearerAuth(req, reply);

    const renewed = headers[RENEWED_TOKEN_HEADER];
    expect(renewed).toBeTypeOf('string');
    // Same account, and genuinely re-signed: a full 30d of life again, not a copy of the old one.
    expect(verifyToken(renewed!, jwt)).toBe(ACC);
    const exp = verifyTokenPayload(renewed!, jwt).exp!;
    expect(exp * 1000 - Date.now()).toBeGreaterThan(TOKEN_RENEW_WINDOW_MS);
    expect(req.accountId).toBe(ACC); // authentication itself is unaffected
  });

  it('a token with plenty of life left is not renewed (no header at all)', () => {
    const { headers, reply } = fakeReply();
    at(NOW).bearerAuth(requestWith(tokenExpiringIn(TOKEN_RENEW_WINDOW_MS + 60_000, NOW)), reply);
    expect(headers).toEqual({});
  });

  it('exactly at the window boundary is still "plenty of life" (strict less-than)', () => {
    const { headers, reply } = fakeReply();
    at(NOW).bearerAuth(requestWith(tokenExpiringIn(TOKEN_RENEW_WINDOW_MS, NOW)), reply);
    expect(headers).toEqual({});
  });

  it('a token one millisecond inside the window is renewed', () => {
    const { headers, reply } = fakeReply();
    at(NOW).bearerAuth(requestWith(tokenExpiringIn(TOKEN_RENEW_WINDOW_MS - 1, NOW)), reply);
    expect(headers[RENEWED_TOKEN_HEADER]).toBeTypeOf('string');
  });

  it('an already-expired token still fails authentication — renewal never rescues one', () => {
    const { headers, reply } = fakeReply();
    // Must be expired against the REAL clock: jsonwebtoken checks `exp` with its own Date.now(),
    // which the injected `now` (used only by the renewal window) cannot move.
    const realNow = Date.now();
    const expired = tokenExpiringIn(-1000, realNow);
    expect(() => at(realNow).bearerAuth(requestWith(expired), reply)).toThrow('invalid token');
    expect(headers).toEqual({});
  });

  it('a token the renewal clock considers expired is not renewed (remainingMs <= 0 guard)', () => {
    // Signature-valid (exp is in the real future) but already past according to the injected clock —
    // the shape a clockTolerance would produce. Renewing here would extend a dead token by another
    // 30 days and make the TTL meaningless, so the guard must win over the "inside the window" test.
    const { headers, reply } = fakeReply();
    const realNow = Date.now();
    const token = tokenExpiringIn(60 * 60 * 1000, realNow);
    at(realNow + 2 * 60 * 60 * 1000).bearerAuth(requestWith(token), reply);
    expect(headers).toEqual({});
  });

  it('a real signToken token (30d) is not renewed on its first use', () => {
    const { headers, reply } = fakeReply();
    at(Date.now()).bearerAuth(requestWith(signToken(ACC, jwt)), reply);
    expect(headers).toEqual({});
  });

  it('a token carrying no exp is not renewed (nothing to measure against)', () => {
    const { headers, reply } = fakeReply();
    const noExp = jwtLib.sign({ sub: ACC }, jwt.secret); // no expiresIn → no exp claim
    at(NOW).bearerAuth(requestWith(noExp), reply);
    expect(headers).toEqual({});
  });

  it('called without a reply (accountId-only callers, e.g. unit tests) still authenticates', () => {
    const req = requestWith(tokenExpiringIn(60_000, NOW));
    expect(() => at(NOW).bearerAuth(req)).not.toThrow();
    expect(req.accountId).toBe(ACC);
  });
});

describe('CORS: x-nw-token must be readable cross-origin', () => {
  it('the preflight response lists x-nw-token in access-control-expose-headers', async () => {
    const app = await buildApp({
      cols: { saves: { async findOne() { return null; } } } as unknown as Collections,
      jwt, internalKey: 'k', commercialUrl: null, gatewayUrl: null, authRateLimit: 0,
    });
    try {
      // Capacitor's own origin — the exact case the field report came from.
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/save',
        headers: { origin: 'capacitor://localhost', 'access-control-request-method': 'GET' },
      });
      expect(res.headers['access-control-expose-headers']).toContain(RENEWED_TOKEN_HEADER);
    } finally {
      await app.close();
    }
  });
});
