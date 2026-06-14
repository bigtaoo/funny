// 密码哈希 + loginId 规范化（ACCOUNT_DESIGN.md §6、SA-1）。
// 用 Node 内置 crypto.scrypt：零依赖、跨平台（无 argon2/bcrypt 原生编译），
// 是合格的密码 KDF。哈希串自描述参数：scrypt$N$r$p$saltB64$hashB64。
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt cost（128 * N * r ≈ 16MB 内存，在默认 maxmem 32MB 内）。
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

/** 注册/登录的 loginId 统一规范化键（大小写不敏感、去首尾空格）。 */
export function normalizeLoginId(loginId: string): string {
  return loginId.trim().toLowerCase();
}

/** 是否长得像邮箱（决定能否走找回密码——首期仅记录，不发邮件）。 */
export function isEmailLoginId(loginId: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginId.trim());
}

/** loginId 是否合法（长度 + 非空）。返回 null 表示合法，否则返回原因。 */
export function validateLoginId(loginId: string): string | null {
  const t = loginId.trim();
  if (t.length < MIN_LOGIN_ID_LEN) return `loginId too short (min ${MIN_LOGIN_ID_LEN})`;
  if (t.length > MAX_LOGIN_ID_LEN) return `loginId too long (max ${MAX_LOGIN_ID_LEN})`;
  return null;
}

/** 密码是否合法。返回 null 表示合法，否则返回原因。 */
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
