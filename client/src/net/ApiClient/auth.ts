// Auth / account / cloud-save domain: token exchange, password accounts, GDPR/deletion, and the
// optimistic-locked save get/put/rename endpoints.
import type { AuthCredential } from '../../platform/IPlatform';
import type { SaveData, SyncPatch } from '../../game/meta/SaveData';
import { type Constructor, type ApiClientBaseCtor, ApiError } from './base';
import type { AuthResult, ApiResp, PushResult } from './types';

export interface AuthApi {
  auth(cred: AuthCredential): Promise<AuthResult>;
  register(loginId: string, password: string, displayName?: string): Promise<AuthResult>;
  login(loginId: string, password: string): Promise<AuthResult>;
  changePassword(oldPassword: string, newPassword: string): Promise<void>;
  deleteAccount(): Promise<{ confirmToken: string }>;
  recordGdprConsent(consent: boolean): Promise<void>;
  getSave(): Promise<{ save: SaveData; displayName?: string; publicId?: string; gatewayUrl?: string; freeRename?: boolean }>;
  rename(displayName: string): Promise<{ save: SaveData; displayName: string; freeRename?: boolean }>;
  putSave(rev: number, patch: SyncPatch): Promise<PushResult>;
}

export function AuthMixin<TBase extends ApiClientBaseCtor>(Base: TBase): TBase & Constructor<AuthApi> {
  return class extends Base {
    // ── auth (S0-4 / S0-7) ──────────────────────────────────
    /** Exchange a platform anonymous credential for a token + accountId; on success the token is retained automatically. */
    async auth(cred: AuthCredential): Promise<AuthResult> {
      const path = cred.kind === 'wx' ? '/auth/wx' : '/auth/device';
      const body = cred.kind === 'wx' ? { code: cred.code } : { deviceId: cred.deviceId };
      const data = await this.post<AuthResult>(path, body);
      this.token = data.token;
      return data;
    }

    // ── Password account (SA-1) ─────────────────────────────────────
    /** Password-based registration (new account); on success the token is retained automatically. */
    async register(loginId: string, password: string, displayName?: string): Promise<AuthResult> {
      const data = await this.post<AuthResult>('/auth/register', {
        loginId,
        password,
        ...(displayName ? { displayName } : {}),
      });
      this.token = data.token;
      return data;
    }

    /** Password-based login; on success the token is retained automatically. */
    async login(loginId: string, password: string): Promise<AuthResult> {
      const data = await this.post<AuthResult>('/auth/login', { loginId, password });
      this.token = data.token;
      return data;
    }

    /** Change password (requires an active login; token must already be held). */
    async changePassword(oldPassword: string, newPassword: string): Promise<void> {
      await this.post<{ ok: true }>('/auth/password/change', { oldPassword, newPassword });
    }

    // ── Account compliance (C5, requires login token) ────────────────────────────────────────────
    /**
     * Soft-delete account (C5-b, Apple 5.1.1(v)): server sets `deletedAt`; data is purged asynchronously after a 7-day grace period.
     * Re-logging in during the grace period restores the account. Returns a confirmation token (for auditing). Callers should clear the local token/save and return to the login screen.
     */
    async deleteAccount(): Promise<{ confirmToken: string }> {
      return this.request<{ confirmToken: string }>('DELETE', '/account');
    }

    /** Record GDPR consent (C5-c): server writes `flags.gdprConsent`. Must not be called when no token is held (anonymous / not logged in). */
    async recordGdprConsent(consent: boolean): Promise<void> {
      await this.post<{ ok: true }>('/account/gdpr-consent', { consent });
    }

    // ── save (S0-7) ─────────────────────────────────────────
    /** Fetch the current account's cloud save (also returns the display name + public id + gateway URL for use in the profile / online play). */
    async getSave(): Promise<{ save: SaveData; displayName?: string; publicId?: string; gatewayUrl?: string; freeRename?: boolean }> {
      const data = await this.request<{
        save: SaveData;
        displayName?: string;
        publicId?: string;
        gatewayUrl?: string;
        freeRename?: boolean;
      }>('GET', '/save');
      return {
        save: data.save,
        displayName: data.displayName,
        publicId: data.publicId,
        gatewayUrl: data.gatewayUrl,
        freeRename: data.freeRename,
      };
    }

    /**
     * Rename. The first rename for a player who never chose a name is free; afterwards it costs coins
     * (insufficient balance → ApiError('INSUFFICIENT_FUNDS')). Returns the authoritative save, the new
     * display name, and `freeRename` (always false after a successful rename — the free one is consumed).
     */
    async rename(displayName: string): Promise<{ save: SaveData; displayName: string; freeRename?: boolean }> {
      return this.post<{ save: SaveData; displayName: string; freeRename?: boolean }>('/profile/rename', { displayName });
    }

    /**
     * Push a client sync patch with optimistic locking via If-Match: rev.
     * 200 → ok + normalised save; 409 → conflict + current server-side value (no exception thrown; caller handles pull-merge).
     */
    async putSave(rev: number, patch: SyncPatch): Promise<PushResult> {
      const res = await this.fetchRaw('PUT', '/save', { save: patch }, { 'If-Match': String(rev) });
      const json = (await res.json()) as ApiResp<{ save: SaveData }> & { save?: SaveData };
      if (res.status === 409) {
        // 409 envelope: { ok:false, error, save: current server-side value }
        if (json.save) return { kind: 'conflict', save: json.save };
        throw new ApiError('REV_CONFLICT', 'rev conflict without server save');
      }
      if (!json.ok) {
        throw new ApiError(json.error.code, json.error.message);
      }
      return { kind: 'ok', save: json.data.save };
    }
  };
}
