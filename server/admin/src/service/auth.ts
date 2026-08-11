// Authentication (admin login + rate limiting + me-view). The login-attempt table is private state
// owned by this class (2026-08-11 mixin-chain split: previously lived on AdminServiceBase as
// constructor-owned state shared across the whole mixin chain, but only auth.ts ever read/wrote it —
// moved to a private field here now that domains are independent sibling classes, not mixin layers).
import {
  capabilitiesForRole,
  verifyPassword,
  type AdminAccountView,
  type AdminCapability,
} from '@nw/shared';
import type { AdminAccountDoc } from '../db';
import { AdminError } from './errors';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, LOGIN_LOCKOUT_MS, type AdminCore, type LoginAttempt } from './base';
import { toAccountView } from './validators';

export class AuthService {
  /** Login failure rate-limit table (keyed by attacker-controlled username, in-memory). */
  private readonly loginAttempts = new Map<string, LoginAttempt>();
  /** Last full-table sweep of `loginAttempts` (maybeSweepLoginAttempts) — without it, failed logins
   * against nonexistent usernames (never hit the `.delete()` on success) grow this map without bound
   * for as long as the process lives. */
  private lastLoginAttemptsSweepAt = 0;

  constructor(private readonly core: AdminCore) {}

  // ───────────────────────── Authentication ─────────────────────────

  /** Verify account credentials. Returns the account on success (for httpApi to sign a token); throws AdminError on failure. Audits both success and failure. */
  async authenticate(username: string, password: string, ip?: string): Promise<AdminAccountDoc> {
    const key = (username ?? '').trim().toLowerCase();
    this.maybeSweepLoginAttempts();
    // Rate-limit gate: reject immediately at threshold without even checking the password (prevents brute force + timing side-channel).
    const lockedFor = this.loginLockedMs(key);
    if (lockedFor > 0) {
      await this.core.audit(`unknown:${username}`, 'login.failed', {
        target: username,
        ...(ip ? { ip } : {}),
        summary: `rate limited (${Math.ceil(lockedFor / 1000)}s left)`,
      });
      throw new AdminError(429, 'too_many_attempts', 'too many failed attempts, try again later');
    }

    const doc = await this.core.cols.adminAccounts.findOne({ username });
    if (!doc || doc.disabled || !(await verifyPassword(password, doc.passwordHash))) {
      this.recordLoginFailure(key);
      // Do not distinguish between "no such user / wrong password / disabled" externally, to prevent account enumeration; the audit log records the real reason.
      await this.core.audit(doc?._id ?? `unknown:${username}`, 'login.failed', {
        target: username,
        ...(ip ? { ip } : {}),
        summary: doc ? (doc.disabled ? 'disabled' : 'bad password') : 'no such user',
      });
      throw new AdminError(401, 'invalid_credentials', 'invalid username or password');
    }
    this.loginAttempts.delete(key); // reset counter on success
    await this.core.cols.adminAccounts.updateOne({ _id: doc._id }, { $set: { lastLoginAt: this.core.now() } });
    await this.core.audit(doc._id, 'login', { ...(ip ? { ip } : {}) });
    return doc;
  }

  /**
   * Piggyback a full cleanup pass onto normal login traffic (at most once per LOGIN_WINDOW_MS) instead
   * of a background timer — same pattern as metaserver's SlidingRateLimiter.maybeSweep, chosen for the
   * same reason: a timer would leak across short-lived AdminService instances constructed per test.
   * `key` is an attacker-controlled username with no account-existence check before this table is
   * touched (recordLoginFailure runs on every failed attempt, including nonexistent usernames), so
   * without a sweep this map grows without bound for the life of the process.
   */
  private maybeSweepLoginAttempts(): void {
    const now = this.core.now();
    if (now - this.lastLoginAttemptsSweepAt < LOGIN_WINDOW_MS) return;
    this.lastLoginAttemptsSweepAt = now;
    for (const [k, a] of this.loginAttempts) {
      if (a.lockedUntil <= now && now - a.windowStart > LOGIN_WINDOW_MS) this.loginAttempts.delete(k);
    }
  }

  /** Whether the account is currently locked; returns remaining lockout milliseconds (0 = not locked). */
  private loginLockedMs(key: string): number {
    const a = this.loginAttempts.get(key);
    if (!a) return 0;
    const now = this.core.now();
    return a.lockedUntil > now ? a.lockedUntil - now : 0;
  }

  /** Record one login failure; resets the counter if outside the window, locks the account when threshold is reached. */
  private recordLoginFailure(key: string): void {
    const now = this.core.now();
    const a = this.loginAttempts.get(key);
    if (!a || now - a.windowStart > LOGIN_WINDOW_MS) {
      this.loginAttempts.set(key, { fails: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    a.fails += 1;
    if (a.fails >= LOGIN_MAX_FAILURES) {
      a.lockedUntil = now + LOGIN_LOCKOUT_MS;
      a.fails = 0; // reset counter after locking; restarts fresh after the lockout expires
      a.windowStart = now;
    }
  }

  async getAccount(adminId: string): Promise<AdminAccountDoc | null> {
    return this.core.cols.adminAccounts.findOne({ _id: adminId });
  }

  meView(doc: AdminAccountDoc): { admin: AdminAccountView; capabilities: AdminCapability[] } {
    return { admin: toAccountView(doc), capabilities: capabilitiesForRole(doc.role) };
  }
}
