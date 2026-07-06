// Skin escrow/grant backend (auction task2, AUCTION_DESIGN §2.1/§9). Skins have no level/affixes —
// they stay a plain string[] in SaveData.inventory.skins (no instance upgrade needed).
//
// Responsibilities:
//   · escrowSkin  auctionsvc/worldsvc auction escrow: verify owned + not equipped → remove from
//                 inventory.skins → orderId idempotent (replays return the first escrow result).
//   · grantSkin   auction trade transfer / listing cancellation·expiry return: $addToSet back into
//                 inventory.skins (naturally idempotent — re-granting the same id is a no-op).
import { EQUIPMENT_IDEM_TTL_SEC, type Collections, type SaveData } from '@nw/shared';

export type SkinErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'SKIN_NOT_FOUND' | 'SKIN_IN_USE' | 'REV_CONFLICT';

export interface SkinError {
  error: string;
  code: SkinErrorCode;
}

const REV_RETRIES = 3;

function idemExpireAt(now: number): Date {
  return new Date(now + EQUIPMENT_IDEM_TTL_SEC * 1000);
}

/** Whether `skinId` is currently equipped in any cosmetic slot (save.equipped: slot → skinId). */
function isSkinEquipped(save: SaveData, skinId: string): boolean {
  return Object.values(save.equipped ?? {}).includes(skinId);
}

/**
 * Auction escrow: verifies the account owns `skinId` and it is not equipped, then removes it
 * from `inventory.skins`. orderId idempotent: replays return the first escrow result without
 * re-checking ownership (the skin is already gone from inventory by then).
 */
export async function escrowSkin(
  cols: Collections,
  now: () => number,
  accountId: string,
  skinId: string,
  orderId: string,
): Promise<{ skinId: string } | SkinError> {
  if (!skinId || !orderId) return { error: 'skinId + orderId required', code: 'BAD_REQUEST' };

  // Replay
  const existing = await cols.equipmentIdem.findOne({ _id: orderId });
  if (existing?.op === 'skin_escrow') return existing.result as { skinId: string };

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;
    if (!(save.inventory?.skins ?? []).includes(skinId)) {
      // Concurrently escrowed (idem already written) → replay; otherwise the account genuinely does not own it.
      const replay = await cols.equipmentIdem.findOne({ _id: orderId });
      if (replay?.op === 'skin_escrow') return replay.result as { skinId: string };
      return { error: 'skin not owned', code: 'SKIN_NOT_FOUND' };
    }
    if (isSkinEquipped(save, skinId)) return { error: 'skin is equipped', code: 'SKIN_IN_USE' };

    const nextSkins = (save.inventory?.skins ?? []).filter((id) => id !== skinId);
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      inventory: { ...(save.inventory ?? { items: {} }), skins: nextSkins },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      await cols.equipmentIdem.updateOne(
        { _id: orderId },
        { $setOnInsert: { accountId, op: 'skin_escrow', result: { skinId }, expireAt: idemExpireAt(now()) } },
        { upsert: true },
      );
      return { skinId };
    }
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/**
 * Trade transfer (to buyer) / listing cancellation·expiry return (to seller): adds `skinId` back
 * into `inventory.skins`. `$addToSet`-equivalent dedup makes re-delivery of the same id a no-op,
 * so no separate idempotency ledger entry is needed here (unlike escrow, which must not double-remove).
 */
export async function grantSkin(
  cols: Collections,
  now: () => number,
  accountId: string,
  skinId: string,
): Promise<{ ok: true } | SkinError> {
  if (!skinId) return { error: 'skinId required', code: 'BAD_REQUEST' };
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;
    const curSkins = save.inventory?.skins ?? [];
    if (curSkins.includes(skinId)) return { ok: true }; // already owned, no-op
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      inventory: { ...(save.inventory ?? { items: {} }), skins: [...curSkins, skinId] },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { ok: true };
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}
