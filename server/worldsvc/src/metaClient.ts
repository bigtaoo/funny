// worldsvc → meta internal calls (S8-5: auction material transfers / S8 owner: player profiles).
// meta internal HTTP (/internal/materials/* · /internal/profile), authenticated with X-Internal-Key.
// NW_META_INTERNAL_URL not configured → available=false → auction material transactions + owner display names unavailable.

import { internalHeaders, SlgError, type EquipmentInstance, type GearLoadout } from '@nw/shared';

export interface PlayerProfile {
  publicId?: string;
  displayName?: string;
}

/** Attacker progression snapshot required for authoritative siege engine calculation (E8, /internal/save-fields). */
export interface SaveFields {
  pveUpgrades: Record<string, number>;
  unitLevels: Record<string, number>;
  gear: GearLoadout;
  equipmentInv: Record<string, EquipmentInstance>;
}

export interface WorldMetaClient {
  readonly available: boolean;
  /** Deduct material (inverse of the cancel-and-refund operation for listing on auction). Throws an Error containing INSUFFICIENT_RESOURCES if insufficient. */
  deductMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void>;
  /** Grant material (to buyer on sale, or back to seller on cancel / expiry). Best-effort; failures are logged but not rolled back. */
  grantMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void>;
  /** Get a player's public profile (publicId / displayName). Returns null on failure; caller degrades gracefully without showing a display name. */
  getProfile(accountId: string): Promise<PlayerProfile | null>;
  /** Get the attacker's progression snapshot (authoritative siege engine calculation, E8). Returns null on failure → engine degrades without equipment calculation (march is not blocked). */
  getSaveFields(accountId: string): Promise<SaveFields | null>;
  /** Escrow equipment for auction: removes from seller's inventory and returns an instance snapshot (stored in the listing doc). Equipped / locked / not found → throws SlgError. */
  escrowEquipment(accountId: string, instanceId: string, orderId: string): Promise<EquipmentInstance>;
  /** Transfer or return equipment: writes the instance snapshot into the target account's inventory (to buyer on sale, or back to seller on cancel / expiry). Best-effort; failures are logged but not rolled back. */
  grantEquipment(accountId: string, instance: EquipmentInstance, orderId: string): Promise<void>;
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

  async deductMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void> {
    if (!this.baseUrl) throw new Error('meta service not configured');
    const res = await fetch(`${this.baseUrl}/internal/materials/deduct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
      body: JSON.stringify({ accountId, material, qty, orderId }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `deductMaterial failed: ${res.status}`);
    }
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

  async escrowEquipment(accountId: string, instanceId: string, orderId: string): Promise<EquipmentInstance> {
    if (!this.baseUrl) throw new Error('meta service not configured');
    const res = await fetch(`${this.baseUrl}/internal/equipment/escrow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
      body: JSON.stringify({ accountId, instanceId, orderId }),
    });
    const body = (await res.json().catch(() => ({}))) as { instance?: EquipmentInstance; code?: string; error?: string };
    if (!res.ok || !body.instance) {
      // Forward meta's equipment error code as a SlgError (httpApi maps it to an HTTP status via ERROR_HTTP_STATUS).
      const code = body.code;
      if (code === 'EQUIP_LOCKED' || code === 'EQUIP_IN_USE' || code === 'EQUIP_NOT_FOUND') throw new SlgError(code);
      throw new SlgError('BAD_REQUEST', body.error ?? `escrowEquipment failed: ${res.status}`);
    }
    return body.instance;
  }

  async grantEquipment(accountId: string, instance: EquipmentInstance, orderId: string): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/equipment/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ accountId, instance, orderId }),
      });
    } catch (e) {
      console.error('[worldsvc] meta.grantEquipment failed', { accountId, instanceId: instance.id, orderId, err: (e as Error).message });
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
  async deductMaterial() { throw new Error('meta service not configured'); },
  async grantMaterial() { /* no-op */ },
  async getProfile() { return null; },
  async getSaveFields() { return null; },
  async escrowEquipment() { throw new Error('meta service not configured'); },
  async grantEquipment() { /* no-op */ },
  async grantTitle() { /* no-op */ },
};
