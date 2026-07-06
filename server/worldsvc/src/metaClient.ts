// worldsvc → meta internal calls (S8 owner: player profiles / stronghold loot grants).
// meta internal HTTP (/internal/materials/* · /internal/profile), authenticated with X-Internal-Key.
// NW_META_INTERNAL_URL not configured → available=false → material grants + owner display names unavailable.

import { internalHeaders, type GearLoadout, type EquipmentInstance, type CardInstance } from '@nw/shared';

export interface PlayerProfile {
  publicId?: string;
  displayName?: string;
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
    try {
      await fetch(`${this.baseUrl}/internal/materials/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ accountId, material, qty, orderId }),
      });
    } catch (e) {
      console.error('[worldsvc] meta.grantMaterial failed', { accountId, material, qty, orderId, err: (e as Error).message });
    }
  }

  async getProfile(accountId: string): Promise<PlayerProfile | null> {
    if (!this.baseUrl) return null;
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/profile?accountId=${encodeURIComponent(accountId)}`,
        { headers: internalHeaders('worldsvc', this.internalKey) },
      );
      if (!res.ok) return null;
      return (await res.json()) as PlayerProfile;
    } catch {
      return null;
    }
  }

  async getSaveFields(accountId: string): Promise<SaveFields | null> {
    if (!this.baseUrl) return null;
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/save-fields?accountId=${encodeURIComponent(accountId)}`,
        { headers: internalHeaders('worldsvc', this.internalKey) },
      );
      if (!res.ok) return null;
      return (await res.json()) as SaveFields;
    } catch {
      return null;
    }
  }

  async grantTitle(accountId: string, titleId: string): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/title/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ accountId, titleId }),
      });
    } catch (e) {
      console.error('[worldsvc] meta.grantTitle failed', { accountId, titleId, err: (e as Error).message });
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
