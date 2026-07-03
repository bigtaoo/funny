// Authentication (admin login + rate limiting + me-view). The login-attempt table itself lives on
// AdminServiceBase (constructor-owned state); the sliding-window helpers stay private to this mixin.
import {
  capabilitiesForRole,
  verifyPassword,
  type AdminAccountView,
  type AdminCapability,
} from '@nw/shared';
import type { AdminAccountDoc } from '../db';
import { AdminError } from './errors';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, LOGIN_LOCKOUT_MS, type AdminBaseCtor, type Constructor } from './base';
import { toAccountView } from './validators';

export interface AuthHandlers {
  authenticate(username: string, password: string, ip?: string): Promise<AdminAccountDoc>;
  getAccount(adminId: string): Promise<AdminAccountDoc | null>;
  meView(doc: AdminAccountDoc): { admin: AdminAccountView; capabilities: AdminCapability[] };
}

export function AuthMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<AuthHandlers> {
  return class extends Base {
    // ───────────────────────── Authentication ─────────────────────────

    /** Verify account credentials. Returns the account on success (for httpApi to sign a token); throws AdminError on failure. Audits both success and failure. */
    async authenticate(username: string, password: string, ip?: string): Promise<AdminAccountDoc> {
      const key = (username ?? '').trim().toLowerCase();
      // Rate-limit gate: reject immediately at threshold without even checking the password (prevents brute force + timing side-channel).
      const lockedFor = this.loginLockedMs(key);
      if (lockedFor > 0) {
        await this.audit(`unknown:${username}`, 'login.failed', {
          target: username,
          ...(ip ? { ip } : {}),
          summary: `rate limited (${Math.ceil(lockedFor / 1000)}s left)`,
        });
        throw new AdminError(429, 'too_many_attempts', 'too many failed attempts, try again later');
      }

      const doc = await this.cols.adminAccounts.findOne({ username });
      if (!doc || doc.disabled || !(await verifyPassword(password, doc.passwordHash))) {
        this.recordLoginFailure(key);
        // Do not distinguish between "no such user / wrong password / disabled" externally, to prevent account enumeration; the audit log records the real reason.
        await this.audit(doc?._id ?? `unknown:${username}`, 'login.failed', {
          target: username,
          ...(ip ? { ip } : {}),
          summary: doc ? (doc.disabled ? 'disabled' : 'bad password') : 'no such user',
        });
        throw new AdminError(401, 'invalid_credentials', 'invalid username or password');
      }
      this.loginAttempts.delete(key); // reset counter on success
      await this.cols.adminAccounts.updateOne({ _id: doc._id }, { $set: { lastLoginAt: this.now() } });
      await this.audit(doc._id, 'login', { ...(ip ? { ip } : {}) });
      return doc;
    }

    /** Whether the account is currently locked; returns remaining lockout milliseconds (0 = not locked). */
    private loginLockedMs(key: string): number {
      const a = this.loginAttempts.get(key);
      if (!a) return 0;
      const now = this.now();
      return a.lockedUntil > now ? a.lockedUntil - now : 0;
    }

    /** Record one login failure; resets the counter if outside the window, locks the account when threshold is reached. */
    private recordLoginFailure(key: string): void {
      const now = this.now();
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
      return this.cols.adminAccounts.findOne({ _id: adminId });
    }

    meView(doc: AdminAccountDoc): { admin: AdminAccountView; capabilities: AdminCapability[] } {
      return { admin: toAccountView(doc), capabilities: capabilitiesForRole(doc.role) };
    }
  };
}
