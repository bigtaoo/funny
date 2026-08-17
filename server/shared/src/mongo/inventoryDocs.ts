// Split 2026-08-10 out of shared/src/mongo.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Inventory/economy domain: idempotency ledgers for craft/escrow-style operations + the
// equipment/card/skin instance collections split out of the embedded SaveData maps (perf).
import type { Collection } from 'mongodb';
import type { EquipRarity } from '../equipment';
import type { Affix, GearSlotMap } from '../types';

/**
 * Card operation idempotency ledger (CC-2, CHARACTER_CARDS_DESIGN §3): prevents double-consumption of material cards
 * when the client retries a /cards/fuse request; also used by escrowCard (2026-08-03 fix, mirrors
 * equipment.ts's escrowEquipment) so a retried escrow request after a lost response replays the first
 * result instead of hitting CARD_NOT_FOUND on an already-deleted instance. _id = idempotencyKey / orderId.
 * TTL auto-expiry (7 days).
 */
export interface CardIdemDoc {
  _id: string; // idempotencyKey / orderId
  accountId: string;
  op: 'fuse' | 'escrow';
  result: unknown; // { targetId: string } for fuse; CardInstance for escrow
  expireAt: Date;
}

/**
 * Equipment operation idempotency ledger (E2, EQUIPMENT_DESIGN §18.2): for "consume materials + produce/move instance" operations such as
 * crafting/escrow, repeated requests replay the first result (no double deduction, no double roll). _id = idempotencyKey (craft) / orderId (escrow).
 * TTL auto-expiry (retained for N days, long enough to cover client retries + worldsvc return window).
 */
export interface EquipmentIdemDoc {
  _id: string; // idempotencyKey / orderId
  accountId: string;
  op: 'craft' | 'escrow' | 'enhance' | 'salvage' | 'reforge' | 'skin_escrow' | 'checkin_reward' | 'weekly_chest';
  /**
   * Snapshot of the first execution result, replayed verbatim on retry:
   *   craft          → produced instance (EquipmentInstance)
   *   escrow         → snapshot of the escrowed instance
   *   enhance        → { success, instance } (dice roll result + enhanced instance, E3)
   *   salvage        → { refunded } (total materials returned, E3)
   *   skin_escrow    → { skinId } (auction task2, AUCTION_DESIGN §2.1/§9)
   *   checkin_reward / weekly_chest → the picked concrete item (RetentionItemPick, liveops.ts) for a
   *     checkin card/equipment milestone or a weekly-chest equipment/skin tier
   */
  result: unknown;
  /**
   * For craft/enhance/reforge (2026-08-03 fix) and checkin_reward/weekly_chest (2026-08-05 fix): true
   * once the item has actually been granted. The claim doc is inserted (with `result` pre-computed)
   * *before* that grant so the roll/id stays deterministic across retries — but that means a concurrent
   * duplicate request hitting the insert's E11000 can no longer tell "the original already paid and
   * succeeded" apart from "the original is still mid-flight (or gave up) and never paid." Only
   * replay-grant the instance when this is true; otherwise the concurrent duplicate must not synthesize
   * a free item and should ask the caller to retry instead. escrow/salvage/skin_escrow write their idem
   * doc only after success, so they don't need this field (absent = irrelevant for those ops).
   */
  committed?: boolean;
  expireAt: Date; // BSON Date, TTL anchor
}

/**
 * Equipment instance, split out of `SaveData.equipmentInv` (perf, 2026-07-26): a heavy account's embedded
 * equipmentInv/cardInv pushed its save doc to 81KB, and Atlas M0 took ~650-1000ms to read/write it (vs
 * ~15-40ms for a tiny doc) — every save write (not just equipment ones) was paying to rewrite the whole
 * embedded map. `_id` = instanceId (unchanged from the old embedded-map key, so idempotencyKey-derived ids
 * still work everywhere). `locked` moved here too (was on the embedded instance). See `EQUIPMENT_DESIGN.md`
 * for the migration/ordering discipline (no Mongo transactions in this codebase — see this file's header
 * comment — so writes here are ordered per-operation to keep the worst case a benign count/drift, never a
 * duplicated or vanished item).
 */
export interface EquipmentInstanceDoc {
  _id: string; // instanceId
  accountId: string;
  defId: string;
  rarity: EquipRarity;
  level: number;
  affixes: Affix[];
  locked?: boolean;
  sourceType?: string;
  obtainedAt?: number;
}

/**
 * Skin instance, split out mirroring EquipmentInstanceDoc/CardInstanceDoc's storage pattern
 * (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08). No level/affixes/rarity to denormalize — skins have
 * none — so this is just `_id` (instanceId) + `skinId` + provenance. `_id` = instanceId.
 */
export interface SkinInstanceDoc {
  _id: string; // instanceId
  accountId: string;
  skinId: string;
  sourceType?: string;
  obtainedAt?: number;
}

/**
 * Material instance, mirroring EquipmentInstanceDoc/SkinInstanceDoc's storage pattern but scoped down
 * per `MaterialInstance`'s doc comment (shared/src/types.ts): `_id` = instanceId, one row per GRANT EVENT
 * (not per physical unit) — `count` carries that event's batch size. TTL-expired via `expireAt`
 * (`MATERIAL_INSTANCE_TTL_MS` in metaserver/src/material.ts has the retention-window rationale) — unlike
 * equipmentInstances/skinInstances, whose row deletion IS the item's actual removal (so they must live
 * exactly as long as the item does), a MaterialInstance is pure write-once history nothing ever reads
 * back to reconstruct current state, so it's safe to let rows expire outright instead of needing a
 * DELIVERED_ORDERS_CAP-style $push+$slice cap.
 */
export interface MaterialInstanceDoc {
  _id: string; // instanceId
  accountId: string;
  materialId: string;
  count: number;
  sourceType?: string;
  obtainedAt?: number;
  expireAt: Date; // TTL anchor (expireAfterSeconds: 0), see doc comment above
}

/**
 * Card instance, split out of `SaveData.cardInv` (perf, 2026-07-27 audit, same rationale + convention
 * as `EquipmentInstanceDoc` above): the Hero Roster (up to 500 cards) was a second unbounded contributor
 * to save-doc bloat on Atlas M0, alongside equipment. `_id` = instanceId (unchanged from the old embedded
 * map key). No Mongo transactions in this codebase (see this file's header) — cross-collection
 * consistency here follows the same ordering-discipline / idempotency house style as equipmentInstances.
 */
export interface CardInstanceDoc {
  _id: string; // instanceId
  accountId: string;
  defId: string;
  level: number;
  gear: GearSlotMap;
  locked: boolean;
  /**
   * Mirror of `Object.values(gear).filter(Boolean)` (2026-07-29, closes an equip-duplication race): kept in
   * lockstep with `gear` on every write so a unique multikey index on this field can enforce, at the Mongo
   * level, that no equipment instanceId is ever present in two cards' `gear` at once. Without this, the
   * pre-write "is this instance equipped elsewhere" check in equipEquipment (metaserver/src/equipment.ts) is
   * a plain read with no atomicity against a concurrent equip of the SAME instance onto a DIFFERENT card —
   * both requests could pass the check before either writes. Absent/empty arrays don't collide (sparse
   * multikey index contributes no entries for an empty array), so this self-heals on next touch for legacy
   * docs written before this field existed — no eager migration needed (same convention as march bbox).
   */
  gearInstanceIds?: string[];
  sourceType?: string;
  obtainedAt?: number;
}

/**
 * Internal grant idempotency ledger (comm-audit-internal-2026-07-28 batch D): dedups the orderId of
 * /internal/{materials,equipment,cards,skins}/grant calls so an internal caller (worldsvc/auctionsvc)
 * can safely retry after a timeout without double-granting. `_id` = orderId (caller-supplied, globally
 * unique per business operation). Inserted BEFORE the grant executes; deleted again if the grant fails,
 * so a failed attempt never blocks a retry. TTL 7 days — long enough to cover any realistic retry window.
 * `material_deduct` (2026-08-03 fix) covers /internal/materials/deduct, which used to accept an orderId
 * in its documented contract but never actually used it — a caller retry after a timeout could deduct
 * the same material twice for one logical transaction.
 */
export interface InternalGrantOrderDoc {
  _id: string; // orderId
  accountId: string;
  kind: 'material' | 'equipment' | 'card' | 'skin' | 'material_deduct';
  ts: number;
  expireAt: Date; // TTL anchor (7 days, expireAfterSeconds: 0)
}

/** Inventory/economy-domain indexes. */
export async function ensureInventoryIndexes(
  cardIdem: Collection<CardIdemDoc>,
  equipmentIdem: Collection<EquipmentIdemDoc>,
  internalGrantOrders: Collection<InternalGrantOrderDoc>,
  equipmentInstances: Collection<EquipmentInstanceDoc>,
  cardInstances: Collection<CardInstanceDoc>,
  skinInstances: Collection<SkinInstanceDoc>,
  materialInstances: Collection<MaterialInstanceDoc>,
): Promise<void> {
  // card operation idempotency ledger TTL auto-expiry (CC-2, expireAt is an absolute expiry time → expireAfterSeconds:0).
  await cardIdem.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  // equipment idempotency ledger TTL auto-expiry (E2, expireAt is an absolute expiry time → expireAfterSeconds:0).
  await equipmentIdem.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  // internal grant idempotency ledger TTL auto-expiry (7 days, see InternalGrantOrderDoc).
  await internalGrantOrders.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  // equipment instances: fetch-all-for-account (GET /save join, /internal/save-fields, migration, cap-count self-heal).
  await equipmentInstances.createIndex({ accountId: 1 });
  // card instances: fetch-all-for-account (GET /save join, /internal/save-fields, migration, cap-count self-heal).
  await cardInstances.createIndex({ accountId: 1 });
  // skin instances: fetch-all-for-account (GET /save skinCounts join) + per-skinId lookup (escrow/sell pick one instance).
  await skinInstances.createIndex({ accountId: 1, skinId: 1 });
  // material instances (ITEM_IDENTITY_DESIGN.md task2, 2026-08-10): per-account+materialId lookup for any
  // future CS/audit tooling, mirroring skinInstances' compound index. TTL auto-expiry (see MaterialInstanceDoc).
  await materialInstances.createIndex({ accountId: 1, materialId: 1 });
  await materialInstances.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  // unique multikey guard (2026-07-29): no equipment instanceId may appear in more than one card's
  // gearInstanceIds across the whole collection — the atomic backstop behind equipEquipment's pre-write
  // check (see CardInstanceDoc.gearInstanceIds doc comment). Sparse: docs without the field (not yet
  // touched by the new code) and empty arrays contribute no index entries, so this can't collide with
  // legacy data during rollout.
  await cardInstances.createIndex({ gearInstanceIds: 1 }, { unique: true, sparse: true });
}
