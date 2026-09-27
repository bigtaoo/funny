// How many troops a bot trains next in the SLG world (BOTSVC_DESIGN §3.4 rule 8).
//
// Pure, like expansion.ts: the caller hands over `/world/me`, this mirrors worldsvc's own validation
// (city/training.ts trainTroops) so the bot only posts a batch the server will accept. Every occupation
// leaves its survivors on the tile as garrison, so without this a bot's pool only ever shrinks — until
// 2026-09-26 bots never trained and stalled after about six tiles.
import {
  RESOURCE_TYPES,
  TROOP_TRAIN_BATCH_MAX,
  troopCapFor,
  troopTrainCost,
  trainQueueMaxFor,
} from '@nw/shared';
import type { PlayerWorldView } from './worldClient';
import { EXPAND_MARCH_MIN_POOL } from './expansion';

/** The `/world/me` fields the decision reads — narrow, so worldsvc's own view type fits too (e2e). */
export type TrainingView = Pick<PlayerWorldView, 'troops' | 'troopCap' | 'buildings' | 'resources' | 'trainingQueue'>;

/**
 * Smallest batch worth a request. Below this the bot waits for more resources instead of queueing a
 * handful of troops into its only training slot and blocking a real batch behind it.
 */
export const TRAIN_MIN_BATCH = 100;

/**
 * Whether training goes before the building upgrade this turn (both spend the same resources): yes
 * while the pool, counting batches already in training, is too small to send a march.
 */
export function troopsFirst(me: TrainingView): boolean {
  const inTraining = (me.trainingQueue ?? []).reduce((s, e) => s + e.qty, 0);
  return (me.troops ?? 0) + inTraining < EXPAND_MARCH_MIN_POOL;
}

/** Resources per troop trained, by resource: `troopTrainCost(1)`. */
const COST_PER_TROOP = troopTrainCost(1);

/**
 * Troops this bot can train right now, or 0 when it should not post a batch: no free training slot,
 * no room under troopCap, or resources for fewer than TRAIN_MIN_BATCH.
 *
 * Mirrors the server: a batch counts against the cap together with the pool and everything still in
 * training, and every one of the five resources has to cover it.
 */
export function planTraining(me: TrainingView, now: number): number {
  const queue = me.trainingQueue ?? [];
  // A batch past its completeAt is waiting for worldsvc's 2s sweep; the server frees its slot on read.
  const running = queue.filter((e) => e.completeAt > now);
  if (running.length >= trainQueueMaxFor(me.buildings)) return 0;
  const cap = me.troopCap ?? troopCapFor(me.buildings);
  const inTraining = queue.reduce((s, e) => s + e.qty, 0);
  let qty = Math.min(TROOP_TRAIN_BATCH_MAX, cap - (me.troops ?? 0) - inTraining);
  const resources = me.resources ?? {};
  for (const rt of RESOURCE_TYPES) {
    const per = COST_PER_TROOP[rt] ?? 0;
    if (per > 0) qty = Math.min(qty, Math.floor((resources[rt] ?? 0) / per));
  }
  return qty >= TRAIN_MIN_BATCH ? qty : 0;
}
