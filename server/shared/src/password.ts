// Password hashing + loginId normalisation (ACCOUNT_DESIGN.md §6, SA-1).
// Uses Node built-in crypto.scrypt: zero extra dependencies, cross-platform (no native
// compilation like argon2/bcrypt), and is a suitable password KDF.
// Hash string is self-describing: scrypt$N$r$p$saltB64$hashB64.
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt cost parameters (128 * N * r ≈ 16 MB memory, within the default maxmem of 32 MB).
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_LEN = 16;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (e, dk) => (e ? reject(e) : resolve(dk)));
  });
}

export const MIN_PASSWORD_LEN = 6;
export const MIN_LOGIN_ID_LEN = 3;
export const MAX_LOGIN_ID_LEN = 64;

/** Normalise a loginId for registration/login (case-insensitive, trim leading/trailing whitespace). */
export function normalizeLoginId(loginId: string): string {
  return loginId.trim().toLowerCase();
}

/** Returns true if the loginId looks like an email address (used to decide eligibility for password recovery — first iteration records only, does not send email). */
export function isEmailLoginId(loginId: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginId.trim());
}

/** Validate a loginId (length + non-empty). Returns null if valid, otherwise returns the reason. */
export function validateLoginId(loginId: string): string | null {
  const t = loginId.trim();
  if (t.length < MIN_LOGIN_ID_LEN) return `loginId too short (min ${MIN_LOGIN_ID_LEN})`;
  if (t.length > MAX_LOGIN_ID_LEN) return `loginId too long (max ${MAX_LOGIN_ID_LEN})`;
  return null;
}

export const MIN_DISPLAY_NAME_LEN = 1;
export const MAX_DISPLAY_NAME_LEN = 24;

/** Validate a display name (length, non-empty after trim). Returns null if valid, otherwise returns the reason. */
export function validateDisplayName(name: string): string | null {
  const t = (typeof name === 'string' ? name : '').trim();
  if (t.length < MIN_DISPLAY_NAME_LEN) return 'display name is empty';
  if (t.length > MAX_DISPLAY_NAME_LEN) return `display name too long (max ${MAX_DISPLAY_NAME_LEN})`;
  return null;
}

/** Validate a password. Returns null if valid, otherwise returns the reason. */
export function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return `password too short (min ${MIN_PASSWORD_LEN})`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = (await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P })) as Buffer;
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const derived = (await scryptAsync(password, salt, expected.length, { N: n, r, p })) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
