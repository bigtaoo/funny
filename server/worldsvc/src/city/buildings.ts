// worldsvc home-city domain: buildings (SLG_CITY_DESIGN). Split out of city.ts (2026-08-10, 独立类+组合
// form, friendService.ts/familyService.ts's sibling — see city.ts's facade comment for why). Depends
// only on WorldCore. No behavior change.
import {
  playerWorldId,
  SlgError,
  BUILD_QUEUE_SLOTS,
  buildingLevel,
  buildGateReason,
  buildCost,
  buildTimeSec,
  BUILD_SPEEDUP_SECS_PER_COIN,
  RESOURCE_TYPES,
  troopCapFor,
  baseDurabilityMax,
  regenDurability,
  type BuildingKey,
} from '@nw/shared';
import { WorldCore } from '../core';
import { buildQueueOps, type BuildQueueEntry } from '../db';
import type { PlayerWorldView } from '../worldTypes';

export class CityBuildingsService {
  constructor(private readonly core: WorldCore) {}

  /**
   * Enqueue a building upgrade. Consumes season resources up-front; scheduled at buildTimeSec(key, toLevel).
   * Validation: joined world + key buildable + desk gate (toLevel ≤ desk level, desk ≤ DESK_MAX_LEVEL) + build queue not full + enough resources.
   * The target level chains on top of any pending upgrade of the same key already queued (forward-compatible with >1 build slot).
   */
  async upgradeBuilding(worldId: string, accountId: string, key: BuildingKey): Promise<PlayerWorldView> {
    const { cols, now } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const buildings = pw.buildings ?? { desk: 1 };
    const queue = pw.buildQueue ?? [];
    if (queue.length >= BUILD_QUEUE_SLOTS) throw new SlgError('BAD_REQUEST', 'Build queue is full');

    const pending = queue.filter((e) => e.key === key).length;
    const toLevel = buildingLevel(buildings, key) + pending + 1;
    const gate = buildGateReason(buildings, key, toLevel);
    if (gate) throw new SlgError('BAD_REQUEST', gate);

    const t = now();
    const resources = this.core.settle(pw, t);
    const cost = buildCost(key, toLevel);
    for (const rt of RESOURCE_TYPES) {
      if ((resources[rt] ?? 0) < (cost[rt] ?? 0)) throw new SlgError('INSUFFICIENT_RESOURCES', `Insufficient ${rt}`);
    }
    for (const rt of RESOURCE_TYPES) resources[rt] = (resources[rt] ?? 0) - (cost[rt] ?? 0);

    // Chain after the last queued build (or start now if idle), mirroring the training queue.
    const lastComplete = queue.length > 0 ? queue[queue.length - 1]!.completeAt : t;
    const duration = buildTimeSec(key, toLevel) * 1000;
    const entry: BuildQueueEntry = { key, toLevel, startAt: lastComplete, completeAt: lastComplete + duration };
    // Head is unaffected by appending unless the queue was empty (same reasoning as trainTroops).
    const { set: nextBuildCompleteAt } = buildQueueOps([queue[0] ?? entry]);
    // rev-guard: `resources` was computed from this exact read (`pw`). Without guarding the write on rev, two
    // concurrent upgradeBuilding calls both read the same pre-debit resources, both pass the sufficiency check,
    // and the second $set overwrites the first's already-debited resources with its own (also under-debited)
    // computation — net effect, a second building queues without an actual matching resource deduction.
    const result = await cols.playerWorld.updateOne(
      { _id: pw._id, rev: pw.rev },
      { $set: { resources, lastTickAt: t, ...nextBuildCompleteAt }, $push: { buildQueue: entry } as never, $inc: { rev: 1 } },
    );
    if (result.matchedCount === 0) throw new SlgError('REV_CONFLICT', 'Concurrent update, please retry');
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Spend coins to speed up the build queue (mirrors speedupTraining): coins → reduced duration (BUILD_SPEEDUP_SECS_PER_COIN s/coin,
   * hasBattlePass discount), time subtracted from the front with overflow cascading. Builds whose completeAt reaches now are applied immediately.
   */
  async speedupBuild(worldId: string, accountId: string, coins: number, clientPlatform?: string): Promise<PlayerWorldView> {
    const { cols, now } = this.core.deps;
    coins = Math.max(1, Math.floor(coins));
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    if (!pw.buildQueue || pw.buildQueue.length === 0) throw new SlgError('BAD_REQUEST', 'No build queue in progress');

    const speedupDiscountMult = pw.hasBattlePass ? 1 / 0.85 : 1;
    const speedSec = coins * BUILD_SPEEDUP_SECS_PER_COIN * speedupDiscountMult;
    const orderId = `slg_build_speedup:${worldId}:${accountId}:${now()}`;
    await this.core.commercial.spend(accountId, coins, orderId, clientPlatform);

    // Same reasoning as speedupTraining: coins are already spent, so rev-guard the finalize write and
    // retry against a fresh read a bounded number of times rather than stranding the spend.
    const MAX_ATTEMPTS = 5;
    let finalDocId = pw._id;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const fresh = await cols.playerWorld.findOne({ _id: pw._id });
      if (!fresh) return this.core.getMe(worldId, accountId);
      finalDocId = fresh._id;

      const t = now();
      const resources = this.core.settle(fresh, t);
      const newQueue = (fresh.buildQueue ?? []).slice();
      let remaining = speedSec * 1000;
      for (let i = 0; i < newQueue.length && remaining > 0; ) {
        const e = newQueue[i]!;
        const left = e.completeAt - t;
        if (remaining >= left) {
          remaining -= left;
          newQueue[i] = { ...e, completeAt: t }; // mark as due-now; applyDueBuilds will finalize it
          i++;
        } else {
          newQueue[i] = { ...e, completeAt: e.completeAt - remaining };
          remaining = 0;
          i++;
        }
      }
      // Cascade startAt/completeAt for remaining batches after compression.
      for (let i = 1; i < newQueue.length; i++) {
        const prev = newQueue[i - 1]!;
        const cur = newQueue[i]!;
        const dur = cur.completeAt - cur.startAt;
        newQueue[i] = { ...cur, startAt: prev.completeAt, completeAt: prev.completeAt + dur };
      }
      const bq = buildQueueOps(newQueue);
      const result = await cols.playerWorld.updateOne(
        { _id: fresh._id, rev: fresh.rev },
        {
          $set: { resources, buildQueue: newQueue, lastTickAt: t, ...bq.set },
          $inc: { rev: 1 },
          ...(Object.keys(bq.unset).length ? { $unset: bq.unset } : {}),
        },
      );
      if (result.matchedCount > 0) break;
      if (attempt === MAX_ATTEMPTS - 1) throw new SlgError('REV_CONFLICT', 'Concurrent update, please retry');
    }
    await this.applyDueBuilds(finalDocId, worldId, accountId);
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Process completed builds (scheduler, every tick). Mirrors processCompletedTraining: finds players whose first queued build is due,
   * applies the new levels + refreshes derived state (yield / troopCap). Returns the number of builds applied.
   */
  async processCompletedBuilds(nowMs?: number): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();
    // Via the indexed `nextBuildCompleteAt` mirror, not the array itself — see buildQueueOps.
    const docs = await cols.playerWorld
      .find({ nextBuildCompleteAt: { $lte: t } })
      .project<{ _id: string; worldId: string; accountId: string }>({ _id: 1, worldId: 1, accountId: 1 })
      .toArray();
    let n = 0;
    for (const doc of docs) {
      n += await this.applyDueBuilds(doc._id, doc.worldId, doc.accountId, t);
    }
    return n;
  }

  /**
   * Apply all builds whose completeAt ≤ t for one player: $set the new building levels, drop completed entries,
   * settle resources at the pre-upgrade rate, then refresh yieldRate (resource buildings + stickerShop) and troopCap (drillYard).
   * Returns the number of builds applied. Idempotent: re-entry after the entries are removed is a no-op.
   */
  private async applyDueBuilds(docId: string, worldId: string, accountId: string, nowMs?: number): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();
    const fresh = await cols.playerWorld.findOne({ _id: docId });
    if (!fresh) return 0;
    const done = (fresh.buildQueue ?? []).filter((e) => e.completeAt <= t);
    if (done.length === 0) return 0;

    const next: Partial<Record<BuildingKey, number>> = { ...(fresh.buildings ?? { desk: 1 }) };
    for (const e of done) next[e.key] = Math.max(next[e.key] ?? buildingLevel(fresh.buildings, e.key), e.toLevel);
    const newQueue = (fresh.buildQueue ?? []).filter((e) => e.completeAt > t);
    const resources = this.core.settle(fresh, t); // settle at the old rate/cap up to now, before the rate changes
    // Compute the post-upgrade yield from the new levels directly (buildings not yet persisted).
    const yieldRate = await this.core.recomputeYield(worldId, accountId, next, fresh.hasBattlePass);
    const bq = buildQueueOps(newQueue);
    await cols.playerWorld.updateOne(
      { _id: docId },
      {
        $set: { buildings: next, buildQueue: newQueue, resources, yieldRate, troopCap: troopCapFor(next), lastTickAt: t, ...bq.set },
        $inc: { rev: 1 },
        ...(Object.keys(bq.unset).length ? { $unset: bq.unset } : {}),
      },
    );
    // D-CITY-8: a completed `wall` upgrade raises durabilityMax — regen up to now, then apply the delta
    // (preserves absolute damage already taken instead of resetting to full), and rebase the regen anchor.
    if (done.some((e) => e.key === 'wall') && fresh.mainBaseTile) {
      const oldMax = baseDurabilityMax(buildingLevel(fresh.buildings, 'wall'));
      const newMax = baseDurabilityMax(buildingLevel(next, 'wall'));
      if (newMax !== oldMax) {
        const tile = await cols.tiles.findOne({ _id: fresh.mainBaseTile });
        if (tile) {
          const regened = regenDurability(tile.durability ?? oldMax, oldMax, tile.durabilityRegenAt ?? t, t);
          const durability = Math.min(newMax, regened + (newMax - oldMax));
          await cols.tiles.updateOne(
            { _id: fresh.mainBaseTile },
            { $set: { durability, durabilityMax: newMax, durabilityRegenAt: t }, $inc: { rev: 1 } },
          );
        }
      }
    }
    // Mirror the new desk level onto the anchor tile so the world map can render the matching
    // player-base art frame (playerbase_l{n}) — see TileDoc.deskLevel.
    if (done.some((e) => e.key === 'desk') && fresh.mainBaseTile) {
      await cols.tiles.updateOne(
        { _id: fresh.mainBaseTile },
        { $set: { deskLevel: buildingLevel(next, 'desk') }, $inc: { rev: 1 } },
      );
    }
    return done.length;
  }
}
