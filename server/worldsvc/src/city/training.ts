// worldsvc home-city domain: training queue (S8-2). Split out of city.ts (2026-08-10, 独立类+组合 form,
// friendService.ts/familyService.ts's sibling — see city.ts's facade comment for why). Depends only on
// WorldCore. No behavior change.
import {
  playerWorldId,
  SlgError,
  TROOP_TRAIN_BATCH_MAX,
  trainQueueMaxFor,
  troopTrainCost,
  drillTrainMult,
  TROOP_TRAIN_TIME_SEC,
  TROOP_SPEEDUP_SECS_PER_COIN,
  RESOURCE_TYPES,
} from '@nw/shared';
import { WorldCore } from '../core';
import { trainingQueueOps, applyTrainingSpeedupCatchup, type TrainingEntry } from '../db';
import type { PlayerWorldView } from '../worldTypes';

export class CityTrainingService {
  constructor(private readonly core: WorldCore) {}

  /**
   * Enqueue a training batch. Consumes ink/paper/graphite/metal/sticker (troopTrainCost); scheduled at TROOP_TRAIN_TIME_SEC × qty.
   * Validation: joined world + qty is valid + queue slots not full + troops after training would not exceed troopCap + enough resources.
   */
  async trainTroops(worldId: string, accountId: string, qty: number): Promise<PlayerWorldView> {
    const { cols, now } = this.core.deps;
    qty = Math.max(1, Math.min(TROOP_TRAIN_BATCH_MAX, Math.floor(qty)));
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const t = now();
    // S8-8 fix (2026-08-08): fold in any train-speedup buff progress since the last touch before
    // validating/queuing — a batch the buff has already finished (only possible if the 2s scheduler tick
    // is lagging) must count toward `troops`/the cap check, not linger in the queue as a phantom slot.
    const settledFrom = pw.speedupSettledAt ?? t;
    const caughtUp = applyTrainingSpeedupCatchup(pw.trainingQueue ?? [], pw.speedupUntil, settledFrom, t);
    let extraTroopsReady = 0;
    const queue = caughtUp.filter((e) => {
      if (e.completeAt <= t) { extraTroopsReady += e.qty; return false; }
      return true;
    });
    const troops = pw.troops + extraTroopsReady;

    // drillYard raises the training queue slot count (SLG_CITY_DESIGN); falls back to TROOP_TRAIN_QUEUE_MAX with no buildings.
    if (queue.length >= trainQueueMaxFor(pw.buildings)) throw new SlgError('BAD_REQUEST', 'Training queue is full');

    const inTraining = queue.reduce((s, e) => s + e.qty, 0);
    if (troops + inTraining + qty > pw.troopCap) throw new SlgError('TROOP_CAP_REACHED', 'Troops after training would exceed the cap');

    const resources = this.core.settle(pw, t);
    const cost = troopTrainCost(qty);
    for (const rt of RESOURCE_TYPES) {
      if ((resources[rt] ?? 0) < (cost[rt] ?? 0)) throw new SlgError('INSUFFICIENT_RESOURCES', `Insufficient ${rt}`);
    }
    for (const rt of RESOURCE_TYPES) resources[rt] = (resources[rt] ?? 0) - (cost[rt] ?? 0);
    const inkCost = cost.ink ?? 0;

    // Training starts immediately after the previous (already buff-caught-up) batch finishes; if no batch
    // is in progress, start immediately. Note: this new entry's own duration is NOT pre-multiplied by the
    // buff — the buff instead speeds up the whole queue uniformly (via applyTrainingSpeedupCatchup) as
    // real time passes while it's active, which transparently covers entries added after purchase too.
    const lastComplete = queue.length > 0 ? queue[queue.length - 1]!.completeAt : t;
    // Battle pass bonus (S8-8): hasBattlePass → training speed +20% (duration ×0.8). drillYard further speeds training (SLG_CITY_DESIGN, ×drillTrainMult).
    const trainSpeedMult = (pw.hasBattlePass ? 0.8 : 1) * drillTrainMult(pw.buildings);
    const duration = Math.round(qty * TROOP_TRAIN_TIME_SEC * 1000 * trainSpeedMult);
    const entry: TrainingEntry = {
      qty,
      inkCost,
      startAt: lastComplete,
      completeAt: lastComplete + duration,
    };
    const nextQueue = [...queue, entry];
    const tq = trainingQueueOps(nextQueue);
    // rev-guard: resources/queue above were computed from this exact read (`pw`); a concurrent trainTroops/
    // upgradeBuilding/etc. call that lands first bumps rev, so this write must fail rather than silently
    // overwrite the other call's debit with a whole-object $set computed from stale resources (double-spend).
    const result = await cols.playerWorld.updateOne(
      { _id: pw._id, rev: pw.rev },
      {
        $set: { resources, troops, trainingQueue: nextQueue, speedupSettledAt: t, lastTickAt: t, ...tq.set },
        $inc: { rev: 1 },
      },
    );
    if (result.matchedCount === 0) throw new SlgError('REV_CONFLICT', 'Concurrent update, please retry');
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Spend coins to speed up training. Coins are converted to reduced duration (TROOP_SPEEDUP_SECS_PER_COIN seconds/coin);
   * time is subtracted from the front of the queue, with overflow carrying to the next batch. Expired batches are immediately dequeued and added to troops.
   * Calls commercial.spend() to deduct coins (no speedup if this fails).
   */
  async speedupTraining(worldId: string, accountId: string, coins: number, clientPlatform?: string): Promise<PlayerWorldView> {
    const { cols, now } = this.core.deps;
    coins = Math.max(1, Math.floor(coins));
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    const queue = pw.trainingQueue ?? [];
    if (queue.length === 0) throw new SlgError('BAD_REQUEST', 'No training queue in progress');

    // Battle pass bonus (S8-8): hasBattlePass → speedup costs 15% fewer coins (time per coin ÷0.85).
    const speedupDiscountMult = pw.hasBattlePass ? 1 / 0.85 : 1;
    const speedSec = coins * TROOP_SPEEDUP_SECS_PER_COIN * speedupDiscountMult;
    const orderId = `slg_speedup:${worldId}:${accountId}:${now()}`;
    await this.core.commercial.spend(accountId, coins, orderId, clientPlatform);

    // Coins are already spent at this point, so the finalize write below must eventually land — it's
    // rev-guarded (same reasoning as trainTroops/upgradeBuilding: resources/troops here are computed
    // from a point-in-time read, and an unguarded $set could silently revert a concurrent write) but,
    // unlike those, a conflict here can't just be thrown back at the caller as "please retry" since
    // the spend already happened — so retry the read+compute+write against a fresh doc a bounded
    // number of times instead of stranding the spend on the first stale write.
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const fresh = await cols.playerWorld.findOne({ _id: pw._id });
      if (!fresh) return this.core.getMe(worldId, accountId);

      const t = now();
      const resources = this.core.settle(fresh, t);
      // S8-8 fix: fold in any train-speedup buff progress since the last touch before spending coins on
      // top of it — otherwise this coin-based instant-skip would operate on stale (un-caught-up) completeAt
      // values and under-credit the buff's already-elapsed portion.
      const settledFrom = fresh.speedupSettledAt ?? t;
      const newQueue = applyTrainingSpeedupCatchup(fresh.trainingQueue ?? [], fresh.speedupUntil, settledFrom, t).slice();
      let remaining = speedSec * 1000;
      let troopsReady = 0;

      for (let i = 0; i < newQueue.length && remaining > 0; ) {
        const e = newQueue[i]!;
        const left = e.completeAt - t;
        if (remaining >= left) {
          remaining -= left;
          troopsReady += e.qty;
          newQueue.splice(i, 1);
        } else {
          newQueue[i] = { ...e, completeAt: e.completeAt - remaining };
          remaining = 0;
          i++;
        }
      }

      // Update startAt for remaining batches (cascade after compressing completeAt)
      for (let i = 1; i < newQueue.length; i++) {
        const prev = newQueue[i - 1]!;
        const cur = newQueue[i]!;
        const dur = cur.completeAt - cur.startAt;
        newQueue[i] = { ...cur, startAt: prev.completeAt, completeAt: prev.completeAt + dur };
      }

      const newTroops = Math.min(fresh.troopCap, fresh.troops + troopsReady);
      const tq = trainingQueueOps(newQueue);
      const result = await cols.playerWorld.updateOne(
        { _id: fresh._id, rev: fresh.rev },
        {
          $set: { resources, troops: newTroops, trainingQueue: newQueue, speedupSettledAt: t, lastTickAt: t, ...tq.set },
          $inc: { rev: 1 },
          ...(Object.keys(tq.unset).length ? { $unset: tq.unset } : {}),
        },
      );
      if (result.matchedCount > 0) break;
      if (attempt === MAX_ATTEMPTS - 1) throw new SlgError('REV_CONFLICT', 'Concurrent update, please retry');
    }
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Process completed training batches (called by the scheduler every 2s).
   * Iterate all playerWorld documents with a trainingQueue; extract batches where completeAt ≤ now;
   * atomically $inc troops + $pull completed entries. Returns the number of entries processed.
   *
   * S8-8 fix (2026-08-08): before the due-scan, first folds the train-speedup buff into every
   * buff-active player's persisted queue (applyTrainingSpeedupCatchup) — this is the sole place that
   * keeps the buff advancing for a player who isn't otherwise touching their queue (trainTroops/
   * speedupTraining/shop purchase all also catch up on their own read, but a player who does nothing
   * still needs the queue to speed up on the clock). Cheap: only docs that have ever bought a speedup
   * carry `speedupUntil` (partial index), so this is a small extra scan, not a full collection walk.
   */
  async processCompletedTraining(nowMs?: number): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();

    const buffed = await cols.playerWorld
      .find({ speedupUntil: { $exists: true }, nextTrainingCompleteAt: { $exists: true } })
      .project<{ _id: string; trainingQueue: TrainingEntry[]; speedupUntil?: number; speedupSettledAt?: number }>({
        _id: 1, trainingQueue: 1, speedupUntil: 1, speedupSettledAt: 1,
      })
      .toArray();
    for (const doc of buffed) {
      const settledFrom = doc.speedupSettledAt ?? t;
      const queue = applyTrainingSpeedupCatchup(doc.trainingQueue ?? [], doc.speedupUntil, settledFrom, t);
      if (queue === doc.trainingQueue) continue; // no-op catch-up (buff not active this window) — nothing to persist
      const tq = trainingQueueOps(queue);
      await cols.playerWorld.updateOne(
        { _id: doc._id },
        { $set: { trainingQueue: queue, speedupSettledAt: t, ...tq.set }, $inc: { rev: 1 } },
      );
    }

    // Find all players with a non-empty queue whose first entry has completed (the first entry finishes
    // earliest) — via the indexed `nextTrainingCompleteAt` mirror, not the array itself (see trainingQueueOps).
    // Re-read after the catch-up writes above so a buff-compressed completion is found in the same tick.
    const docs = await cols.playerWorld
      .find({ nextTrainingCompleteAt: { $lte: t } })
      .project<{ _id: string; troops: number; troopCap: number; trainingQueue: TrainingEntry[] }>({
        _id: 1, troops: 1, troopCap: 1, trainingQueue: 1,
      })
      .toArray();

    let n = 0;
    for (const doc of docs) {
      const queue = doc.trainingQueue ?? [];
      const done = queue.filter((e) => e.completeAt <= t);
      if (done.length === 0) continue;
      // 2026-08-24 (troop-duplication fix): credit + dequeue in ONE aggregation-pipeline update, computed
      // entirely from the LIVE document instead of the `docs` snapshot read above.
      //
      // The previous shape — an N-way `$pull` loop followed by `$set: { troops: <snapshot-derived absolute> }`
      // with only `_id` in the filter — was this collection's most exploitable race. `newTroops` came from
      // `doc.troops`, read at the top of the tick, before the buff catch-up write loop above and before one
      // `$pull` round-trip per completed batch; any `$inc: { troops: -n }` landing in that window (startMarch,
      // distributeTroops, occupyTile) was silently reverted by the absolute `$set` — the troops came back while
      // the march was already out. Duplication, on a window that recurs every 2s at a moment the player can
      // predict to the second off their own queue countdown. The stale `remaining` array carried a second,
      // quieter failure: a batch queued by a concurrent trainTroops in the same window was dropped from the
      // derived `nextTrainingCompleteAt` mirror (or the mirror was `$unset` outright), stranding it — invisible
      // to this indexed due-scan until the player happened to touch the queue again.
      //
      // Both vanish by never round-tripping the values through this process: `$filter` dequeues by the same
      // `completeAt <= t` predicate the snapshot used, the credited quantity is `$sum`med from the entries that
      // filter actually removes, the clamp reads the live `$troopCap` (so a concurrent drillYard upgrade is
      // honoured too), and the mirror is derived from the post-filter array. One atomic document update: no
      // intermediate state, no filter guard needed — and other writers' `$inc` deltas now survive, because this
      // write no longer carries an absolute value for anything.
      //
      // Pipeline updates (Mongo 4.2+) are a new idiom in this repo — they stay inside its "single-document CAS,
      // no cross-collection transactions" convention (see combatSiege/transfer.ts), which is what makes the
      // dropped guard safe rather than merely cheaper.
      const dueEntries = { $filter: { input: { $ifNull: ['$trainingQueue', []] }, as: 'e', cond: { $lte: ['$$e.completeAt', t] } } };
      const keptEntries = { $filter: { input: { $ifNull: ['$trainingQueue', []] }, as: 'e', cond: { $gt: ['$$e.completeAt', t] } } };
      await cols.playerWorld.updateOne({ _id: doc._id }, [
        {
          $set: {
            troops: { $min: ['$troopCap', { $add: ['$troops', { $sum: { $map: { input: dueEntries, as: 'e', in: '$$e.qty' } } }] }] },
            trainingQueue: keptEntries,
          },
        },
        {
          // Second stage so both expressions below read stage 1's already-filtered queue. `$$REMOVE` rather than
          // null keeps the partial index's `$exists` predicate honest: a null would still be indexed *and* would
          // still match the `{ $lte: t }` due-scan every tick (null sorts below numbers in BSON order).
          $set: {
            nextTrainingCompleteAt: { $cond: [{ $gt: [{ $size: '$trainingQueue' }, 0] }, { $min: '$trainingQueue.completeAt' }, '$$REMOVE'] },
            rev: { $add: ['$rev', 1] },
          },
        },
      ]);
      n += done.length;
    }
    return n;
  }
}
