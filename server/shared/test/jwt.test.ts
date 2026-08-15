// Unit tests for jwt.ts's signToken/verifyToken/extractBearer.
import { describe, it, expect } from 'vitest';
import jwtLib from 'jsonwebtoken';
import { signToken, verifyToken, extractBearer } from '../src/jwt';

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
