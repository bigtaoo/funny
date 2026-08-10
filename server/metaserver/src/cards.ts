// Character card roster operations (CC-2, CHARACTER_CARDS_DESIGN §3/§4).
//
// Storage (2026-07-27, perf, mirrors the equipmentInv split of 2026-07-26 — see equipment.ts header):
// instances live in the `cardInstances` collection (_id=instanceId), NOT embedded in SaveData.cardInv
// anymore — an embedded map of up to 500 cards was a second unbounded contributor to save-doc bloat on
// Atlas M0. `save` only carries a `cardInvCount` mirror for cheap cap checks. GET /save and
// /internal/save-fields still reassemble the full `cardInv` map on demand (`assembleCardInv`).
//
// No Mongo transactions in this codebase (see shared/src/mongo.ts header) — cross-collection consistency
// here relies on ordering discipline + idempotency, same house style as equipment.ts.
//
// Responsibilities (2026-08-10 split, 574→shell + 6 files, same "thin shell over independent functions"
// convention as equipment.ts — see claudedocs/server.md; no shared inheritance chain needed since each
// op is a standalone function, just a shared `cards/helpers.ts`):
//   · cards/query.ts    assembleCardInv, assembleCardInvSubset  Reassemble the wire-format cardInv map (full / id-filtered) from cardInstances.
//   · cards/grant.ts    grantCard   worldsvc auction trade transfer / listing cancellation·expiry·season-end return / mail claim: writes a full instance snapshot (mirrors equipment.ts grantEquipment).
//                       grantCards  Create CardInstances; handles roster cap with mail/coin-compensation overflow (caller delivers coins via commercial if compensatedCoins > 0).
//   · cards/lock.ts     setCardLock Toggle the lock flag on one card (mirrors no other collections).
//   · cards/escrow.ts   escrowCard  worldsvc auction escrow: validate gear all empty → remove from cardInstances → return snapshot (mirrors equipment.ts escrowEquipment).
//   · cards/fuse.ts     fuseCards   Consume exactly FUSION_MATERIAL_COUNT material cards (same faction, same level as the target) to raise the target one level; idempotencyKey prevents double-consumption.
//   · cards/helpers.ts  shared types (CardMailCtx/CardErrorCode/CardError) + toCardDoc/fromCardDoc/idemExpireAt/REV_RETRIES, used across the files above.
//
// grantCards/setCardLock/fuseCards/escrowCard use the optimistic-lock rev guard + retries pattern (same as equipment.ts).
// Shared pure math (applyFusion, FUSION_MATERIAL_COUNT) lives in @nw/shared/cards.
export * from './cards/helpers.js';
export * from './cards/query.js';
export * from './cards/grant.js';
export * from './cards/lock.js';
export * from './cards/escrow.js';
export * from './cards/fuse.js';
