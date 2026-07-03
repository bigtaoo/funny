// Admin account management (admin.manage): create / update / reset-password + list.
import { randomUUID } from 'node:crypto';
import {
  hashPassword,
  isAdminRole,
  validatePassword,
  type AdminAccountView,
} from '@nw/shared';
import type { AdminAccountDoc } from '../db';
import type { Actor, AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';
import { toAccountView } from './validators';

export interface AccountsHandlers {
  listAccounts(): Promise<AdminAccountView[]>;
  createAccount(
    actor: Actor,
    input: { username: string; password: string; role: string; displayName: string },
  ): Promise<AdminAccountView>;
  updateAccount(
    actor: Actor,
    id: string,
    patch: { role?: string; disabled?: boolean; displayName?: string },
  ): Promise<AdminAccountView>;
  resetPassword(actor: Actor, id: string, password: string): Promise<void>;
}

export function AccountsMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<AccountsHandlers> {
  return class extends Base {
    // ───────────────────────── Account management (admin.manage) ─────────────────────────

    async listAccounts(): Promise<AdminAccountView[]> {
      const docs = await this.cols.adminAccounts.find({}).sort({ createdAt: 1 }).toArray();
      return docs.map(toAccountView);
    }

    async createAccount(
      actor: Actor,
      input: { username: string; password: string; role: string; displayName: string },
    ): Promise<AdminAccountView> {
      const username = (input.username ?? '').trim();
      if (username.length < 3) throw new AdminError(400, 'bad_request', 'username too short (min 3)');
      if (!isAdminRole(input.role)) throw new AdminError(400, 'bad_request', 'invalid role');
      const pwErr = validatePassword(input.password);
      if (pwErr) throw new AdminError(400, 'bad_request', pwErr);
      const exists = await this.cols.adminAccounts.findOne({ username });
      if (exists) throw new AdminError(409, 'conflict', 'username taken');

      const doc: AdminAccountDoc = {
        _id: randomUUID(),
        username,
        passwordHash: await hashPassword(input.password),
        role: input.role,
        displayName: (input.displayName ?? username).trim() || username,
        disabled: false,
        createdAt: this.now(),
        createdBy: actor.adminId,
      };
      try {
        await this.cols.adminAccounts.insertOne(doc);
      } catch (e) {
        // Concurrent unique index violation.
        if ((e as { code?: number }).code === 11000) throw new AdminError(409, 'conflict', 'username taken');
        throw e;
      }
      await this.audit(actor.adminId, 'account.create', {
        target: doc._id,
        summary: `${username} (${doc.role})`,
      });
      return toAccountView(doc);
    }

    async updateAccount(
      actor: Actor,
      id: string,
      patch: { role?: string; disabled?: boolean; displayName?: string },
    ): Promise<AdminAccountView> {
      const doc = await this.cols.adminAccounts.findOne({ _id: id });
      if (!doc) throw new AdminError(404, 'not_found', 'no such account');
      const set: Partial<AdminAccountDoc> = {};
      if (patch.role !== undefined) {
        if (!isAdminRole(patch.role)) throw new AdminError(400, 'bad_request', 'invalid role');
        // Prevent a super admin from demoting themselves, leaving no one who can manage accounts (must always keep at least one active super admin).
        if (doc._id === actor.adminId && patch.role !== 'super') {
          throw new AdminError(400, 'bad_request', 'cannot demote yourself');
        }
        set.role = patch.role;
      }
      if (patch.disabled !== undefined) {
        if (doc._id === actor.adminId && patch.disabled) {
          throw new AdminError(400, 'bad_request', 'cannot disable yourself');
        }
        set.disabled = patch.disabled;
      }
      if (patch.displayName !== undefined) {
        const dn = patch.displayName.trim();
        if (dn) set.displayName = dn;
      }
      if (Object.keys(set).length === 0) return toAccountView(doc);
      await this.cols.adminAccounts.updateOne({ _id: id }, { $set: set });
      await this.audit(actor.adminId, 'account.update', {
        target: id,
        summary: JSON.stringify(set),
      });
      return toAccountView({ ...doc, ...set });
    }

    async resetPassword(actor: Actor, id: string, password: string): Promise<void> {
      const pwErr = validatePassword(password);
      if (pwErr) throw new AdminError(400, 'bad_request', pwErr);
      const doc = await this.cols.adminAccounts.findOne({ _id: id });
      if (!doc) throw new AdminError(404, 'not_found', 'no such account');
      await this.cols.adminAccounts.updateOne(
        { _id: id },
        { $set: { passwordHash: await hashPassword(password) } },
      );
      await this.audit(actor.adminId, 'account.reset_password', { target: id });
    }
  };
}
