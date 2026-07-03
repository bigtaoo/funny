// worldsvc core — resource settlement & yield aggregation (WorldCore split, 2026-07-03).
// Layer above the kernel: lazy settle-on-read, per-tile yield aggregation, and the
// single-exit recomputeYield (tile yields → nation bonus → building mult + BP). No behavior change.
import {
  playerWorldId,
  tileYield,
  resourceCapFor,
  buildingYieldMult,
  buildingSelfYield,
  nearestCapitalIdx,
  RESOURCE_TYPES,
  NATION_BONUS_PRODUCTION,
  BP_YIELD_MULT,
  type BuildingKey,
  type ResourceType,
  type TileType,
} from '@nw/shared';
import { WorldCoreKernel } from './coreKernel';
import { emptyResources } from './coreHelpers';
import type { PlayerWorldDoc } from './db';

export class WorldCoreYield extends WorldCoreKernel {
  /** Lazy resource settlement: resources += yieldRate × dt (hours), capped at the cabinet-adjusted storage cap (SLG_CITY_DESIGN). */
  settle(doc: PlayerWorldDoc, now: number): Record<ResourceType, number> {
    const dtHours = Math.max(0, (now - doc.lastTickAt) / 3_600_000);
    const cap = resourceCapFor(doc.buildings);
    const out = emptyResources();
    for (const rt of RESOURCE_TYPES) {
      const settled = (doc.resources[rt] ?? 0) + (doc.yieldRate[rt] ?? 0) * dtHours;
      out[rt] = Math.min(cap, Math.floor(settled));
    }
    return out;
  }

  /** Aggregate a list of {type,level,resType} tiles into an hourly yield record. */
  yieldRecord(
    tiles: { type: TileType; level: number; resType?: ResourceType }[],
  ): Record<ResourceType, number> {
    const acc = emptyResources();
    for (const tl of tiles) {
      const y = tileYield(tl.type, tl.level, tl.resType);
      for (const rt of RESOURCE_TYPES) acc[rt] += y[rt] ?? 0;
    }
    return acc;
  }

  /**
   * Recompute the aggregated yield from all currently owned tiles in the DB (called after occupy / abandon / build completion).
   * Single exit for yield (SLG_CITY_DESIGN §5): tile yields → nation production bonus → home-city building multipliers + sticker self-production.
   */
  async recomputeYield(
    worldId: string,
    accountId: string,
    buildingsOverride?: Partial<Record<BuildingKey, number>>,
    hasBattlePassOverride?: boolean,
  ): Promise<Record<ResourceType, number>> {
    const owned = await this.deps.cols.tiles.find({ worldId, ownerId: accountId }).toArray();
    // Nation production bonus (§2.4 / G1): capitals occupied by this player → own tiles within those capitals' Voronoi regions receive +NATION_BONUS_PRODUCTION.
    const ownedNations = await this.deps.cols.nations.find({ worldId, ownerId: accountId }).toArray();
    const ownedCapIdx = new Set(ownedNations.map((n) => n.capitalIdx));
    // Building levels (SLG_CITY_DESIGN): land resources get a global yield multiplier; sticker is self-produced by the stickerShop (民居模型).
    // buildingsOverride lets a build-completion path compute the post-upgrade rate before the new levels are persisted (avoids a write-then-read ordering hazard).
    let buildings: Partial<Record<BuildingKey, number>> | undefined = buildingsOverride;
    let hasBattlePass = hasBattlePassOverride ?? false;
    if (!buildingsOverride) {
      const doc = await this.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
      buildings = doc?.buildings;
      hasBattlePass = doc?.hasBattlePass ?? false;
    }

    const acc = emptyResources();
    for (const tl of owned) {
      // ADR-025: only the base anchor contributes yield; the 8 ring cells are type:'base' too and would
      // otherwise each add the base ink trickle (9× inflation), so skip them.
      if (tl.baseRing) continue;
      const nationMult = ownedCapIdx.size > 0 && ownedCapIdx.has(nearestCapitalIdx(tl.x, tl.y, this.capitals))
        ? 1 + NATION_BONUS_PRODUCTION : 1;
      const y = tileYield(tl.type, tl.level, tl.resType);
      for (const rt of RESOURCE_TYPES) acc[rt] += (y[rt] ?? 0) * nationMult;
    }
    for (const rt of RESOURCE_TYPES) {
      acc[rt] = Math.floor(acc[rt] * buildingYieldMult(buildings, rt) + buildingSelfYield(buildings, rt));
    }
    // Battle pass production bonus (S8-8 产率加成档): +10% resource yield for holders.
    if (hasBattlePass) {
      for (const rt of RESOURCE_TYPES) acc[rt] = Math.floor(acc[rt] * BP_YIELD_MULT);
    }
    return acc;
  }
}
