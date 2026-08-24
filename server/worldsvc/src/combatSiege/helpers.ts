// SiegeService leaf helpers shared across the damage / occupation / encounter / arrival domains:
// SiegeDoc recording, resource looting, sect-leader penalty, passive relocation, and
// defender-formation building. Bodies moved verbatim out of combatSiege.ts (2026-07-07 split).
//
// Independent sibling class, the base layer of the siege domain (2026-08-11 mixin-chain split,
// claudedocs/server.md's "拆分形态的优先级" 形态②): only ever calls `this.core` — every other
// siege domain class (damage/occupation/encounter/arrival) is constructed with a reference to this
// one and calls its methods directly (or via a bound ctx, see ./ctx.ts) — assembled by composition
// in ../combatSiege.ts.
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
  SIEGE_RETENTION_SEC,
  type ResourceType,
  type SiegeOutcome,
} from '@nw/shared';
import { synthesizeArmy, scaleArmyHp } from '../siegeEngine';
import type { GarrisonEntry } from '@nw/engine';
import { WorldCore, emptyResources } from '../core';
import type { TileDoc, PlayerWorldDoc, MarchDoc, SiegeDoc, DefenseConfig, ArmyEntry } from '../db';
import type { SiegeReplayInputs } from '../worldTypes';

export class SiegeHelpersService {
  constructor(private readonly core: WorldCore) {}

  /**
   * Build the defender's formation for a siege (G3-2b): a custom formation (`tile.defense` contains a garrison array, written by the G3-2c editor) takes priority;
   * otherwise, synthesize a deterministic default formation from the effective garrison size (including nation bonus). Empty garrison (no custom + 0 troops) → null;
   * buildSiegeBattle derives a token base defense.
   *
   * Nation bonus (§2.4 / G1 item②, completed in G3-2c): when the garrison tile is within the defender's own capital Voronoi region (inOwnNation):
   * **synthesis path** already benefits by having extra units from effGarrison (troop count amplified by nationDefenseStrength);
   * **custom formation path** scales each unit's initialHp by (1+NATION_BONUS_DEFENSE) (scaleArmyHp, engine caps at full HP).
   */
  buildDefenderConfig(
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
   * Record a siege battle report (transient record, §14.3 sieges). When replay is non-null, persist seed + both
   * sides' formations + tile level for client-side replay spectating (getSiegeReplay). As of 2026-08-01, every
   * call site that builds an army passes a non-null replay — including the cheap-formula and engine-crash
   * fallback paths (traceability decision, see combatSiege/arrival.ts applySiege) — and as of the sweep
   * follow-up, applySweep synthesizes a presentation-only formation purely to have something to store, so
   * replay=null now only happens for the no-combat instant occupy path (empty NPC garrison — nothing was ever
   * built to store).
   */
  async recordSiege(
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
      marchKind: m.kind,
      ...(defenderId ? { defenderId } : {}),
      tile: m.toTile,
      outcome,
      recomputed: false,
      ts: t,
      expireAt: new Date(t + SIEGE_RETENTION_SEC * 1000),
      ...(replay
        ? {
            seed: replay.seed,
            attackerArmy: replay.attackerArmy as ArmyEntry[],
            defenderConfig: (replay.defenderConfig as DefenseConfig | null) ?? null,
            tileLevel: replay.tileLevel,
            // 2026-08-12 fix: without these, getSiegeReplay's from-scratch reconstruction silently
            // drops the attacker's actual card level/equipment/academy bonuses — see SiegeDoc's field
            // doc comment (db/combatDocs.ts) for the full incident this closes.
            ...(replay.cardInstances ? { cardInstances: replay.cardInstances } : {}),
            ...(replay.equipmentInv ? { equipmentInv: replay.equipmentInv } : {}),
            ...(replay.siegeAcademy ? { siegeAcademy: replay.siegeAcademy } : {}),
          }
        : {}),
    };
    await this.core.deps.cols.sieges.insertOne(doc);
    return doc;
  }

  /**
   * Transfer SIEGE_LOOT_RATE proportion of resources from the defeated player to the attacker (both
   * sides settle + cap). Returns the actual amount looted.
   *
   * 2026-08-03 (worldsvc code review): both sides used to be a stale-read-then-blind-`$set`, so a
   * defender being looted by two sieges in the same tick (or a defender who is also the attacker of
   * an unrelated concurrent battle) could have one write's delta silently overwritten by the other's.
   * Each side is now rev-guarded with a bounded refetch+retry — the defender's loot amount is
   * recomputed from whichever doc revision actually wins the write, so a retry never grants loot that
   * wasn't actually debited.
   */
  async transferLoot(
    defender: PlayerWorldDoc,
    attacker: PlayerWorldDoc,
    t: number,
  ): Promise<Record<ResourceType, number>> {
    const MAX_ATTEMPTS = 5;
    // P2 cabinet: protects a fraction of the defender's resources from being looted.
    const protection = cabinetLootProtect(defender.buildings);
    const effectiveLootRate = SIEGE_LOOT_RATE * (1 - protection);

    let loot = emptyResources();
    let defDoc = defender;
    let defenderCommitted = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const defRes = this.core.settle(defDoc, t);
      loot = emptyResources();
      for (const rt of RESOURCE_TYPES) loot[rt] = Math.floor((defRes[rt] ?? 0) * effectiveLootRate);
      const defAfter = emptyResources();
      for (const rt of RESOURCE_TYPES) defAfter[rt] = Math.max(0, (defRes[rt] ?? 0) - loot[rt]);
      const result = await this.core.deps.cols.playerWorld.updateOne(
        { _id: defDoc._id, rev: defDoc.rev },
        { $set: { resources: defAfter, lastTickAt: t }, $inc: { rev: 1 } },
      );
      if (result.matchedCount > 0) { defenderCommitted = true; break; }
      if (attempt === MAX_ATTEMPTS - 1) break;
      const fresh = await this.core.deps.cols.playerWorld.findOne({ _id: defDoc._id });
      if (!fresh) break;
      defDoc = fresh;
    }
    if (!defenderCommitted) {
      // Never grant loot that was never actually debited from the defender.
      console.error('[worldsvc] transferLoot: giving up on defender debit after rev-conflict retries', { defenderId: defDoc._id });
      return emptyResources();
    }

    // Attacker receives the loot (merged after settling own production, capped) — guarded/retried
    // independently since the attacker doc can race a *different* concurrent settlement.
    let atkDoc = attacker;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const atkRes = this.core.settle(atkDoc, t);
      for (const rt of RESOURCE_TYPES) atkRes[rt] = Math.min(RESOURCE_CAP, (atkRes[rt] ?? 0) + loot[rt]);
      const result = await this.core.deps.cols.playerWorld.updateOne(
        { _id: atkDoc._id, rev: atkDoc.rev },
        { $set: { resources: atkRes, lastTickAt: t }, $inc: { rev: 1 } },
      );
      if (result.matchedCount > 0) {
        // Sync the in-memory attacker copy so subsequent code within the same settlement sees
        // consistent state without re-settling (attacker is not read again after this point).
        attacker.resources = atkRes;
        attacker.lastTickAt = t;
        break;
      }
      if (attempt === MAX_ATTEMPTS - 1) {
        console.error('[worldsvc] transferLoot: giving up on attacker credit after rev-conflict retries', { attackerId: atkDoc._id });
        break;
      }
      const fresh = await this.core.deps.cols.playerWorld.findOne({ _id: atkDoc._id });
      if (!fresh) break;
      atkDoc = fresh;
    }
    return loot;
  }

  /**
   * Sect leader capital-destruction penalty (§8.2): if defenderId is a sect leader, all sect members' current resources are multiplied by (1-RATE).
   * Each member is settled then reduced individually (large-scale write; U13 atomicity risk — single-process is acceptable for early stage; batch / transaction at scale).
   * Not a sect leader / no sect → no-op.
   */
  async applySectLeaderPenalty(worldId: string, defenderId: string, t: number): Promise<void> {
    const { cols } = this.core.deps;
    const defPw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, defenderId) });
    if (!defPw?.familyId) return;
    // comm-audit batch F item 8b: sectId is mirrored onto PlayerWorldDoc at joinWorld — no
    // getFamiliesByIds([defPw.familyId]) round trip needed just to read it.
    if (!defPw.sectId) return;
    const sect = await cols.sects.findOne({ _id: defPw.sectId });
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
  async passiveRelocate(worldId: string, defenderId: string, t: number): Promise<void> {
    const { cols } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, defenderId) });
    if (!pw) return;

    // ADR-051 (P5b): before wiping the territory, sweep any arrow-tower coverage it registered — the tiles are
    // deleted below (structure gone with them), so only the Redis `cover` reverse index needs the explicit
    // removeCover, exactly like abandonTile/landSiege. Blockers register no coverage, so only towers matter.
    const towerTiles = await cols.tiles
      .find({ worldId, ownerId: defenderId, 'structure.kind': 'arrowTower' })
      .toArray();
    for (const tt of towerTiles) await this.core.removeCover(worldId, tt.x, tt.y, tt._id);

    // Lose territory: delete all of the player's own tiles (old capital + all territory); revert to procedural neutral.
    await cols.tiles.deleteMany({ worldId, ownerId: defenderId });

    // Place the new capital at a random legal empty tile. In the extreme case where none is found → skip relocation (territory already lost; player can still voluntarily relocate later).
    const spot = await this.core.pickRandomEmptyTile(worldId);
    if (!spot) {
      const yieldRate = await this.core.recomputeYield(worldId, defenderId);
      // 2026-08-24 (yieldRate/settle invariant): a yieldRate change must bank the accrual at the OLD rate in
      // the same atomic write. Advancing lastTickAt without writing resources discarded the whole un-settled
      // window; changing yieldRate without advancing it retroactively repriced that window at the new rate.
      // settleExpr evaluates against the pre-update $resources/$yieldRate/$lastTickAt, so the old-rate accrual
      // is banked in the same document update that installs the new rate — and needs no rev guard to be safe.
      // Worst instance of the two: the player has just lost their capital and every tile, and the old code
      // then silently ate whatever they had produced since their last settle. `$$REMOVE` is the pipeline
      // spelling of the `$unset: { mainBaseTile: '' }` this replaces.
      await cols.playerWorld.updateOne({ _id: pw._id }, [
        {
          $set: {
            resources: this.core.settleExpr(pw.buildings, t),
            yieldRate,
            lastTickAt: t,
            mainBaseTile: '$$REMOVE',
            rev: { $add: ['$rev', 1] },
          },
        },
      ]);
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
    // 2026-08-24 (yieldRate/settle invariant): a yieldRate change must bank the accrual at the OLD rate in
    // the same atomic write. Advancing lastTickAt without writing resources discarded the whole un-settled
    // window; changing yieldRate without advancing it retroactively repriced that window at the new rate.
    // settleExpr evaluates against the pre-update $resources/$yieldRate/$lastTickAt, so the old-rate accrual
    // is banked in the same document update that installs the new rate — and needs no rev guard to be safe.
    await cols.playerWorld.updateOne({ _id: pw._id }, [
      {
        $set: {
          resources: this.core.settleExpr(pw.buildings, t),
          yieldRate,
          mainBaseTile: newTid,
          lastTickAt: t,
          rev: { $add: ['$rev', 1] },
        },
      },
    ]);
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
}
