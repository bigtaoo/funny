// Auth / account / cloud-save domain: token exchange, password accounts, GDPR/deletion, the save
// get/rename endpoints, and the per-field server-authoritative cosmetic/flag mutations (equipped/flags
// have no generic client-sync endpoint any more — see DECISIONS.md "equipped/flags server-authoritative").
import type { AuthCredential } from '../../platform/IPlatform';
import type { SaveData } from '../../game/meta/SaveData';
import type { ApiClientCore } from './core';
import type { AuthResult, ActiveMatchInfo } from './types';
import { sampleServerNow } from '../serverClock';

export interface AuthApi {
  auth(cred: AuthCredential): Promise<AuthResult>;
  register(loginId: string, password: string, displayName?: string): Promise<AuthResult>;
  login(loginId: string, password: string): Promise<AuthResult>;
  changePassword(oldPassword: string, newPassword: string): Promise<void>;
  deleteAccount(): Promise<{ confirmToken: string }>;
  cancelAccountDeletion(confirmToken: string): Promise<void>;
  recordGdprConsent(consent: boolean): Promise<void>;
  getSave(): Promise<{
    save: SaveData;
    displayName?: string;
    publicId?: string;
    gatewayUrl?: string;
    freeRename?: boolean;
    activeMatch?: ActiveMatchInfo;
  }>;
  rename(
    displayName: string
  ): Promise<{ save: SaveData; displayName: string; freeRename?: boolean }>;
  /** Select the displayed title; empty string unequips. Ownership-validated server-side. */
  equipTitle(titleId: string): Promise<{ save: SaveData }>;
  /** Select the displayed avatar (composite "<category>:<key>"); empty string unequips. Ownership-validated server-side. */
  equipAvatar(avatarId: string): Promise<{ save: SaveData }>;
  /** Equip/unequip a character skin; skinId null unequips the slot. Ownership-validated server-side. */
  equipSkin(unitType: string, skinId: string | null): Promise<{ save: SaveData }>;
  /** Set one client-preference flag by key (onboarding/consent/tutorial-seen — no ownership semantics). */
  setFlag(key: string, value: boolean): Promise<{ save: SaveData }>;
  /** Submit an appeal against the account's currently active mute/temp-ban/ban (CONTENT_MODERATION_DESIGN.md CM10). */
  submitAppeal(reason: string): Promise<void>;
  /** Submit free-text player feedback (UI_DESIGN.md §4.1.1 lobby entry, SERVER_API.md §2.13). */
  submitFeedback(text: string): Promise<void>;
}

/** Auth/account/save domain (see ../ApiClient.ts assembly + ./core.ts for the shared transport). */
export class AuthService implements AuthApi {
  constructor(private readonly core: ApiClientCore) {}

  // ── auth (S0-4 / S0-7) ──────────────────────────────────
  /** Exchange a platform anonymous credential for a token + accountId; on success the token is retained automatically. */
  async auth(cred: AuthCredential): Promise<AuthResult> {
    const path = cred.kind === 'wx' ? '/auth/wx' : '/auth/device';
    const body = cred.kind === 'wx' ? { code: cred.code } : { deviceId: cred.deviceId };
    const data = await this.core.post<AuthResult>(path, body);
    this.core.token = data.token;
    return data;
  }

  // ── Password account (SA-1) ─────────────────────────────────────
  /** Password-based registration (new account); on success the token is retained automatically. */
  async register(loginId: string, password: string, displayName?: string): Promise<AuthResult> {
    const data = await this.core.post<AuthResult>('/auth/register', {
      loginId,
      password,
      ...(displayName ? { displayName } : {}),
    });
    this.core.token = data.token;
    return data;
  }

  /** Password-based login; on success the token is retained automatically. */
  async login(loginId: string, password: string): Promise<AuthResult> {
    const data = await this.core.post<AuthResult>('/auth/login', { loginId, password });
    this.core.token = data.token;
    return data;
  }

  /** Change password (requires an active login; token must already be held). */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.core.post<{ ok: true }>('/auth/password/change', { oldPassword, newPassword });
  }

  // ── Account compliance (C5, requires login token) ────────────────────────────────────────────
  /**
   * Soft-delete account (C5-b, Apple 5.1.1(v)): server sets `deletedAt`; data is purged asynchronously
   * after a 7-day grace period. Returns a confirmation token — pass it to cancelAccountDeletion()
   * within the grace period (same session, before the token/save are cleared) for an immediate undo.
   * Logging back in within the grace period also restores the account (server-side, on any of
   * /auth/login, /auth/device, /auth/wx, /auth/oauth — fixed 2026-08-10, previously it did not despite
   * the deletion confirmation copy promising it), so cancelAccountDeletion() is now just the faster,
   * same-session path — it is no longer the *only* way to undo a deletion.
   */
  async deleteAccount(): Promise<{ confirmToken: string }> {
    return this.core.request<{ confirmToken: string }>('DELETE', '/account');
  }

  /** Immediate, same-session undo of a pending soft-delete within the 7-day grace period (C5-b), using
   *  the token deleteAccount() returned. Logging back in later within the grace period also restores
   *  the account server-side, without needing this token. */
  async cancelAccountDeletion(confirmToken: string): Promise<void> {
    await this.core.post<{ ok: true }>('/account/cancel-deletion', { confirmToken });
  }

  /** Record GDPR consent (C5-c): server writes `flags.gdprConsent`. Must not be called when no token is held (anonymous / not logged in). */
  async recordGdprConsent(consent: boolean): Promise<void> {
    await this.core.post<{ ok: true }>('/account/gdpr-consent', { consent });
  }

  // ── save (S0-7) ─────────────────────────────────────────
  /** Fetch the current account's cloud save (also returns the display name + public id + gateway URL for use in the profile / online play). */
  async getSave(): Promise<{
    save: SaveData;
    displayName?: string;
    publicId?: string;
    gatewayUrl?: string;
    freeRename?: boolean;
    activeMatch?: ActiveMatchInfo;
  }> {
    const data = await this.core.request<{
      save: SaveData;
      displayName?: string;
      publicId?: string;
      gatewayUrl?: string;
      freeRename?: boolean;
      activeMatch?: ActiveMatchInfo;
      serverNow?: number;
    }>('GET', '/save');
    // P1-1 clock-offset sample — GET /save is the highest-frequency authenticated round-trip.
    if (typeof data.serverNow === 'number') sampleServerNow(data.serverNow);
    return {
      save: data.save,
      displayName: data.displayName,
      publicId: data.publicId,
      gatewayUrl: data.gatewayUrl,
      freeRename: data.freeRename,
      activeMatch: data.activeMatch,
    };
  }

  /**
   * Rename. The first rename for a player who never chose a name is free; afterwards it costs coins
   * (insufficient balance → ApiError('INSUFFICIENT_FUNDS')). Returns the authoritative save, the new
   * display name, and `freeRename` (always false after a successful rename — the free one is consumed).
   */
  async rename(
    displayName: string
  ): Promise<{ save: SaveData; displayName: string; freeRename?: boolean }> {
    return this.core.post<{ save: SaveData; displayName: string; freeRename?: boolean }>(
      '/profile/rename',
      { displayName }
    );
  }

  async equipTitle(titleId: string): Promise<{ save: SaveData }> {
    return this.core.request<{ save: SaveData }>('PUT', '/title/equip', { titleId });
  }

  async equipAvatar(avatarId: string): Promise<{ save: SaveData }> {
    return this.core.request<{ save: SaveData }>('PUT', '/avatar/equip', { avatarId });
  }

  async equipSkin(unitType: string, skinId: string | null): Promise<{ save: SaveData }> {
    return this.core.request<{ save: SaveData }>('PUT', '/skin/equip', { unitType, skinId });
  }

  async setFlag(key: string, value: boolean): Promise<{ save: SaveData }> {
    return this.core.request<{ save: SaveData }>('PUT', '/flags', { key, value });
  }

  async submitAppeal(reason: string): Promise<void> {
    await this.core.post<{ ok: true }>('/account/appeal', { reason });
  }

  async submitFeedback(text: string): Promise<void> {
    await this.core.post<{ ok: true }>('/feedback', { text });
  }
}
