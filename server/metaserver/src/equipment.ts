// Equipment inventory backend (E2 crafting + worldsvc auction escrow/transfer). EQUIPMENT_DESIGN §3 / §6 / §18.
//
// Fully server-authoritative (L2): equipment instances are written exclusively by this module.
// There is no generic client-sync write endpoint at all (PUT /save removed) — see DECISIONS.md.
//
// Storage (2026-07-26, perf): instances live in the `equipmentInstances` collection (_id=instanceId),
// NOT embedded in SaveData.equipmentInv anymore — an embedded map blew up save-doc size (81KB for a
// heavy account) and every save write (not just equipment ones) paid to rewrite it on Atlas M0. `save`
// only carries an `equipmentInvCount` mirror for cheap cap checks. GET /save and /internal/save-fields
// still reassemble the full `equipmentInv` map on demand (`assembleEquipmentInv`) — those are the
// "pull the whole inventory once" points (login/refresh), so client/worldsvc get the complete map there
// unchanged. Every mutation function below (craft/enhance/salvage/reforge/equip) instead returns
// `equipmentInv: null` (`leanSave`, phase 2 of the split, 2026-07-26 — see EQUIPMENT_DESIGN.md §3.3):
// the caller already holds everything needed to update its own copy (the `instance` handed back, or the
// `instanceIds`/`materialId` it sent as request params), so paying for a fresh
// `equipmentInstances.find({accountId})` on every single-item craft/enhance just to re-hand back a
// 51KB map the caller already knows how to reconstruct is pure waste — both in bytes over the wire and
// in the query itself.
//
// No Mongo transactions in this codebase (see shared/src/mongo.ts header) — cross-collection consistency
// here relies on ordering discipline + idempotency, same house style as the existing equipmentIdem
// ledger: commit the costly/guarded side of an operation first (so a crash before the second write can
// only under-deliver, never over-deliver), and make every idempotent-replay branch *re-assert* the
// target state rather than trust that a prior attempt's second write actually landed ("verify-and-heal").
//
// Responsibilities (2026-08-09 split, 965→shell + 7 files, same "thin shell" convention as
// combatMarch/core — see claudedocs/server.md; no shared inheritance chain needed since each op
// is a standalone function, just a shared `equipment/helpers.ts`):
//   · equipment/craft.ts    craftEquipment   Player crafting (E2): deduct stationery materials → roll a +0 base item → add to inventory (300 cap). idemKey idempotent.
//   · equipment/trade.ts    escrowEquipment  worldsvc auction escrow (E2.5): verify not equipped/not locked → remove from seller inventory → return snapshot for worldsvc to store in the listing.
//                           grantEquipment   worldsvc trade transfer / listing cancellation/expiry return (E2.5): write instance snapshot into target account inventory (overwrite by id = idempotent).
//   · equipment/enhance.ts  enhanceEquipment Player enhancement (E3): server rolls dice (success rate table) → deduct materials + coins (commercial authoritative) → on success level+1. idemKey idempotent.
//   · equipment/salvage.ts  salvageEquipment Player salvage (E3): +0–4 items refund 70% crafting materials, remove from inventory (+5 rejected; equipped/locked rejected), batch. idemKey idempotent.
//   · equipment/equip.ts    equipEquipment   Player equip (E4): validate slot match → write gear.global[slot] (or byUnit); instanceId=null to unequip. Pure state change.
//   · equipment/reforge.ts  reforgeEquipment Player reforge (E6): consume same-slot lower-rarity material → re-roll secondary affixes (primary affix preserved). idemKey idempotent.
//   · equipment/helpers.ts  shared types (EquipError/EquipErrorCode) + toInstanceDoc/fromInstanceDoc/isEquipped/assembleEquipmentInv/leanSave/settleEquipCoins, used across the files above.
export * from './equipment/helpers.js';
export * from './equipment/craft.js';
export * from './equipment/trade.js';
export * from './equipment/enhance.js';
export * from './equipment/salvage.js';
export * from './equipment/equip.js';
export * from './equipment/reforge.js';
