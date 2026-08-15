// Unit tests for password.ts: loginId/displayName/password validation helpers + scrypt-based
// hashPassword/verifyPassword round trip and malformed-stored-hash handling.
import { describe, it, expect } from 'vitest';
import {
  normalizeLoginId,
  isEmailLoginId,
  validateLoginId,
  validateDisplayName,
  validatePassword,
  hashPassword,
  verifyPassword,
  DUMMY_PASSWORD_HASH,
  MIN_PASSWORD_LEN,
  MIN_LOGIN_ID_LEN,
  MAX_LOGIN_ID_LEN,
  MAX_DISPLAY_NAME_LEN,
} from '../src/password';

describe('normalizeLoginId', () => {
  it('trims whitespace and lowercases', () => {
    expect(normalizeLoginId('  MyLogin@Example.com  ')).toBe('mylogin@example.com');
  });
});

describe('isEmailLoginId', () => {
  it('returns true for a well-formed email', () => {
    expect(isEmailLoginId('user@example.com')).toBe(true);
  });

  it('trims before testing', () => {
    expect(isEmailLoginId('  user@example.com  ')).toBe(true);
  });

  it('returns false for a plain username (no @)', () => {
    expect(isEmailLoginId('plainuser')).toBe(false);
  });

  it('returns false for malformed email-like strings', () => {
    expect(isEmailLoginId('user@')).toBe(false);
    expect(isEmailLoginId('@example.com')).toBe(false);
    expect(isEmailLoginId('user@example')).toBe(false);
  });
});

describe('validateLoginId', () => {
  it('returns a reason when too short', () => {
    expect(validateLoginId('ab')).toBe(`loginId too short (min ${MIN_LOGIN_ID_LEN})`);
  });

  it('returns a reason when too long', () => {
    expect(validateLoginId('a'.repeat(MAX_LOGIN_ID_LEN + 1))).toBe(`loginId too long (max ${MAX_LOGIN_ID_LEN})`);
  });

  it('returns null for a valid loginId', () => {
    expect(validateLoginId('validuser')).toBeNull();
  });

  it('boundary: exactly MIN/MAX length is valid', () => {
    expect(validateLoginId('a'.repeat(MIN_LOGIN_ID_LEN))).toBeNull();
    expect(validateLoginId('a'.repeat(MAX_LOGIN_ID_LEN))).toBeNull();
  });
});

describe('validateDisplayName', () => {
  it('returns a reason for an empty name', () => {
    expect(validateDisplayName('')).toBe('display name is empty');
  });

  it('returns a reason for a whitespace-only name (empty after trim)', () => {
    expect(validateDisplayName('   ')).toBe('display name is empty');
  });

  it('returns a reason when too long', () => {
    expect(validateDisplayName('a'.repeat(MAX_DISPLAY_NAME_LEN + 1))).toBe(
      `display name too long (max ${MAX_DISPLAY_NAME_LEN})`,
    );
  });

  it('returns null for a valid name', () => {
    expect(validateDisplayName('Player One')).toBeNull();
  });

  it('non-string input is treated as empty (covers the typeof guard branch)', () => {
    // @ts-expect-error deliberately passing a non-string to exercise the runtime guard
    expect(validateDisplayName(123)).toBe('display name is empty');
  });
});

describe('validatePassword', () => {
  it('returns a reason when too short', () => {
    expect(validatePassword('abc')).toBe(`password too short (min ${MIN_PASSWORD_LEN})`);
  });

  it('returns null for a valid password', () => {
    expect(validatePassword('longenoughpw')).toBeNull();
  });

  it('non-string input returns the too-short reason (covers the typeof guard branch)', () => {
    // @ts-expect-error deliberately passing a non-string to exercise the runtime guard
    expect(validatePassword(123456)).toBe(`password too short (min ${MIN_PASSWORD_LEN})`);
  });
});

describe('hashPassword / verifyPassword', () => {
  it('round-trips: hashing then verifying the same password succeeds', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('verifying the wrong password against a real hash returns false', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('produces a self-describing scrypt$N$r$p$salt$hash string', async () => {
    const hash = await hashPassword('anypassword');
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
  });

  it('verifyPassword returns false (not throw) for a stored string with the wrong number of parts', async () => {
    expect(await verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
  });

  it('verifyPassword returns false for a stored string with a non-scrypt prefix', async () => {
    const fake = 'bcrypt$16384$8$1$c2FsdA==$aGFzaA==';
    expect(await verifyPassword('anything', fake)).toBe(false);
  });

  it('verifyPassword returns false when N/r/p are not finite numbers', async () => {
    const fake = 'scrypt$notanumber$8$1$c2FsdA==$aGFzaA==';
    expect(await verifyPassword('anything', fake)).toBe(false);
  });

  it('DUMMY_PASSWORD_HASH never verifies true, but also never throws (timing side-channel mitigation usage)', async () => {
    expect(await verifyPassword('any-password-at-all', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword('', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});
