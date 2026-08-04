// worldsvc SLG shop domain (S8-8). Peeled out of the WorldService god-class (2026-07-03).
// Depends only on WorldCore (shared state + settle + getMe). No behavior change.
import { SLG_SHOP_ITEMS, isSlgShopItemId, SlgError, playerWorldId, RESOURCE_TYPES, RESOURCE_CAP } from '@nw/shared';
import { trainingQueueOps } from './db';
import type { WorldCore } from './core';
import type { PlayerWorldView } from './worldTypes';

export class ShopService {
  constructor(private readonly core: WorldCore) {}

  /**
   * SLG shop purchase (item definitions in SLG_SHOP_ITEMS, DB-overridable via the admin shop price panel — §8/G7).
   * Deducts coins → takes effect immediately (speedup/resource pack/protection shield/battle pass written to playerWorld).
   */
  async buySlgShopItem(worldId: string, accountId: string, itemId: string, clientPlatform?: string): Promise<PlayerWorldView> {
    if (!isSlgShopItemId(itemId)) throw new SlgError('NOT_FOUND', 'Item not found');
    const item = this.core.shopPrices?.resolveItem(itemId) ?? SLG_SHOP_ITEMS.find((i) => i.id === itemId)!;

    const { cols, now } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    // Daily purchase cap (SLG_DESIGN §7.2, 2026-07-15 fix): undefined dailyLimit = unlimited (protection/battle_pass).
    // day = UTC calendar day number; a stale counter (previous day) is treated as 0 and overwritten below.
    // This is only a pre-check (cheap early rejection for the common case) — the authoritative check
    // that actually prevents bypass happens after commercial.spend, against a freshly-read doc guarded
    // by rev (see below); concurrent requests all passing this early check is expected and handled there.
    const today = Math.floor(now() / 86400000);
    const counter = pw.shopPurchaseCounts?.[itemId];
    const countSoFar = counter && counter.day === today ? counter.count : 0;
    if (item.dailyLimit != null && countSoFar >= item.dailyLimit) {
      throw new SlgError('SHOP_LIMIT_REACHED', `Daily purchase limit reached for ${itemId} (${item.dailyLimit}/day)`);
    }
    // battle_pass single-slot gate (2026-08-01 fix): the flag it sets is a no-op boolean re-set on a
    // repeat buy — with no dailyLimit and no idempotency check, a player could burn coins on it
    // indefinitely for zero extra effect. Mirrors the commercial monthly/year card ALREADY_ACTIVE gate.
    if (item.kind === 'battle_pass' && pw.hasBattlePass) {
      throw new SlgError('ALREADY_ACTIVE', 'Battle pass already active this season');
    }

    const orderId = `slg_shop:${worldId}:${accountId}:${itemId}:${now()}`;
    await this.core.commercial.spend(accountId, item.cost, orderId, clientPlatform);

    // Coins are already spent, so from here on we must either land the purchase or refund it — a
    // stale-read finalize write (the pre-fix behavior) let N concurrent requests all pass the check
    // above and all commit their own $set, defeating the daily cap while each still paid real coins.
    // Re-check the cap against a fresh read on every attempt and rev-guard the write; if a concurrent
    // purchase wins the race and fills the last slot, refund this one instead of silently overselling.
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const fresh = await cols.playerWorld.findOne({ _id: pw._id });
      if (!fresh) {
        await this.core.commercial.grant(accountId, item.cost, `${orderId}:refund`);
        return this.core.getMe(worldId, accountId);
      }

      const t = now();
      const freshCounter = fresh.shopPurchaseCounts?.[itemId];
      const freshCountSoFar = freshCounter && freshCounter.day === today ? freshCounter.count : 0;
      if (item.dailyLimit != null && freshCountSoFar >= item.dailyLimit) {
        await this.core.commercial.grant(accountId, item.cost, `${orderId}:refund`);
        throw new SlgError('SHOP_LIMIT_REACHED', `Daily purchase limit reached for ${itemId} (${item.dailyLimit}/day)`);
      }
      if (item.kind === 'battle_pass' && fresh.hasBattlePass) {
        await this.core.commercial.grant(accountId, item.cost, `${orderId}:refund`);
        throw new SlgError('ALREADY_ACTIVE', 'Battle pass already active this season');
      }

      const resources = this.core.settle(fresh, t);
      const shopCountSet = { [`shopPurchaseCounts.${itemId}`]: { day: today, count: freshCountSoFar + 1 } };
      const filter = { _id: fresh._id, rev: fresh.rev };
      let result: { matchedCount: number };

      if (item.kind === 'troop_speedup') {
        const secToSpeed = Number(item.effect['duration_sec'] ?? 0);
        // Simplified version of speedupTraining logic (coins already deducted; operate on queue directly)
        const queue = (fresh.trainingQueue ?? []).slice();
        let remaining = secToSpeed * 1000;
        let troopsReady = 0;
        for (let i = 0; i < queue.length && remaining > 0; ) {
          const e = queue[i]!;
          const left = e.completeAt - t;
          if (remaining >= left) {
            remaining -= left;
            troopsReady += e.qty;
            queue.splice(i, 1);
          } else {
            queue[i] = { ...e, completeAt: e.completeAt - remaining };
            remaining = 0;
            i++;
          }
        }
        const newTroops = Math.min(fresh.troopCap, fresh.troops + troopsReady);
        const tq = trainingQueueOps(queue);
        result = await cols.playerWorld.updateOne(
          filter,
          {
            $set: { resources, troops: newTroops, trainingQueue: queue, lastTickAt: t, ...shopCountSet, ...tq.set },
            $inc: { rev: 1 },
            ...(Object.keys(tq.unset).length ? { $unset: tq.unset } : {}),
          },
        );
      } else if (item.kind === 'resource_pack') {
        const each = Number(item.effect['each'] ?? 0);
        for (const rt of RESOURCE_TYPES) {
          resources[rt] = Math.min(RESOURCE_CAP, (resources[rt] ?? 0) + each);
        }
        result = await cols.playerWorld.updateOne(
          filter,
          { $set: { resources, lastTickAt: t, ...shopCountSet }, $inc: { rev: 1 } },
        );
      } else if (item.kind === 'protection') {
        // The playerWorld write (the rev-guarded commit point that can retry) runs first; the tile's
        // protectedUntil extension only runs once that succeeds (see below), so a rev-conflict retry
        // never double-extends the shield.
        result = await cols.playerWorld.updateOne(
          filter,
          { $set: { resources, lastTickAt: t, ...shopCountSet }, $inc: { rev: 1 } },
        );
        if (result.matchedCount > 0) {
          const durSec = Number(item.effect['duration_sec'] ?? 0);
          const baseId = fresh.mainBaseTile;
          if (baseId) {
            const existingProtection = await cols.tiles.findOne({ _id: baseId });
            const currentProtectUntil = existingProtection?.protectedUntil ?? t;
            const newProtectUntil = Math.max(currentProtectUntil, t) + durSec * 1000;
            await cols.tiles.updateOne(
              { _id: baseId },
              { $set: { protectedUntil: newProtectUntil }, $inc: { rev: 1 } },
            );
          }
        }
      } else {
        // battle_pass
        result = await cols.playerWorld.updateOne(
          filter,
          { $set: { resources, hasBattlePass: true, lastTickAt: t, ...shopCountSet }, $inc: { rev: 1 } },
        );
      }

      if (result.matchedCount > 0) break;
      if (attempt === MAX_ATTEMPTS - 1) {
        await this.core.commercial.grant(accountId, item.cost, `${orderId}:refund`);
        throw new SlgError('REV_CONFLICT', 'Concurrent update, please retry');
      }
    }

    return this.core.getMe(worldId, accountId);
  }

  /** SLG shop item list (for client display; reflects any admin price/effect overrides). */
  getSlgShopItems(): readonly (typeof SLG_SHOP_ITEMS)[number][] {
    return this.core.shopPrices?.resolveItems() ?? SLG_SHOP_ITEMS;
  }
}
