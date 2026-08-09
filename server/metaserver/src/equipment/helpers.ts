// Shared types + helpers for the equipment/* split (see ../equipment.ts for the module overview).
import {
  EQUIPMENT_IDEM_TTL_SEC,
  EQUIP_SLOTS,
  type Collections,
  type SaveData,
  type EquipmentInstance,
  type EquipmentInstanceDoc,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { mirrorCoins } from '../economy.js';
import type { CommercialClient } from '../commercialClient.js';

/** Business error codes (HTTP mapping is handled in the router layer). */
export type EquipErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'NOT_IMPLEMENTED'
  | 'EQUIP_NOT_FOUND'
  | 'INSUFFICIENT_MATERIALS'
  | 'INSUFFICIENT_FUNDS'
  | 'INVENTORY_FULL'
  | 'EQUIP_LOCKED'
  | 'EQUIP_IN_USE'
  | 'ENHANCE_MAX_LEVEL'
  | 'NOT_SALVAGEABLE'
  | 'NOT_REFORGE_ELIGIBLE'
  | 'INVALID_SLOT'
  | 'INVALID_RARITY'
  | 'INVALID_MATERIAL_LEVEL'
  | 'REV_CONFLICT';

export interface EquipError {
  error: string;
  code: EquipErrorCode;
}

export const REV_RETRIES = 3;

export function idemExpireAt(now: number): Date {
  return new Date(now + EQUIPMENT_IDEM_TTL_SEC * 1000);
}

export function toInstanceDoc(instance: EquipmentInstance, accountId: string): EquipmentInstanceDoc {
  return {
    _id: instance.id,
    accountId,
    defId: instance.defId,
    rarity: instance.rarity,
    level: instance.level,
    affixes: instance.affixes,
    ...(instance.locked !== undefined ? { locked: instance.locked } : {}),
    ...(instance.sourceType !== undefined ? { sourceType: instance.sourceType } : {}),
    ...(instance.obtainedAt !== undefined ? { obtainedAt: instance.obtainedAt } : {}),
  };
}

export function fromInstanceDoc(doc: EquipmentInstanceDoc): EquipmentInstance {
  return {
    id: doc._id,
    defId: doc.defId,
    rarity: doc.rarity,
    level: doc.level,
    affixes: doc.affixes,
    ...(doc.locked !== undefined ? { locked: doc.locked } : {}),
    ...(doc.sourceType !== undefined ? { sourceType: doc.sourceType } : {}),
    ...(doc.obtainedAt !== undefined ? { obtainedAt: doc.obtainedAt } : {}),
  };
}

/**
 * Reassembles the full equipmentInv map from `equipmentInstances`, for wire-format compatibility
 * (phase 1 of the storage split keeps every player-facing response shape unchanged). Also opportunistically
 * self-heals `equipmentInvCount` drift (a plain field $set, no rev guard — it's an informational mirror
 * never used as a lock, so this can never spuriously conflict with a real optimistic-lock write) since this
 * call already has the true count in hand.
 */
export async function assembleEquipmentInv(
  cols: Collections,
  accountId: string,
  save?: SaveData,
): Promise<Record<string, EquipmentInstance>> {
  const docs = await cols.equipmentInstances.find({ accountId }).toArray();
  const inv: Record<string, EquipmentInstance> = {};
  for (const doc of docs) inv[doc._id] = fromInstanceDoc(doc);
  if (save && save.equipmentInvCount !== docs.length) {
    await cols.saves.updateOne({ _id: accountId }, { $set: { 'save.equipmentInvCount': docs.length } });
  }
  return inv;
}

/**
 * Marks a mutation response as intentionally not carrying the full equipmentInv map (phase 2 of the
 * storage split, EQUIPMENT_DESIGN §3.3): the caller already has everything it needs to update its local
 * copy — the returned/consumed `instance`(s) for craft/enhance/reforge, or the `instanceIds`/`materialId`
 * it sent as request params for salvage/reforge/equip — so there is no need to pay for an
 * `equipmentInstances.find({accountId})` just to hand back a map the caller can reconstruct for free.
 * `null` (not simply omitting the field) is required so the `app.ts` preSerialization backstop — which
 * fills in the full map whenever `equipmentInv === undefined` — knows this response opted out on purpose.
 */
export function leanSave(save: SaveData): SaveData {
  return { ...save, equipmentInv: null };
}

/**
 * Returns whether an equipment instance is currently equipped by any card in the Hero Roster.
 * cardInv moved to its own `cardInstances` collection (2026-07-27 split, cards.ts) — queries directly
 * for a card whose gear references this instance (one of the fixed EQUIP_SLOTS keys), instead of
 * scanning an in-memory map that no longer exists on the save document.
 */
export async function isEquipped(cols: Collections, accountId: string, instanceId: string): Promise<boolean> {
  const match = await cols.cardInstances.findOne({
    accountId,
    $or: EQUIP_SLOTS.map((slot) => ({ [`gear.${slot}`]: instanceId })),
  });
  return !!match;
}

/** Deducts equipment operation coins (commercial authoritative, orderId=idemKey idempotent) + writes mirror; if commercial is unavailable/fails, the mirror is not updated. */
export async function settleEquipCoins(
  cols: Collections,
  commercial: CommercialClient,
  now: () => number,
  accountId: string,
  idempotencyKey: string,
  coins: number,
  reason = 'equip_enhance',
  clientPlatform?: string,
): Promise<SaveData> {
  if (coins > 0 && commercial.available) {
    const charge = await commercial.spend({ accountId, amount: coins, reason, orderId: idempotencyKey, clientPlatform });
    if (charge.ok) return mirrorCoins(cols, accountId, charge.coinsAfter, now());
  }
  return getOrCreateSave(cols, accountId, now());
}
