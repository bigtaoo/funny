// Skin instance backend (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08 — supersedes the original
// auction-task2 plain-Set design, see git history for the pre-instantiation version). Skins have no
// level/affixes, so a SkinInstance is just an id + skinId + provenance (types.ts SkinInstance doc
// comment) — but unlike the original design, a "duplicate" gacha pull is now a real, separately-held
// instance instead of being silently dropped. That silent drop was the actual bug reported (a
// duplicate skin vanished — no item in the bag, no coin refund, despite GACHA_DESIGN §4.3 describing
// one): `markDuplicates` filtered dupes out of `newSkins` and only `newSkins` was ever delivered, while
// the "convert dupes to coins" half of that design was never wired up either (see economy.ts's old
// "deferred to S5" comment — DUPE_REFUND_COINS existed but only in the offline econ-sim, never in the
// live delivery path). `SaveData.inventory.skins` (plain dedup string[]) is preserved unchanged as the
// "do I own at least one" view every pre-existing consumer reads (equip picker, everOwned, auctionsvc's
// contract, etc.) — this module keeps it in sync as instances come and go, self-healing legacy accounts
// that predate skinInstances entirely (no SAVE_VERSION migration needed).
//
// Responsibilities:
//   · escrowSkin        auctionsvc auction escrow: verify owned + (if the last remaining instance is
//                        currently equipped) reject → remove exactly one instance → orderId idempotent.
//                        auctionsvc's contract stays skinId-in/skinId-out (AUCTION_DESIGN §2.1) — no
//                        instanceId is exposed cross-service, since all instances of one skinId are
//                        fungible (no level/affixes to distinguish them).
//   · grantSkin         auction trade transfer / listing cancellation·expiry return: mints a fresh
//                        instance (fungible — need not be the SAME one that was escrowed).
//   · countSkinInstances / assembleSkinCounts: read helpers for the GET /save skinCounts join.
//
// A surplus skin has exactly one outlet: listing it on the auction house. The former "sell to system
// for DUPE_REFUND_COINS" shortcut (POST /skins/sell, 2026-08-08 — ITEM_IDENTITY_DESIGN.md task1) was
// removed on 2026-08-15: the duplicate-refund table it reused pays out far below what a skin is
// actually worth on the market, so the shortcut only ever served to destroy value by accident.
import { randomUUID } from 'node:crypto';
import {
  EQUIPMENT_IDEM_TTL_SEC,
  type Collections, type SaveData, type SkinInstance, type SkinInstanceDoc,
} from '@nw/shared';

export type SkinErrorCode =
  | 'BAD_REQUEST' | 'NOT_FOUND' | 'SKIN_NOT_FOUND' | 'SKIN_IN_USE' | 'REV_CONFLICT';

export interface SkinError {
  error: string;
  code: SkinErrorCode;
}

const REV_RETRIES = 3;

function idemExpireAt(now: number): Date {
  return new Date(now + EQUIPMENT_IDEM_TTL_SEC * 1000);
}

export function toInstanceDoc(instance: SkinInstance, accountId: string): SkinInstanceDoc {
  return {
    _id: instance.id,
    accountId,
    skinId: instance.skinId,
    ...(instance.sourceType !== undefined ? { sourceType: instance.sourceType } : {}),
    ...(instance.obtainedAt !== undefined ? { obtainedAt: instance.obtainedAt } : {}),
  };
}

/** Whether `skinId` is currently equipped in any cosmetic slot (save.equipped: slot → skinId). */
function isSkinEquipped(save: SaveData, skinId: string): boolean {
  return Object.values(save.equipped ?? {}).includes(skinId);
}

/** Number of instances of `skinId` currently owned by `accountId`. */
export async function countSkinInstances(cols: Collections, accountId: string, skinId: string): Promise<number> {
  return cols.skinInstances.countDocuments({ accountId, skinId });
}

/**
 * GET /save join (mirrors assembleEquipmentInv/assembleCardInv): skinId → instance count for this
 * account. Self-heals a legacy account that predates skinInstances (every save before 2026-08-08) by
 * minting exactly one legacy instance per `inventory.skins` entry that has zero instance rows —
 * `$setOnInsert` makes this idempotent, so repeated calls across concurrent requests never mint more
 * than one. No SAVE_VERSION bump needed, same "verify-and-heal on read" convention as equipmentInvCount
 * drift (equipment.ts's assembleEquipmentInv doc comment).
 */
export async function assembleSkinCounts(
  cols: Collections,
  accountId: string,
  save: SaveData,
): Promise<Record<string, number>> {
  const docs = await cols.skinInstances.find({ accountId }).toArray();
  const counts: Record<string, number> = {};
  for (const doc of docs) counts[doc.skinId] = (counts[doc.skinId] ?? 0) + 1;
  const owned = save.inventory?.skins ?? [];
  const missing = owned.filter((id) => !counts[id]);
  if (missing.length > 0) {
    await Promise.all(missing.map((skinId) => {
      const instance: SkinInstance = { id: `skin_legacy_${accountId}_${skinId}`, skinId, sourceType: 'legacy' };
      return cols.skinInstances
        .updateOne({ _id: instance.id }, { $setOnInsert: toInstanceDoc(instance, accountId) }, { upsert: true })
        .catch(() => { /* best-effort backfill; a failed insert here just means the next read retries it */ });
    }));
    for (const id of missing) counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

/**
 * Auction escrow: verifies the account owns at least one instance of `skinId` — real instance rows if
 * any exist, else falls back to `inventory.skins` membership for a legacy account not yet backfilled
 * (effectiveCount=1) — and refuses only when removing one would drop a *currently equipped* skin to
 * zero remaining copies. Otherwise removes exactly one instance (an arbitrary one — all instances of a
 * skinId are fungible). orderId idempotent: replays return the first escrow result.
 */
export async function escrowSkin(
  cols: Collections,
  now: () => number,
  accountId: string,
  skinId: string,
  orderId: string,
): Promise<{ skinId: string } | SkinError> {
  if (!skinId || !orderId) return { error: 'skinId + orderId required', code: 'BAD_REQUEST' };

  const existing = await cols.equipmentIdem.findOne({ _id: orderId });
  if (existing?.op === 'skin_escrow') return existing.result as { skinId: string };

  const doc0 = await cols.saves.findOne({ _id: accountId });
  if (!doc0) return { error: 'save not found', code: 'NOT_FOUND' };
  if (!(doc0.save.inventory?.skins ?? []).includes(skinId)) {
    // Concurrently escrowed (idem already written) → replay; otherwise genuinely not owned.
    const replay = await cols.equipmentIdem.findOne({ _id: orderId });
    if (replay?.op === 'skin_escrow') return replay.result as { skinId: string };
    return { error: 'skin not owned', code: 'SKIN_NOT_FOUND' };
  }
  const count = await countSkinInstances(cols, accountId, skinId);
  const effectiveCount = Math.max(count, 1); // legacy self-heal — see assembleSkinCounts
  if (isSkinEquipped(doc0.save, skinId) && effectiveCount <= 1) {
    return { error: 'skin is equipped', code: 'SKIN_IN_USE' };
  }

  // Destructive op up front, once (idempotent — a re-run finds nothing left to delete), mirroring
  // escrowEquipment's ordering discipline: a crash after this line can only under-deliver (benign
  // inventory.skins/idem-record drift below), never leave a duplicated/still-visible item.
  const inst = await cols.skinInstances.findOne({ accountId, skinId });
  if (inst) await cols.skinInstances.deleteOne({ _id: inst._id });

  await cols.equipmentIdem.updateOne(
    { _id: orderId },
    { $setOnInsert: { accountId, op: 'skin_escrow', result: { skinId }, expireAt: idemExpireAt(now()) } },
    { upsert: true },
  );

  const remaining = effectiveCount - 1;
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) break;
    const save = doc.save;
    const nextSkins = remaining > 0
      ? (save.inventory?.skins ?? [])
      : (save.inventory?.skins ?? []).filter((id) => id !== skinId);
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
    if (res) return { skinId };
    // rev conflict → re-read and retry the membership-array update only (the delete above never repeats).
  }
  // Retries exhausted: the escrow itself (instance delete + idem record) already committed above,
  // unconditionally — inventory.skins is a mirror that self-heals via assembleSkinCounts, so report
  // success rather than REV_CONFLICT for an operation that already happened (mirrors escrowEquipment).
  return { skinId };
}

/**
 * Trade transfer (to buyer) / listing cancellation·expiry return (to seller): mints a fresh skin
 * instance into skinInstances + `inventory.skins`. Skins are fungible (no level/affixes), so the
 * granted instance need not be the SAME one that was escrowed. orderId-derived instance id keeps this
 * idempotent — a retry with the same orderId re-asserts the same instance instead of minting a second
 * (orderId is optional only for back-compat with call sites that don't have one; the internal route's
 * own orderId-level dedup, economyRoutes.ts reserveGrantOrder, is what actually protects the common path).
 */
export async function grantSkin(
  cols: Collections,
  now: () => number,
  accountId: string,
  skinId: string,
  orderId?: string,
): Promise<{ ok: true } | SkinError> {
  if (!skinId) return { error: 'skinId required', code: 'BAD_REQUEST' };
  const instance: SkinInstance = { id: `skin_grant_${orderId ?? randomUUID()}`, skinId, sourceType: 'auction_return', obtainedAt: now() };

  // Ordering matters (2026-09-03 fix): this used to mint the instance row FIRST and only discover a
  // missing save inside the loop below. The 404 that produced correctly released auctionsvc's grant
  // reservation and invited a retry — but the retry then found the orphan row left by the failed
  // attempt, short-circuited on it, and answered 200 without ever putting the id in `inventory.skins`.
  // Since inventory.skins is this module's "do I own at least one" view (equip picker / everOwned /
  // auctionsvc contract all read it, and assembleSkinCounts only self-heals the other direction), the
  // trade read as delivered while the skin stayed invisible and unequippable forever.
  if (!(await cols.saves.findOne({ _id: accountId }))) return { error: 'save not found', code: 'NOT_FOUND' };
  // The mint is idempotent by id, and the loop below is a no-op once inventory.skins already has the
  // id — so there is deliberately no `already`-guard early return here any more: falling through is
  // what reconciles inventory.skins for a retry (and heals an orphan minted before this fix).
  await cols.skinInstances.updateOne({ _id: instance.id }, { $set: toInstanceDoc(instance, accountId) }, { upsert: true });

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;
    const curSkins = save.inventory?.skins ?? [];
    // Lifetime skin-owned ledger (avatar unlock): unnecessary to write on the already-owned no-op
    // return below (it's already in inventory.skins, itself sufficient there), but this path also
    // covers "bought back after selling" — everOwned.skin must gain the id here too in case it somehow
    // never got there (e.g. a skin granted before this ledger existed).
    if (curSkins.includes(skinId)) return { ok: true }; // another instance already present, no save write needed
    const everOwnedSkin = new Set(save.everOwned?.skin ?? []);
    everOwnedSkin.add(skinId);
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      inventory: { ...(save.inventory ?? { items: {} }), skins: [...curSkins, skinId] },
      everOwned: { ...save.everOwned, skin: [...everOwnedSkin] },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { ok: true };
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}
