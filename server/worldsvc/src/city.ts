// worldsvc home-city domain: training queue (S8-2) + buildings (SLG_CITY_DESIGN) + teams/cards (G3-2c / CC-3).
// Peeled out of the WorldService god-class (2026-07-03). Depends only on WorldCore. No behavior change.
import {
  playerWorldId,
  SlgError,
  TROOP_TRAIN_BATCH_MAX,
  trainQueueMaxFor,
  TROOP_TRAIN_INK_COST,
  drillTrainMult,
  TROOP_TRAIN_TIME_SEC,
  TROOP_SPEEDUP_SECS_PER_COIN,
  BUILD_QUEUE_SLOTS,
  buildingLevel,
  buildGateReason,
  buildCost,
  buildTimeSec,
  BUILD_SPEEDUP_SECS_PER_COIN,
  RESOURCE_TYPES,
  troopCapFor,
  SIEGE_TEAM_CAP,
  CARD_TEAM_MAX_SIZE,
  CARD_TROOP_PAPER_COST,
  CARD_TROOP_GRAPHITE_COST,
  CARD_TROOP_METAL_COST,
  CARD_TROOP_REFUND_RATE,
  CARD_RECOVER_COIN_COST,
  type BuildingKey,
} from '@nw/shared';
import { validateAttackerArmy } from './siegeEngine';
import { WorldCore } from './core';
import type { TrainingEntry, BuildQueueEntry, TeamTemplate } from './db';
import type { PlayerWorldView } from './worldTypes';

export class CityService {
  constructor(private readonly core: WorldCore) {}

  // ── S8-2: training queue ────────────────────────────────────────

  /**
   * Enqueue a training batch. Consumes ink; scheduled at TROOP_TRAIN_TIME_SEC × qty.
   * Validation: joined world + qty is valid + queue slots not full + troops after training would not exceed troopCap + enough ink.
   */
  async trainTroops(worldId: string, accountId: string, qty: number): Promise<PlayerWorldView> {
    const { cols, now } = this.core.deps;
    qty = Math.max(1, Math.min(TROOP_TRAIN_BATCH_MAX, Math.floor(qty)));
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const queue = pw.trainingQueue ?? [];
    // drillYard raises the training queue slot count (SLG_CITY_DESIGN); falls back to TROOP_TRAIN_QUEUE_MAX with no buildings.
    if (queue.length >= trainQueueMaxFor(pw.buildings)) throw new SlgError('BAD_REQUEST', 'Training queue is full');

    const inTraining = queue.reduce((s, e) => s + e.qty, 0);
    if (pw.troops + inTraining + qty > pw.troopCap) throw new SlgError('TROOP_CAP_REACHED', 'Troops after training would exceed the cap');

    const t = now();
    const resources = this.core.settle(pw, t);
    const inkCost = qty * TROOP_TRAIN_INK_COST;
    if ((resources.ink ?? 0) < inkCost) throw new SlgError('INSUFFICIENT_RESOURCES', 'Insufficient ink');
    resources.ink = (resources.ink ?? 0) - inkCost;

    // Training starts immediately after the previous batch finishes (chained queue); if no batch is in progress, start immediately.
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
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      {
        $set: { resources, lastTickAt: t },
        $push: { trainingQueue: entry } as never,
        $inc: { rev: 1 },
      },
    );
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Spend coins to speed up training. Coins are converted to reduced duration (TROOP_SPEEDUP_SECS_PER_COIN seconds/coin);
   * time is subtracted from the front of the queue, with overflow carrying to the next batch. Expired batches are immediately dequeued and added to troops.
   * Calls commercial.spend() to deduct coins (no speedup if this fails).
   */
  async speedupTraining(worldId: string, accountId: string, coins: number): Promise<PlayerWorldView> {
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
    await this.core.commercial.spend(accountId, coins, orderId);

    // Re-fetch latest doc from Mongo (may have changed during the spend call; ensures idempotency)
    const fresh = await cols.playerWorld.findOne({ _id: pw._id });
    if (!fresh) return this.core.getMe(worldId, accountId);

    const t = now();
    const resources = this.core.settle(fresh, t);
    const newQueue = (fresh.trainingQueue ?? []).slice();
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
    await cols.playerWorld.updateOne(
      { _id: fresh._id },
      { $set: { resources, troops: newTroops, trainingQueue: newQueue, lastTickAt: t }, $inc: { rev: 1 } },
    );
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Process completed training batches (called by the scheduler every 2s).
   * Iterate all playerWorld documents with a trainingQueue; extract batches where completeAt ≤ now;
   * atomically $inc troops + $pull completed entries. Returns the number of entries processed.
   */
  async processCompletedTraining(nowMs?: number): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();
    // Find all players with a non-empty queue whose first entry has completed (the first entry finishes earliest)
    const docs = await cols.playerWorld
      .find({ 'trainingQueue.0.completeAt': { $lte: t } })
      .project<{ _id: string; troops: number; troopCap: number; trainingQueue: TrainingEntry[] }>({
        _id: 1, troops: 1, troopCap: 1, trainingQueue: 1,
      })
      .toArray();

    let n = 0;
    for (const doc of docs) {
      const queue = doc.trainingQueue ?? [];
      const done = queue.filter((e) => e.completeAt <= t);
      if (done.length === 0) continue;
      const troopsReady = done.reduce((s, e) => s + e.qty, 0);
      const newTroops = Math.min(doc.troopCap, doc.troops + troopsReady);
      // Atomic: $inc troops + remove completed batches (matched precisely by completeAt)
      for (const e of done) {
        await cols.playerWorld.updateOne(
          { _id: doc._id },
          { $pull: { trainingQueue: { completeAt: e.completeAt } } as never },
        );
      }
      await cols.playerWorld.updateOne(
        { _id: doc._id },
        { $set: { troops: newTroops }, $inc: { rev: 1 } },
      );
      n += done.length;
    }
    return n;
  }

  // ── SLG home-city buildings (SLG_CITY_DESIGN P1) ─────────────────────────────────

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
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, lastTickAt: t }, $push: { buildQueue: entry } as never, $inc: { rev: 1 } },
    );
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Spend coins to speed up the build queue (mirrors speedupTraining): coins → reduced duration (BUILD_SPEEDUP_SECS_PER_COIN s/coin,
   * hasBattlePass discount), time subtracted from the front with overflow cascading. Builds whose completeAt reaches now are applied immediately.
   */
  async speedupBuild(worldId: string, accountId: string, coins: number): Promise<PlayerWorldView> {
    const { cols, now } = this.core.deps;
    coins = Math.max(1, Math.floor(coins));
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    if (!pw.buildQueue || pw.buildQueue.length === 0) throw new SlgError('BAD_REQUEST', 'No build queue in progress');

    const speedupDiscountMult = pw.hasBattlePass ? 1 / 0.85 : 1;
    const speedSec = coins * BUILD_SPEEDUP_SECS_PER_COIN * speedupDiscountMult;
    const orderId = `slg_build_speedup:${worldId}:${accountId}:${now()}`;
    await this.core.commercial.spend(accountId, coins, orderId);

    const fresh = await cols.playerWorld.findOne({ _id: pw._id });
    if (!fresh) return this.core.getMe(worldId, accountId);

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
    await cols.playerWorld.updateOne(
      { _id: fresh._id },
      { $set: { resources, buildQueue: newQueue, lastTickAt: t }, $inc: { rev: 1 } },
    );
    await this.applyDueBuilds(fresh._id, worldId, accountId);
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Process completed builds (scheduler, every tick). Mirrors processCompletedTraining: finds players whose first queued build is due,
   * applies the new levels + refreshes derived state (yield / troopCap). Returns the number of builds applied.
   */
  async processCompletedBuilds(nowMs?: number): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();
    const docs = await cols.playerWorld
      .find({ 'buildQueue.0.completeAt': { $lte: t } })
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
    await cols.playerWorld.updateOne(
      { _id: docId },
      {
        $set: { buildings: next, buildQueue: newQueue, resources, yieldRate, troopCap: troopCapFor(next), lastTickAt: t },
        $inc: { rev: 1 },
      },
    );
    return done.length;
  }

  // ── G3-2c: attack formation templates (teams) ─────────────────────────────

  /** Read the player's list of attack formation templates in a given world (editor / pre-fill on departure). Throws TILE_NOT_OWNED if the player has not joined the world. */
  async getTeams(worldId: string, accountId: string): Promise<TeamTemplate[]> {
    const pw = await this.core.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    return pw.teams ?? [];
  }

  /**
   * Overwrite the player's attack formation templates (editor save, §16.2).
   * CC-3: validates cardInstanceId uniqueness across all teams, max CARD_TEAM_MAX_SIZE slots per team, and injured card check.
   * Card removal: when a card's teamId disappears from the new teams, clear its currentTroops and refund 80% training resources.
   * Full-set overwrite (frontend sends the complete list).
   */
  async setTeams(worldId: string, accountId: string, teams: TeamTemplate[]): Promise<void> {
    if (!Array.isArray(teams)) throw new SlgError('BAD_REQUEST', 'teams must be an array');
    if (teams.length > SIEGE_TEAM_CAP) throw new SlgError('BAD_REQUEST', `Team count exceeds the cap of ${SIEGE_TEAM_CAP}`);
    const teamIds = new Set<string>();
    const cardIds = new Set<string>();
    for (const team of teams) {
      if (!team || typeof team.id !== 'string' || !team.id) throw new SlgError('BAD_REQUEST', 'Team id is invalid');
      if (teamIds.has(team.id)) throw new SlgError('BAD_REQUEST', `Duplicate team id: ${team.id}`);
      teamIds.add(team.id);
      if (team.army.length > CARD_TEAM_MAX_SIZE) throw new SlgError('BAD_REQUEST', `Team ${team.id} exceeds max size of ${CARD_TEAM_MAX_SIZE}`);
      for (const entry of team.army) {
        if (entry.cardInstanceId) {
          if (cardIds.has(entry.cardInstanceId)) throw new SlgError('BAD_REQUEST', `Card ${entry.cardInstanceId} assigned to multiple teams`);
          cardIds.add(entry.cardInstanceId);
        }
      }
      try {
        validateAttackerArmy(team.army);
      } catch (err) {
        throw new SlgError('BAD_REQUEST', `Team ${team.id} formation is invalid: ${(err as Error).message}`);
      }
    }
    const pwId = playerWorldId(worldId, accountId);
    const pw = await this.core.deps.cols.playerWorld.findOne({ _id: pwId });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const now = this.core.deps.now();
    const cardState = pw.cardState ?? {};
    // Injured card check: a card with injuredUntil > now cannot be assigned to a team.
    for (const id of cardIds) {
      const cs = cardState[id];
      if (cs?.injuredUntil && cs.injuredUntil > now) {
        throw new SlgError('BAD_REQUEST', `Card ${id} is injured and cannot be assigned until ${cs.injuredUntil}`);
      }
    }

    // Detect cards removed from all teams compared to current teams (their teamId no longer appears in the new list).
    const prevCardTeams: Record<string, string> = {};
    for (const cs of Object.entries(cardState)) {
      if (cs[1].teamId) prevCardTeams[cs[0]] = cs[1].teamId;
    }
    const removedCards = Object.keys(prevCardTeams).filter((id) => !cardIds.has(id));

    // Build cardState patch: update teamId for all assigned cards; clear currentTroops + teamId for removed cards.
    const cardStateSet: Record<string, unknown> = {};
    for (const team of teams) {
      for (const entry of team.army) {
        if (entry.cardInstanceId) {
          cardStateSet[`cardState.${entry.cardInstanceId}.teamId`] = team.id;
        }
      }
    }
    let paperRefund = 0;
    let graphiteRefund = 0;
    let metalRefund = 0;
    for (const id of removedCards) {
      const troops = cardState[id]?.currentTroops ?? 0;
      if (troops > 0) {
        paperRefund += Math.floor(troops * CARD_TROOP_PAPER_COST * CARD_TROOP_REFUND_RATE);
        graphiteRefund += Math.floor(troops * CARD_TROOP_GRAPHITE_COST * CARD_TROOP_REFUND_RATE);
        metalRefund += Math.floor(troops * CARD_TROOP_METAL_COST * CARD_TROOP_REFUND_RATE);
      }
      cardStateSet[`cardState.${id}.currentTroops`] = 0;
      cardStateSet[`cardState.${id}.teamId`] = null;
    }

    const update: Record<string, unknown> = { $set: { teams, ...cardStateSet }, $inc: { rev: 1 } };
    if (paperRefund > 0 || graphiteRefund > 0 || metalRefund > 0) {
      (update as Record<string, Record<string, unknown>>)['$inc']!['resources.paper'] = paperRefund;
      (update as Record<string, Record<string, unknown>>)['$inc']!['resources.graphite'] = graphiteRefund;
      (update as Record<string, Record<string, unknown>>)['$inc']!['resources.metal'] = metalRefund;
    }
    await this.core.deps.cols.playerWorld.updateOne({ _id: pwId }, update);
  }

  /**
   * Distribute troops from baseTroopStock to card slots (CC-3, CHARACTER_CARDS_DESIGN §6.3).
   * allocations: { [cardInstanceId]: troopsToAdd }. Each card must have a teamId (be in a team).
   * Deducts total from baseTroopStock; updates cardState[id].currentTroops.
   */
  async distributeTroops(worldId: string, accountId: string, allocations: Record<string, number>): Promise<void> {
    const { cols, now } = this.core.deps;
    const pwId = playerWorldId(worldId, accountId);
    const pw = await cols.playerWorld.findOne({ _id: pwId });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const cardState = pw.cardState ?? {};
    const stock = pw.baseTroopStock ?? 0;
    let totalCost = 0;
    const cardStateSet: Record<string, unknown> = {};

    for (const [id, amount] of Object.entries(allocations)) {
      if (typeof amount !== 'number' || amount < 0 || !Number.isInteger(amount)) {
        throw new SlgError('BAD_REQUEST', `Invalid troop count for card ${id}`);
      }
      if (amount === 0) continue;
      const cs = cardState[id];
      if (!cs?.teamId) throw new SlgError('BAD_REQUEST', `Card ${id} is not assigned to a team`);
      totalCost += amount;
      cardStateSet[`cardState.${id}.currentTroops`] = (cs.currentTroops ?? 0) + amount;
    }

    if (totalCost === 0) return;
    if (totalCost > stock) throw new SlgError('NO_TROOPS', `Not enough troop stock (have ${stock}, need ${totalCost})`);

    await cols.playerWorld.updateOne(
      { _id: pwId },
      { $set: cardStateSet, $inc: { baseTroopStock: -totalCost, rev: 1 } },
    );
    void now; // suppress unused warning
  }

  /**
   * Recover an injured card by spending CARD_RECOVER_COIN_COST coins (CC-3, CHARACTER_CARDS_DESIGN §7.2).
   * Clears injuredUntil. Throws CARD_NOT_INJURED if card is not currently injured.
   */
  async recoverCard(worldId: string, accountId: string, cardInstanceId: string): Promise<void> {
    const { cols, now } = this.core.deps;
    const pwId = playerWorldId(worldId, accountId);
    const pw = await cols.playerWorld.findOne({ _id: pwId });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const cs = pw.cardState?.[cardInstanceId];
    const nowMs = now();
    if (!cs?.injuredUntil || cs.injuredUntil <= nowMs) throw new SlgError('BAD_REQUEST', `Card ${cardInstanceId} is not injured`);

    // Deduct coins via commercial client (spend throws INSUFFICIENT_FUNDS if not enough).
    await this.core.commercial.spend(accountId, CARD_RECOVER_COIN_COST, `recover:${cardInstanceId}`);

    await cols.playerWorld.updateOne(
      { _id: pwId },
      { $set: { [`cardState.${cardInstanceId}.injuredUntil`]: null }, $inc: { rev: 1 } },
    );
  }
}
