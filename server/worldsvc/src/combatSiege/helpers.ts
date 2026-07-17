// SiegeService leaf helpers shared across the damage / arrival mixins: SiegeDoc recording, resource
// looting, sect-leader penalty, passive relocation, and defender-formation building. Bodies moved
// verbatim out of combatSiege.ts (2026-07-07 split). No behavior change.
import {
  tileId,
  siegeId,
  playerWorldId,
  SIEGE_LOOT_RATE,
  RESOURCE_CAP,
  RESOURCE_TYPES,
  PROTECTION_SEC,
  NATION_BONUS_DEFENSE,
  cabinetLootProtect,
  buildingLevel,
  npcBaseHp,
  SECT_LEADER_PENALTY_RATE,
  type ResourceType,
  type SiegeOutcome,
} from '@nw/shared';
import { synthesizeArmy, scaleArmyHp } from '../siegeEngine';
import type { GarrisonEntry } from '@nw/engine';
import type { TileDoc, PlayerWorldDoc, MarchDoc, SiegeDoc, DefenseConfig, ArmyEntry } from '../db';
import { emptyResources } from '../core';
import type { SiegeReplayInputs } from '../worldTypes';
import type { SiegeServiceBaseCtor, SiegeServiceBase, Constructor } from './base';

export type SiegeHelpersHandlers = Pick<
  SiegeServiceBase,
  'recordSiege' | 'transferLoot' | 'applySectLeaderPenalty' | 'passiveRelocate' | 'buildDefenderConfig'
>;

export function SiegeHelpersMixin<TBase extends SiegeServiceBaseCtor>(Base: TBase): TBase & Constructor<SiegeHelpersHandlers> {
  return class extends Base {
    /**
     * Build the defender's formation for a siege (G3-2b): a custom formation (`tile.defense` contains a garrison array, written by the G3-2c editor) takes priority;
     * otherwise, synthesize a deterministic default formation from the effective garrison size (including nation bonus). Empty garrison (no custom + 0 troops) → null;
     * buildSiegeBattle derives a token base defense.
     *
     * Nation bonus (§2.4 / G1 item②, completed in G3-2c): when the garrison tile is within the defender's own capital Voronoi region (inOwnNation):
     * **synthesis path** already benefits by having extra units from effGarrison (troop count amplified by nationDefenseStrength);
     * **custom formation path** scales each unit's initialHp by (1+NATION_BONUS_DEFENSE) (scaleArmyHp, engine caps at full HP).
     */
    override buildDefenderConfig(
      target: TileDoc,
      effGarrison: number,
      inOwnNation: boolean,
    ): { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown; defenderBaseHp?: unknown } | null {
      const custom = target.defense as DefenseConfig | undefined;
      // Territory-tile symbolic base HP scales with tile level (npcBaseHp; 2026-07-17) — same curve as the NPC
      // capture paths. A custom defense that explicitly set defenderBaseHp overrides this default.
      const baseHp = npcBaseHp(target.level ?? 1);
      const customGarrison = custom && (custom as { garrison?: unknown }).garrison;
      if (Array.isArray(customGarrison) && customGarrison.length > 0) {
        const garrison = inOwnNation
          ? scaleArmyHp(customGarrison as GarrisonEntry[], 1 + NATION_BONUS_DEFENSE)
          : (customGarrison as GarrisonEntry[]);
        return { defenderBaseHp: baseHp, ...custom, garrison };
      }
      return effGarrison > 0 ? { garrison: synthesizeArmy(effGarrison, 'defender'), defenderBaseHp: baseHp } : null;
    }

    /**
     * Record a siege battle report (transient record, §14.3 sieges). When replay is non-null (decisive siege ran through the engine), persist seed + both sides'
     * formations + tile level for client-side replay spectating (getSiegeReplay); cheap fallback / NPC sweep → replay=null (no replay available).
     */
    override async recordSiege(
      m: MarchDoc,
      defenderId: string | undefined,
      outcome: SiegeOutcome,
      t: number,
      replay: SiegeReplayInputs | null,
    ): Promise<SiegeDoc> {
      const doc: SiegeDoc = {
        _id: siegeId(m.worldId, m.ownerId, t, ++this.core.siegeSeq),
        worldId: m.worldId,
        marchId: m._id,
        attackerId: m.ownerId,
        ...(defenderId ? { defenderId } : {}),
        tile: m.toTile,
        outcome,
        recomputed: false,
        ts: t,
        ...(replay
          ? {
              seed: replay.seed,
              attackerArmy: replay.attackerArmy as ArmyEntry[],
              defenderConfig: (replay.defenderConfig as DefenseConfig | null) ?? null,
              tileLevel: replay.tileLevel,
            }
          : {}),
      };
      await this.core.deps.cols.sieges.insertOne(doc);
      return doc;
    }

    /** Transfer SIEGE_LOOT_RATE proportion of resources from the defeated player to the attacker (both sides settle + cap). Returns the actual amount looted. */
    override async transferLoot(
      defender: PlayerWorldDoc,
      attacker: PlayerWorldDoc,
      t: number,
    ): Promise<Record<ResourceType, number>> {
      const defRes = this.core.settle(defender, t);
      const loot = emptyResources();
      // P2 cabinet: protects a fraction of the defender's resources from being looted.
      const protection = cabinetLootProtect(defender.buildings);
      const effectiveLootRate = SIEGE_LOOT_RATE * (1 - protection);
      for (const rt of RESOURCE_TYPES) loot[rt] = Math.floor((defRes[rt] ?? 0) * effectiveLootRate);
      const defAfter = emptyResources();
      for (const rt of RESOURCE_TYPES) defAfter[rt] = Math.max(0, (defRes[rt] ?? 0) - loot[rt]);
      await this.core.deps.cols.playerWorld.updateOne(
        { _id: defender._id },
        { $set: { resources: defAfter, lastTickAt: t }, $inc: { rev: 1 } },
      );
      // Attacker receives the loot (merged after settling own production, capped).
      const atkRes = this.core.settle(attacker, t);
      for (const rt of RESOURCE_TYPES) atkRes[rt] = Math.min(RESOURCE_CAP, (atkRes[rt] ?? 0) + loot[rt]);
      await this.core.deps.cols.playerWorld.updateOne(
        { _id: attacker._id },
        { $set: { resources: atkRes, lastTickAt: t }, $inc: { rev: 1 } },
      );
      // Sync the in-memory attacker copy so subsequent code within the same settlement sees consistent state without re-settling (attacker is not read again after this point).
      attacker.resources = atkRes;
      attacker.lastTickAt = t;
      return loot;
    }

    /**
     * Sect leader capital-destruction penalty (§8.2): if defenderId is a sect leader, all sect members' current resources are multiplied by (1-RATE).
     * Each member is settled then reduced individually (large-scale write; U13 atomicity risk — single-process is acceptable for early stage; batch / transaction at scale).
     * Not a sect leader / no sect → no-op.
     */
    override async applySectLeaderPenalty(worldId: string, defenderId: string, t: number): Promise<void> {
      const { cols } = this.core.deps;
      const defPw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, defenderId) });
      if (!defPw?.familyId) return;
      const [fam] = await this.core.socialsvc.getFamiliesByIds([defPw.familyId]);
      if (!fam?.sectId) return;
      const sect = await cols.sects.findOne({ _id: fam.sectId });
      if (!sect || sect.leaderId !== defenderId) return; // only triggers when the sect leader's base is destroyed

      const memberFamilies = await this.core.socialsvc.getFamiliesBySect(sect._id);
      const famIds = memberFamilies.map((f) => f.familyId);
      if (famIds.length === 0) return;
      const members = await cols.playerWorld.find({ worldId, familyId: { $in: famIds } }).toArray();
      const keep = 1 - SECT_LEADER_PENALTY_RATE;
      for (const mm of members) {
        const resources = this.core.settle(mm, t);
        for (const rt of RESOURCE_TYPES) resources[rt] = Math.floor((resources[rt] ?? 0) * keep);
        await cols.playerWorld.updateOne(
          { _id: mm._id },
          { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
        );
      }
    }

    /**
     * Passive relocation (§3.4/§8.2): after the capital is destroyed, the defender's capital is randomly relocated to a new empty tile, and **all currently occupied territory is lost**.
     * Delete all of the player's own tiles (old capital + territory) → randomly pick a legal empty tile and write a new capital (with a protection shield) → update mainBaseTile +
     * recompute yield (only the new capital remains at this point). Garrison troops in lost territory are not refunded (losing territory means losing those troops — a severe penalty).
     * D-CITY-8: also sends the defender a system mail — this is the one durability-depletion outcome that previously had no player notification.
     */
    override async passiveRelocate(worldId: string, defenderId: string, t: number): Promise<void> {
      const { cols } = this.core.deps;
      const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, defenderId) });
      if (!pw) return;

      // Lose territory: delete all of the player's own tiles (old capital + all territory); revert to procedural neutral.
      await cols.tiles.deleteMany({ worldId, ownerId: defenderId });

      // Place the new capital at a random legal empty tile. In the extreme case where none is found → skip relocation (territory already lost; player can still voluntarily relocate later).
      const spot = await this.core.pickRandomEmptyTile(worldId);
      if (!spot) {
        const yieldRate = await this.core.recomputeYield(worldId, defenderId);
        await cols.playerWorld.updateOne(
          { _id: pw._id },
          { $set: { yieldRate, lastTickAt: t }, $unset: { mainBaseTile: '' }, $inc: { rev: 1 } },
        );
        void this.core.mail.sendSystemMail(defenderId, `slg-durability-relocate:${worldId}:${defenderId}:${t}`, {
          subject: 'slg.city.durabilityBreached.subject',
          body: 'slg.city.durabilityBreached.body',
          expireDays: 14,
        });
        return;
      }

      const newTid = tileId(worldId, spot.x, spot.y);
      // ADR-025: write the full 3×3 footprint (anchor garrison:0 + protection shield); ring cells carry the same shield.
      // D-CITY-8: fresh capital → full durability at the wall-level-derived cap (a clean slate, unlike voluntary relocation).
      const baseDocs = this.core.baseTileDocs(worldId, spot.x, spot.y, defenderId, {
        garrison: 0,
        level: spot.level,
        ...(spot.resType ? { resType: spot.resType } : {}),
        protectedUntil: t + PROTECTION_SEC * 1000, // relocated to safety: apply protection shield
        ...(pw.familyId ? { familyId: pw.familyId } : {}),
        wallLevel: buildingLevel(pw.buildings, 'wall'),
        now: t,
      });
      await Promise.all(
        baseDocs.map((d) => cols.tiles.updateOne({ _id: d._id }, { $set: d }, { upsert: true })),
      );

      const yieldRate = await this.core.recomputeYield(worldId, defenderId);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { yieldRate, mainBaseTile: newTid, lastTickAt: t }, $inc: { rev: 1 } },
      );
      const after = await cols.tiles.findOne({ _id: newTid });
      if (after) {
        void this.core.pushTile(defenderId, after);
        await this.core.pushTileToObservers(after, new Set([defenderId])); // G5-2: new capital after passive relocation is visible to observers
      }
      void this.core.mail.sendSystemMail(defenderId, `slg-durability-relocate:${worldId}:${defenderId}:${t}`, {
        subject: 'slg.city.durabilityBreached.subject',
        body: 'slg.city.durabilityBreached.body',
        expireDays: 14,
      });
    }
  };
}
