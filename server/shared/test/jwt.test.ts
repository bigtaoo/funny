// Unit tests for jwt.ts's signToken/verifyToken/extractBearer.
import { describe, it, expect } from 'vitest';
import jwtLib from 'jsonwebtoken';
import { signToken, verifyToken, verifyTokenPayload, extractBearer, TOKEN_RENEW_WINDOW_MS, RENEWED_TOKEN_HEADER } from '../src/jwt';

const cfg = { secret: 'test-secret' };

describe('signToken / verifyToken', () => {
  it('round-trips: sign then verify returns the original accountId', () => {
    const token = signToken('acc-123', cfg);
    expect(verifyToken(token, cfg)).toBe('acc-123');
  });

  it('verify with a different secret than what signed it throws', () => {
    const token = signToken('acc-123', cfg);
    expect(() => verifyToken(token, { secret: 'wrong-secret' })).toThrow();
  });

  it('verify a token whose decoded payload is a plain string throws "invalid token payload"', () => {
    const token = jwtLib.sign('just-a-string-payload', cfg.secret);
    expect(() => verifyToken(token, cfg)).toThrow('invalid token payload');
  });

  it('verify a token missing the sub field throws "invalid token payload"', () => {
    const token = jwtLib.sign({ notSub: 'x' }, cfg.secret);
    expect(() => verifyToken(token, cfg)).toThrow('invalid token payload');
  });

  it('signToken accepts a custom expiresIn', () => {
    const token = signToken('acc-456', { ...cfg, expiresIn: '1h' });
    expect(verifyToken(token, cfg)).toBe('acc-456');
  });
});

// verifyTokenPayload exists for exactly one caller — metaserver's bearerAuth, which needs `exp` to
// decide whether to slide the session forward (ACCOUNT_DESIGN.md §5). verifyToken is now a thin
// wrapper over it, so these also pin that the two cannot disagree about what a valid token is.
describe('verifyTokenPayload', () => {
  it('returns sub plus the exp/iat jsonwebtoken stamped on it', () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = verifyTokenPayload(signToken('acc-123', cfg), cfg);
    expect(payload.sub).toBe('acc-123');
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    // 30d default TTL (signToken's expiresIn fallback), i.e. well past the renewal window.
    expect(payload.exp! * 1000 - Date.now()).toBeGreaterThan(TOKEN_RENEW_WINDOW_MS);
  });

  it('omits exp entirely for a token signed without an expiry', () => {
    const payload = verifyTokenPayload(jwtLib.sign({ sub: 'acc-9' }, cfg.secret), cfg);
    expect(payload).toEqual({ sub: 'acc-9', iat: expect.any(Number) });
    expect('exp' in payload).toBe(false);
  });

  it('rejects the same tokens verifyToken rejects (bad secret / no sub / string payload)', () => {
    expect(() => verifyTokenPayload(signToken('a', cfg), { secret: 'other' })).toThrow();
    expect(() => verifyTokenPayload(jwtLib.sign({ notSub: 'x' }, cfg.secret), cfg)).toThrow('invalid token payload');
    expect(() => verifyTokenPayload(jwtLib.sign('str', cfg.secret), cfg)).toThrow('invalid token payload');
  });

  it('an expired token throws rather than returning a past exp', () => {
    const expired = jwtLib.sign({ sub: 'acc-1' }, cfg.secret, { expiresIn: -60 });
    expect(() => verifyTokenPayload(expired, cfg)).toThrow();
  });
});

describe('renewal constants', () => {
  // The window has to leave real headroom under the 30d TTL, or "renew when nearly expired" would
  // mean "renew on every request" (and the header name is half of a client/server pair —
  // client/src/net/ApiClient/core.ts's RENEWED_TOKEN_HEADER must read the same string).
  it('the renewal window is 10 days, comfortably inside the 30d default TTL', () => {
    expect(TOKEN_RENEW_WINDOW_MS).toBe(10 * 24 * 60 * 60 * 1000);
    expect(TOKEN_RENEW_WINDOW_MS).toBeLessThan(30 * 24 * 60 * 60 * 1000);
  });

  it('the renewal header is lower-case x-nw-token', () => {
    expect(RENEWED_TOKEN_HEADER).toBe('x-nw-token');
  });
});

describe('extractBearer', () => {
  it('undefined header returns null', () => {
    expect(extractBearer(undefined)).toBeNull();
  });

  it('header without Bearer prefix returns null', () => {
    expect(extractBearer('Basic abc123')).toBeNull();
  });

  it('normal "Bearer xxx" header extracts the token', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the "Bearer" keyword', () => {
    expect(extractBearer('bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(extractBearer('  Bearer  abc.def.ghi  ')).toBe('abc.def.ghi');
  });

  it('empty string header returns null', () => {
    expect(extractBearer('')).toBeNull();
  });
});
