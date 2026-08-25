// SLG troop training queue (S8-2, §4 troop cycle): per-troop resource + time costs, batch/slot caps, and
// the two purchasable speed-ups.
//
// Split out of `core.ts` (2026-08-25, "单文件 500 行收敛"): ADR-075's re-tune of TROOP_TRAIN_QUEUE_MAX and
// the doc comments explaining it pushed core.ts back past 500 lines (it had been brought to 479 on
// 2026-08-20 by extracting tileRender.ts). This block is pure constants with zero dependencies on the rest
// of core.ts, and its consumers (`city.ts`'s troopTrainCost/trainQueueMaxFor/drillTrainMult, worldsvc's
// city/training.ts, econ-sim's citySiege model) all reach it through the `index.ts` barrel — so the cut is
// the independent-function-module form (split-priority order: independent modules > composition > chain)
// and every import site is unchanged.
//
// ⚠️ Changing anything here invalidates two calibrations at once: the stronghold/crossing PvE gates
// (`econ-sim/src/strongholdCombatRun.ts`) and the ADR-074 wild-city siege curves
// (`econ-sim/src/citySiegeRun.ts`, whose whole single-player-proof margin is troop throughput divided by
// per-siege troop cost). Re-run both.

// ── Training queue (S8-2, §4 troop cycle) ──────────────────────────────
/** Ink cost per troop trained (sustain resource; DRAFT, tune after launch). */
export const TROOP_TRAIN_INK_COST = 10;
/** Paper cost per troop trained (wood, 2026-08-01 tune — building-material tax alongside ink). */
export const TROOP_TRAIN_PAPER_COST = 5;
/** Graphite cost per troop trained (stone, 2026-08-01 tune). */
export const TROOP_TRAIN_GRAPHITE_COST = 5;
/** Metal cost per troop trained (iron ore, 2026-08-01 tune). */
export const TROOP_TRAIN_METAL_COST = 5;
/** Sticker cost per troop trained (copper coin, 2026-08-01 tune — small token cost, sticker faucet is the scarcest). */
export const TROOP_TRAIN_STICKER_COST = 1;
/** Training time per troop (seconds, DRAFT). */
export const TROOP_TRAIN_TIME_SEC = 5;
/** Maximum troops per training batch (single-batch queue size cap). */
export const TROOP_TRAIN_BATCH_MAX = 5000;
/**
 * Base concurrent training batches (training queue slots) with no drillYard built; drillYard adds slots at
 * DRILL_QUEUE_LEVEL_THRESHOLDS. Must stay ≥1 — troopCap is nonzero before the drill yard exists, so a zero
 * base would make training unreachable for a fresh player.
 *
 * **2026-08-25 re-tune (2 → 1).** Slots are only worth anything up to `ceil(troopCap / TROOP_TRAIN_BATCH_MAX)`
 * — beyond that the cap check rejects the batch before the slot is ever used. When the 2026-07-22 tune raised
 * TROOP_TRAIN_BATCH_MAX 500 → 5000, that ceiling collapsed from 40 slots to 4 while the old
 * `2 + floor(drillYard/2)` curve kept handing out up to 7, i.e. 3 permanently dead slots at max level. The
 * curve is now 1 / 2 / 3 slots (see DRILL_QUEUE_LEVEL_THRESHOLDS), deliberately kept at or below that ceiling at
 * every level so every slot stays useful and refilling an empty pool never costs more than two sit-downs
 * (asserted in city-buildings.test.ts — the bound is the reason the curve is 1/2/3 and not something else).
 */
export const TROOP_TRAIN_QUEUE_MAX = 1;
/** Speed-up rate: seconds of training time per coin spent (DRAFT, 60 s/coin). */
export const TROOP_SPEEDUP_SECS_PER_COIN = 60;
/**
 * Train-speedup shop buff multiplier (S8-8 fix, 2026-08-08): while a player's `speedupUntil` is in the
 * future, the training queue advances at this multiple of real-time speed — the shop items
 * (`slg_speedup_1h/8h/24h`) only differ in price/duration, not in how much faster training gets. Replaces
 * the earlier (incorrect) implementation that spent the whole duration as a one-time instant-skip against
 * whatever was queued at purchase time, which didn't match the item description ("speed up training for
 * N hours") — see worldsvc CityService.trainTroops/processCompletedTraining + ShopService.buySlgShopItem.
 */
export const TRAIN_SPEEDUP_BUFF_MULT = 2;
/**
 * Instant-return rate for a 'return' march (2026-08-01, SLG_DESIGN_LOG §46): seconds of remaining travel time
 * per coin spent. Same DRAFT rate as TROOP_SPEEDUP_SECS_PER_COIN, kept as its own constant so the two economies
 * can be tuned independently.
 */
export const MARCH_RETURN_SPEEDUP_SECS_PER_COIN = 60;
