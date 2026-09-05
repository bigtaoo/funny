// ADR-026 delayed building-HP settlement: the scheduler tick (processDueSiegeDamage) claims due
// SiegeDamageDocs and applies each hit (settleSiegeDamage). Bodies moved verbatim out of combatSiege.ts
// (2026-07-07 split). Depends on SiegeHelpersService (transferLoot / applySectLeaderPenalty / passiveRelocate).
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md's "拆分形态的优先级"
// 形态②): constructed with a reference to SiegeHelpersService (./helpers.ts, the siege domain's base
// layer) — assembled by composition in ../combatSiege.ts. No behavior change.
import { playerWorldId, buildingMaxHp, baseDurabilityMax, regenDurability, buildingLevel } from '@nw/shared';
import type { SiegeDamageDoc } from '../db';
import { WorldCore } from '../core';
import { startReturnMarch } from '../combatShared';
import type { SiegeHelpersService } from './helpers';
import { settleCityDamage } from './cityDamage';

export class SiegeDamageService {
  constructor(
    private readonly core: WorldCore,
    private readonly helpers: SiegeHelpersService,
  ) {}

  /**
   * ADR-026: settle due delayed building-HP hits (scheduler, every tick; mirrors processDueArrivals). Each SiegeDamageDoc whose
   * dueAt has passed deducts its attacking team's siege value from the target building's HP; at HP≤0 the building is captured
   * (main base → passiveRelocate; other buildings → hand over). Atomic claim-and-delete makes it single-consumer safe.
   */
  async processDueSiegeDamage(nowMs?: number): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();
    const due = await cols.siegeDamage.find({ dueAt: { $lte: t } }).limit(500).toArray();
    let n = 0;
    for (const d of due) {
      const claimed = await cols.siegeDamage.findOneAndDelete({ _id: d._id });
      if (!claimed) continue; // lost to a concurrent processor
      try {
        await this.settleSiegeDamage(claimed, t);
      } catch (e) {
        console.error('[worldsvc] settleSiegeDamage failed:', { id: claimed._id, err: (e as Error).message });
      }
      n++;
    }
    return n;
  }

  /**
   * Apply one delayed building-HP hit (ADR-026 §4/§6). Deducts damage from the target building's HP (anchor for a base);
   * HP survives → persist reduced HP + refund attacker survivors; HP≤0 → capture (loot + main-base passiveRelocate, or
   * hand over a non-base building). If the target is no longer the same owner / is protected / gone, the hit is voided and
   * attacker survivors are refunded.
   *
   * D-CITY-8: for a base hit (`d.isBase`), the HP pool is `durability`/`durabilityMax` (wall-level-derived, persistent,
   * self-regenerating) instead of `hp`/`buildingMaxHp(level)` — non-base buildings (territory/stronghold) are unchanged.
   */
  private async settleSiegeDamage(d: SiegeDamageDoc, t: number): Promise<void> {
    const { cols } = this.core.deps;
    // ADR-074 P1: a wild-city hit has an entirely different target (a CityDoc, sect-owned, with its own
    // lazy regen curve) and a different capture outcome (sect ownership + announcements, no relocation and
    // no tile hand-over), so it branches out here rather than threading a second shape through the whole
    // tile-scale body below. See combatSiege/cityDamage.ts.
    if (d.cityId) return settleCityDamage(this.core, d as SiegeDamageDoc & { cityId: string }, t);
    const defenderId = d.defenderId;
    const tile = await cols.tiles.findOne({ _id: d.tile });
    const attacker = await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, d.attackerId) });

    // Target must still be the same owner and unprotected; otherwise the siege is stale → void damage, return besiegers.
    const stale = !tile || !defenderId || tile.ownerId !== defenderId || (tile.protectedUntil != null && tile.protectedUntil > t);
    if (stale) {
      if (attacker && d.attackerSurvivors > 0) {
        await startReturnMarch(this.core, {
          worldId: d.worldId, ownerId: d.attackerId, fromTile: d.tile,
          x: this.core.coordX(d.tile), y: this.core.coordY(d.tile),
          troops: d.attackerSurvivors,
        }, t);
      }
      return;
    }

    const defenderForMaxHp = d.isBase ? await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, defenderId) }) : null;
    const maxHp = d.isBase ? baseDurabilityMax(buildingLevel(defenderForMaxHp?.buildings, 'wall')) : buildingMaxHp(tile.level ?? 1);
    const curHpRaw = d.isBase ? (tile.durability ?? maxHp) : (tile.hp ?? maxHp);
    const curHp = d.isBase ? regenDurability(curHpRaw, maxHp, tile.durabilityRegenAt ?? t, t) : curHpRaw;
    const newHp = curHp - Math.max(0, Math.floor(d.damage));

    if (newHp > 0) {
      // Building survives: reduce HP (durability for a base, plain hp otherwise); besiegers return to the pool.
      //
      // 2026-08-24 (tiles sweep): this was a blind `$set` of an absolute HP computed from the `tile` snapshot
      // read at the top of this method.
      //
      // NOT, as a first pass at this claimed, a race between besiegers of the same building: the loop above is
      // `for … await` and each `settleSiegeDamage` re-reads the tile, so hits within one tick already stack
      // correctly. The real exposure is across the FIVE tick tasks `scheduler.ts` fires concurrently under
      // `Promise.allSettled` — `processCompletedBuilds` rebases `durability`/`durabilityMax` when a wall
      // upgrade completes, and interleaved with this write one of the two was lost: either the upgrade
      // reverted damage taken (a free heal) or this hit undid the raised cap. Multi-instance deployment has
      // the same shape for the besieger case too, which the sequential argument above does not cover.
      //
      // A rev CAS with a bounded retry, not a pipeline: the value is not a pure function of the document
      // (`maxHp` comes from the defender's wall level and the base branch folds in `regenDurability`), and
      // recomputing against a fresh read is exactly the right semantics — whatever landed in between is now
      // visible and this hit applies on top of it. Scheduler path, so exhausting the attempts logs and drops
      // the hit rather than surfacing anything to a player.
      const MAX_ATTEMPTS = 5;
      let curTile = tile;
      let landed = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const attemptMaxHp = d.isBase ? maxHp : buildingMaxHp(curTile.level ?? 1);
        const rawHp = d.isBase ? (curTile.durability ?? attemptMaxHp) : (curTile.hp ?? attemptMaxHp);
        const hpNow = d.isBase ? regenDurability(rawHp, attemptMaxHp, curTile.durabilityRegenAt ?? t, t) : rawHp;
        const hpAfter = hpNow - Math.max(0, Math.floor(d.damage));
        // A concurrent hit may have already taken the building below zero; that hit owns the capture, so
        // stop here rather than writing a negative HP or racing it for the hand-over.
        if (hpAfter <= 0) return;
        const set = d.isBase
          ? { durability: hpAfter, durabilityMax: attemptMaxHp, durabilityRegenAt: t }
          : { hp: hpAfter };
        const res = await cols.tiles.updateOne({ _id: d.tile, rev: curTile.rev }, { $set: set, $inc: { rev: 1 } });
        if (res.matchedCount > 0) { landed = true; break; }
        const fresh = await cols.tiles.findOne({ _id: d.tile });
        if (!fresh) return; // tile gone (captured/abandoned under us) — nothing left to damage
        curTile = fresh;
      }
      if (!landed) {
        console.error('[worldsvc] settleSiegeDamage: HP write lost the rev race every attempt', { tile: d.tile });
        return;
      }
      if (attacker && d.attackerSurvivors > 0) {
        await startReturnMarch(this.core, {
          worldId: d.worldId, ownerId: d.attackerId, fromTile: d.tile,
          x: this.core.coordX(d.tile), y: this.core.coordY(d.tile),
          troops: d.attackerSurvivors,
        }, t);
      }
      const after = await cols.tiles.findOne({ _id: d.tile });
      if (after) { void this.core.pushTile(d.attackerId, after); void this.core.pushTile(defenderId, after); }
      return;
    }

    // HP depleted → capture. Loot first (settles both sides' resources).
    const defender = defenderForMaxHp ?? (await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, defenderId) }));
    if (attacker && defender) await this.helpers.transferLoot(defender, attacker, t);

    if (d.isBase) {
      // Main base captured: it cannot be permanently held → besiegers return; sect-leader penalty; passive relocation
      // (all territory lost + shield + a fresh full-durability base at a random tile) + system mail (D-CITY-8).
      if (attacker && d.attackerSurvivors > 0) {
        await startReturnMarch(this.core, {
          worldId: d.worldId, ownerId: d.attackerId, fromTile: d.tile,
          x: this.core.coordX(d.tile), y: this.core.coordY(d.tile),
          troops: d.attackerSurvivors,
        }, t);
      }
      await this.helpers.applySectLeaderPenalty(d.worldId, defenderId, t);
      await this.helpers.passiveRelocate(d.worldId, defenderId, t);
    } else {
      // Non-base building handed over: survivors become the new garrison; HP resets to full for the new owner.
      // A captured crossing (bridge/plankway) KEEPS its type so it stays a passage and carries the new owner's
      // familyId for `passableGateKeys` family transit (plain territory captures set no familyId).
      const isCrossing = tile.type === 'bridge' || tile.type === 'plankway';
      await cols.tiles.updateOne(
        { _id: d.tile },
        {
          $set: {
            type: isCrossing ? tile.type : 'territory',
            ownerId: d.attackerId,
            garrison: d.attackerSurvivors,
            // Baseline-heal clock starts at the hand-over (shared/src/slg/garrison.ts) — an absent
            // checkpoint reads as "already healed", which would gift the captor a full baseline on arrival.
            garrisonRegenAt: t,
            hp: maxHp,
            ...(isCrossing && attacker?.familyId ? { familyId: attacker.familyId } : {}),
          },
          $unset: { protectedUntil: '', ...(isCrossing && !attacker?.familyId ? { familyId: '' } : {}) },
          $inc: { rev: 1 },
        },
      );
      const atkYield = await this.core.recomputeYield(d.worldId, d.attackerId);
      // 2026-08-24 (yieldRate/settle invariant): a yieldRate change must bank the accrual at the OLD rate in
      // the same atomic write. Advancing lastTickAt without writing resources discarded the whole un-settled
      // window; changing yieldRate without advancing it retroactively repriced that window at the new rate.
      // settleExpr evaluates against the pre-update $resources/$yieldRate/$lastTickAt, so the old-rate accrual
      // is banked in the same document update that installs the new rate — and needs no rev guard to be safe.
      if (attacker) {
        await cols.playerWorld.updateOne({ _id: attacker._id }, [
          { $set: { resources: this.core.settleExpr(attacker.buildings, t), yieldRate: atkYield, lastTickAt: t, rev: { $add: ['$rev', 1] } } },
        ]);
      }
      const defYield = await this.core.recomputeYield(d.worldId, defenderId);
      // The defender write previously set yieldRate alone — no lastTickAt, so nothing was discarded, but the
      // whole un-settled window was then repriced at the post-loss (lower) rate: production the defender had
      // already earned at the old rate quietly shrank. Same fix, plus the read this site needs for the cap.
      const defPwId = playerWorldId(d.worldId, defenderId);
      const defPwForYield = await cols.playerWorld.findOne({ _id: defPwId });
      if (defPwForYield) {
        await cols.playerWorld.updateOne({ _id: defPwId }, [
          { $set: { resources: this.core.settleExpr(defPwForYield.buildings, t), yieldRate: defYield, lastTickAt: t, rev: { $add: ['$rev', 1] } } },
        ]);
      }
    }

    const after = await cols.tiles.findOne({ _id: d.tile });
    if (after) { void this.core.pushTile(d.attackerId, after); void this.core.pushTile(defenderId, after); }
  }
}
