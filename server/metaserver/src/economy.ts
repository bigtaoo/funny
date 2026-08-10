// Economy orchestration helpers (S5-5). meta delivers items based on commercial receipts
// (inventory is meta-authoritative) + writes the wallet mirror + reconciles undelivered orders.
// Key invariants:
//  • Delivery is idempotent — deliverGrant/deliverMailGrant gate their whole write on
//    `'save.deliveredOrders': { $ne: orderId }`, so a re-run of the same orderId (concurrent
//    reconcileUndelivered racing an in-flight delivery, or a caller retry) is a no-op, not just for
//    the $addToSet'd skins but also the $inc'd materials/items (fixed 2026-08-03; deliveredOrders was
//    previously write-only and this guard did not exist, allowing double-delivery under concurrency).
//  • Wallet mirror — wallet.coins / gacha.pity are authoritative in commercial; meta only writes
//    the mirror section after a receipt, for offline display.
//  • Skin duplicates (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08): every gacha skin result — first
//    pull or dupe alike — now grants a real SkinInstance (see skin.ts); the old design where a
//    duplicate was silently dropped (no item, no coin refund, despite GACHA_DESIGN §4.3 describing an
//    auto-refund that was never actually wired up) is gone. Cashing in a surplus copy for coins is a
//    separate, player-initiated action (skin.ts sellSkinToSystem), never automatic.
//
// ── Split (2026-08-10, independent function module range: last two of the original 30-file audit) ──
// This file was already a set of mutually-independent exported functions grouped by concern (no class,
// no shared private state) — a textbook independent-function-module split, by concern:
// - economy/duplicates.ts: markDuplicates + unionOwnershipForDuplicateCheck (gacha NEW-badge bookkeeping)
// - economy/delivery.ts:   deliverGrant/deliverMailGrant/mirrorCoins/mirrorWalletFrom (idempotent
//                          delivery + wallet-mirror primitives)
// - economy/orders.ts:     deliverLootBox/deliverOrder/reconcileUndelivered (routes one loot-box result
//                          set or one full order to the delivery.ts primitives above)
// - economy/adsGate.ts:    adsDayKey/bumpAdsCap/hashAdToken/recordAdToken/checkAdInterval/peekAdsStatus
//                          (rewarded-ad daily cap/dedup/cooldown, C2)
// `export *` below re-exports every sibling's public API, same shape as the `equipment.ts`/`accounts.ts`
// precedents; external import paths (`from '../economy.js'` / `from './economy.js'`, ~10 call sites
// across ads.ts/paddle.ts/equipment/helpers.ts/internal/matchReport + several service/*.ts mixins) are
// unaffected.
export * from './economy/duplicates.js';
export * from './economy/delivery.js';
export * from './economy/orders.js';
export * from './economy/adsGate.js';
