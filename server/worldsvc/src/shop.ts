// worldsvc SLG shop domain (S8-8). Peeled out of the WorldService god-class (2026-07-03).
// Depends only on WorldCore (shared state + settle + getMe). No behavior change.
import { SLG_SHOP_ITEMS, SlgError, playerWorldId, RESOURCE_TYPES, RESOURCE_CAP } from '@nw/shared';
import type { WorldCore } from './core';
import type { PlayerWorldView } from './worldTypes';

export class ShopService {
  constructor(private readonly core: WorldCore) {}

  /**
   * SLG shop purchase (item definitions in SLG_SHOP_ITEMS).
   * Deducts coins → takes effect immediately (speedup/resource pack/protection shield/battle pass written to playerWorld).
   */
  async buySlgShopItem(worldId: string, accountId: string, itemId: string): Promise<PlayerWorldView> {
    const item = SLG_SHOP_ITEMS.find((i) => i.id === itemId);
    if (!item) throw new SlgError('NOT_FOUND', 'Item not found');

    const { cols, now } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const orderId = `slg_shop:${worldId}:${accountId}:${itemId}:${now()}`;
    await this.core.commercial.spend(accountId, item.cost, orderId);

    const t = now();
    const resources = this.core.settle(pw, t);

    if (item.kind === 'troop_speedup') {
      const secToSpeed = Number(item.effect['duration_sec'] ?? 0);
      // Simplified version of speedupTraining logic (coins already deducted; operate on queue directly)
      const queue = (pw.trainingQueue ?? []).slice();
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
      const newTroops = Math.min(pw.troopCap, pw.troops + troopsReady);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, troops: newTroops, trainingQueue: queue, lastTickAt: t }, $inc: { rev: 1 } },
      );
    } else if (item.kind === 'resource_pack') {
      const each = Number(item.effect['each'] ?? 0);
      for (const rt of RESOURCE_TYPES) {
        resources[rt] = Math.min(RESOURCE_CAP, (resources[rt] ?? 0) + each);
      }
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
      );
    } else if (item.kind === 'protection') {
      const durSec = Number(item.effect['duration_sec'] ?? 0);
      const baseId = pw.mainBaseTile;
      if (baseId) {
        const existingProtection = await cols.tiles.findOne({ _id: baseId });
        const currentProtectUntil = existingProtection?.protectedUntil ?? t;
        const newProtectUntil = Math.max(currentProtectUntil, t) + durSec * 1000;
        await cols.tiles.updateOne(
          { _id: baseId },
          { $set: { protectedUntil: newProtectUntil }, $inc: { rev: 1 } },
        );
      }
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
      );
    } else if (item.kind === 'battle_pass') {
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, hasBattlePass: true, lastTickAt: t }, $inc: { rev: 1 } },
      );
    }

    return this.core.getMe(worldId, accountId);
  }

  /** SLG shop item list (for client display). */
  getSlgShopItems(): typeof SLG_SHOP_ITEMS {
    return SLG_SHOP_ITEMS;
  }
}
