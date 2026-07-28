// auctionsvc → meta internal calls (auction task 4): material/equipment/card/skin escrow-transfer for listings.
// meta internal HTTP (/internal/materials|equipment|cards|skins/*), authenticated with X-Internal-Key.
// NW_META_INTERNAL_URL not configured → available=false → item trading unavailable.
// Migrated from server/worldsvc/src/metaClient.ts — drops getProfile/getSaveFields/grantTitle (not used by auction),
// adds escrowSkin/grantSkin (§9 task2 metaserver skin escrow capability).

import { fetchInternalJson, SlgError, type EquipmentInstance, type CardInstance, ErrorCode } from '@nw/shared';

export interface AuctionMetaClient {
  readonly available: boolean;
  /** Deduct material (inverse of the cancel-and-refund operation for listing on auction). Throws an Error containing INSUFFICIENT_RESOURCES if insufficient. */
  deductMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void>;
  /** Grant material (to buyer on sale, or back to seller on cancel / expiry). Best-effort; failures are logged but not rolled back. */
  grantMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void>;
  /** Escrow equipment for auction: removes from seller's inventory and returns an instance snapshot (stored in the listing doc). Equipped / locked / not found → throws SlgError. */
  escrowEquipment(accountId: string, instanceId: string, orderId: string): Promise<EquipmentInstance>;
  /** Transfer or return equipment: writes the instance snapshot into the target account's inventory (to buyer on sale, or back to seller on cancel / expiry). Best-effort; failures are logged but not rolled back. */
  grantEquipment(accountId: string, instance: EquipmentInstance, orderId: string): Promise<void>;
  /** Escrow a character card for auction: validates gear all empty, removes from cardInv, returns the instance snapshot. Gear not empty → throws SlgError(CARD_HAS_GEAR); not found → throws SlgError(CARD_NOT_FOUND). */
  escrowCard(accountId: string, instanceId: string, orderId: string): Promise<CardInstance>;
  /** Grant a character card: writes the instance snapshot into the target account's cardInv (to buyer on sale, or back to seller on cancel/expiry). Best-effort; failures are logged. */
  grantCard(accountId: string, instance: CardInstance, orderId: string): Promise<void>;
  /** Escrow a skin for auction: validates owned + not equipped, removes from inventory.skins. Equipped → throws SlgError(SKIN_IN_USE); not owned → throws SlgError(SKIN_NOT_FOUND). */
  escrowSkin(accountId: string, skinId: string, orderId: string): Promise<string>;
  /** Grant a skin: adds skinId back into the target account's inventory.skins (to buyer on sale, or back to seller on cancel/expiry). Best-effort; failures are logged. */
  grantSkin(accountId: string, skinId: string, orderId: string): Promise<void>;
}

export class HttpAuctionMetaClient implements AuctionMetaClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  private opts(label: string) {
    return { caller: 'auctionsvc' as const, key: this.internalKey, method: 'POST' as const, timeoutMs: 5000, label };
  }

  async deductMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void> {
    if (!this.baseUrl) throw new Error('meta service not configured');
    const res = await fetchInternalJson<{ error?: string }>(
      `${this.baseUrl}/internal/materials/deduct`,
      { ...this.opts('/internal/materials/deduct'), body: { accountId, material, qty, orderId } },
    );
    if (!res.ok) {
      throw new Error(res.body?.error ?? res.error ?? `deductMaterial failed: ${res.status}`);
    }
  }

  async grantMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void> {
    if (!this.baseUrl) return;
    const res = await fetchInternalJson(
      `${this.baseUrl}/internal/materials/grant`,
      { ...this.opts('/internal/materials/grant'), body: { accountId, material, qty, orderId } },
    );
    if (!res.ok) {
      // Delivery reliability (retry + compensation) is a later batch; for now make the loss visible.
      console.error('[auctionsvc] meta.grantMaterial failed', { accountId, material, qty, orderId, status: res.status, err: res.error });
    }
  }

  async escrowEquipment(accountId: string, instanceId: string, orderId: string): Promise<EquipmentInstance> {
    if (!this.baseUrl) throw new Error('meta service not configured');
    const res = await fetchInternalJson<{ instance?: EquipmentInstance; code?: string; error?: string }>(
      `${this.baseUrl}/internal/equipment/escrow`,
      { ...this.opts('/internal/equipment/escrow'), body: { accountId, instanceId, orderId } },
    );
    const body = res.body ?? {};
    if (!res.ok || !body.instance) {
      const code = body.code;
      if (code === 'EQUIP_LOCKED' || code === 'EQUIP_IN_USE' || code === 'EQUIP_NOT_FOUND') throw new SlgError(code);
      throw new SlgError('BAD_REQUEST', body.error ?? res.error ?? `escrowEquipment failed: ${res.status}`);
    }
    return body.instance;
  }

  async grantEquipment(accountId: string, instance: EquipmentInstance, orderId: string): Promise<void> {
    if (!this.baseUrl) return;
    const res = await fetchInternalJson(
      `${this.baseUrl}/internal/equipment/grant`,
      { ...this.opts('/internal/equipment/grant'), body: { accountId, instance, orderId } },
    );
    if (!res.ok) {
      console.error('[auctionsvc] meta.grantEquipment failed', { accountId, instanceId: instance.id, orderId, status: res.status, err: res.error });
    }
  }

  async escrowCard(accountId: string, instanceId: string, orderId: string): Promise<CardInstance> {
    if (!this.baseUrl) throw new Error('meta service not configured');
    const res = await fetchInternalJson<{ instance?: CardInstance; code?: string; error?: string }>(
      `${this.baseUrl}/internal/cards/escrow`,
      { ...this.opts('/internal/cards/escrow'), body: { accountId, instanceId, orderId } },
    );
    const body = res.body ?? {};
    if (!res.ok || !body.instance) {
      const code = body.code;
      if (code === ErrorCode.CARD_NOT_FOUND || code === ErrorCode.CARD_HAS_GEAR) throw new SlgError(code);
      throw new SlgError('BAD_REQUEST', body.error ?? res.error ?? `escrowCard failed: ${res.status}`);
    }
    return body.instance;
  }

  async grantCard(accountId: string, instance: CardInstance, orderId: string): Promise<void> {
    if (!this.baseUrl) return;
    const res = await fetchInternalJson(
      `${this.baseUrl}/internal/cards/grant`,
      { ...this.opts('/internal/cards/grant'), body: { accountId, instance, orderId } },
    );
    if (!res.ok) {
      console.error('[auctionsvc] meta.grantCard failed', { accountId, instanceId: instance.id, orderId, status: res.status, err: res.error });
    }
  }

  async escrowSkin(accountId: string, skinId: string, orderId: string): Promise<string> {
    if (!this.baseUrl) throw new Error('meta service not configured');
    const res = await fetchInternalJson<{ skinId?: string; code?: string; error?: string }>(
      `${this.baseUrl}/internal/skins/escrow`,
      { ...this.opts('/internal/skins/escrow'), body: { accountId, skinId, orderId } },
    );
    const body = res.body ?? {};
    if (!res.ok || !body.skinId) {
      const code = body.code;
      if (code === ErrorCode.SKIN_IN_USE || code === ErrorCode.SKIN_NOT_FOUND) throw new SlgError(code);
      throw new SlgError('BAD_REQUEST', body.error ?? res.error ?? `escrowSkin failed: ${res.status}`);
    }
    return body.skinId;
  }

  async grantSkin(accountId: string, skinId: string, orderId: string): Promise<void> {
    if (!this.baseUrl) return;
    const res = await fetchInternalJson(
      `${this.baseUrl}/internal/skins/grant`,
      { ...this.opts('/internal/skins/grant'), body: { accountId, skinId, orderId } },
    );
    if (!res.ok) {
      console.error('[auctionsvc] meta.grantSkin failed', { accountId, skinId, orderId, status: res.status, err: res.error });
    }
  }
}

export const nullAuctionMetaClient: AuctionMetaClient = {
  available: false,
  async deductMaterial() { throw new Error('meta service not configured'); },
  async grantMaterial() { /* no-op */ },
  async escrowEquipment() { throw new Error('meta service not configured'); },
  async grantEquipment() { /* no-op */ },
  async escrowCard() { throw new Error('meta service not configured'); },
  async grantCard() { /* no-op */ },
  async escrowSkin() { throw new Error('meta service not configured'); },
  async grantSkin() { /* no-op */ },
};
