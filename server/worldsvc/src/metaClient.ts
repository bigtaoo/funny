// worldsvc → meta internal calls (S8 owner: player profiles / stronghold loot grants).
// meta internal HTTP (/internal/materials/* · /internal/profile), authenticated with X-Internal-Key.
// NW_META_INTERNAL_URL not configured → available=false → material grants + owner display names unavailable.

import { fetchInternalJson, type GearLoadout, type EquipmentInstance, type CardInstance } from '@nw/shared';

export interface PlayerProfile {
  publicId?: string;
  displayName?: string;
  /** Equipped title (称号), if any. */
  equippedTitle?: string;
}

/** Attacker progression snapshot required for authoritative siege engine calculation (E8 + CC-3, /internal/save-fields). */
export interface SaveFields {
  pveUpgrades: Record<string, number>;
  unitLevels: Record<string, number>;
  gear: GearLoadout;
  equipmentInv: Record<string, EquipmentInstance>;
  /** CC-3: card instance inventory for unit-type + equipment resolution at siege time. */
  cardInv: Record<string, CardInstance>;
}

export interface WorldMetaClient {
  readonly available: boolean;
  /** Grant material (stronghold loot drop). Best-effort; failures are logged but not rolled back. */
  grantMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void>;
  /** Get a player's public profile (publicId / displayName). Returns null on failure; caller degrades gracefully without showing a display name. */
  getProfile(accountId: string): Promise<PlayerProfile | null>;
  /** Get the attacker's progression snapshot (authoritative siege engine calculation, E8). Returns null on failure → engine degrades without equipment calculation (march is not blocked). */
  getSaveFields(accountId: string): Promise<SaveFields | null>;
  /** Grant a title (S10, SLG season settlement → write to meta). Best-effort; failures are logged but do not block settlement. */
  grantTitle(accountId: string, titleId: string): Promise<void>;
}

export class HttpWorldMetaClient implements WorldMetaClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async grantMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void> {
    if (!this.baseUrl) return;
    const res = await fetchInternalJson(`${this.baseUrl}/internal/materials/grant`, {
      caller: 'worldsvc',
      key: this.internalKey,
      method: 'POST',
      body: { accountId, material, qty, orderId },
      timeoutMs: 5000,
      label: '/internal/materials/grant',
    });
    if (!res.ok) {
      // Delivery reliability (retry + compensation) is a later batch; for now make the loss visible.
      console.error('[worldsvc] meta.grantMaterial failed', { accountId, material, qty, orderId, status: res.status, err: res.error });
    }
  }

  async getProfile(accountId: string): Promise<PlayerProfile | null> {
    if (!this.baseUrl) return null;
    const res = await fetchInternalJson<PlayerProfile>(
      `${this.baseUrl}/internal/profile?accountId=${encodeURIComponent(accountId)}`,
      { caller: 'worldsvc', key: this.internalKey, timeoutMs: 5000, label: '/internal/profile' },
    );
    return res.ok ? res.body : null;
  }

  async getSaveFields(accountId: string): Promise<SaveFields | null> {
    if (!this.baseUrl) return null;
    const res = await fetchInternalJson<SaveFields>(
      `${this.baseUrl}/internal/save-fields?accountId=${encodeURIComponent(accountId)}`,
      { caller: 'worldsvc', key: this.internalKey, timeoutMs: 5000, label: '/internal/save-fields' },
    );
    return res.ok ? res.body : null;
  }

  async grantTitle(accountId: string, titleId: string): Promise<void> {
    if (!this.baseUrl) return;
    const res = await fetchInternalJson(`${this.baseUrl}/internal/title/grant`, {
      caller: 'worldsvc',
      key: this.internalKey,
      method: 'POST',
      body: { accountId, titleId },
      timeoutMs: 5000,
      label: '/internal/title/grant',
    });
    if (!res.ok) {
      console.error('[worldsvc] meta.grantTitle failed', { accountId, titleId, status: res.status, err: res.error });
    }
  }
}

export const nullWorldMetaClient: WorldMetaClient = {
  available: false,
  async grantMaterial() { /* no-op */ },
  async getProfile() { return null; },
  async getSaveFields() { return null; },
  async grantTitle() { /* no-op */ },
};
