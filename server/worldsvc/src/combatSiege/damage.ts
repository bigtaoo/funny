// ADR-026 delayed building-HP settlement: the scheduler tick (processDueSiegeDamage) claims due
// SiegeDamageDocs and applies each hit (settleSiegeDamage). Bodies moved verbatim out of combatSiege.ts
// (2026-07-07 split). Depends on the helpers mixin (transferLoot / applySectLeaderPenalty / passiveRelocate).
// No behavior change.
import { playerWorldId, buildingMaxHp, baseDurabilityMax, regenDurability, buildingLevel } from '@nw/shared';
import type { SiegeDamageDoc } from '../db';
import { refundTroops } from '../combatShared';
import type { SiegeServiceBaseCtor, Constructor } from './base';

export interface SiegeDamageHandlers {
  processDueSiegeDamage(nowMs?: number): Promise<number>;
}

export function SiegeDamageMixin<TBase extends SiegeServiceBaseCtor>(Base: TBase): TBase & Constructor<SiegeDamageHandlers> {
  return class extends Base {
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
        await this.core.unscheduleSiegeDamage(claimed.worldId, claimed._id);
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
      const defenderId = d.defenderId;
      const tile = await cols.tiles.findOne({ _id: d.tile });
      const attacker = await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, d.attackerId) });

      // Target must still be the same owner and unprotected; otherwise the siege is stale → void damage, return besiegers.
      const stale = !tile || !defenderId || tile.ownerId !== defenderId || (tile.protectedUntil != null && tile.protectedUntil > t);
      if (stale) {
        if (attacker && d.attackerSurvivors > 0) await refundTroops(this.core, attacker, d.attackerSurvivors, t);
        return;
      }

      const defenderForMaxHp = d.isBase ? await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, defenderId) }) : null;
      const maxHp = d.isBase ? baseDurabilityMax(buildingLevel(defenderForMaxHp?.buildings, 'wall')) : buildingMaxHp(tile.level ?? 1);
      const curHpRaw = d.isBase ? (tile.durability ?? maxHp) : (tile.hp ?? maxHp);
      const curHp = d.isBase ? regenDurability(curHpRaw, maxHp, tile.durabilityRegenAt ?? t, t) : curHpRaw;
      const newHp = curHp - Math.max(0, Math.floor(d.damage));

      if (newHp > 0) {
        // Building survives: reduce HP (durability for a base, plain hp otherwise); besiegers return to the pool.
        const survivorSet = d.isBase
          ? { durability: newHp, durabilityMax: maxHp, durabilityRegenAt: t }
          : { hp: newHp };
        await cols.tiles.updateOne({ _id: d.tile }, { $set: survivorSet, $inc: { rev: 1 } });
        if (attacker && d.attackerSurvivors > 0) await refundTroops(this.core, attacker, d.attackerSurvivors, t);
        const after = await cols.tiles.findOne({ _id: d.tile });
        if (after) { void this.core.pushTile(d.attackerId, after); void this.core.pushTile(defenderId, after); }
        return;
      }

      // HP depleted → capture. Loot first (settles both sides' resources).
      const defender = defenderForMaxHp ?? (await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, defenderId) }));
      if (attacker && defender) await this.transferLoot(defender, attacker, t);

      if (d.isBase) {
        // Main base captured: it cannot be permanently held → besiegers return; sect-leader penalty; passive relocation
        // (all territory lost + shield + a fresh full-durability base at a random tile) + system mail (D-CITY-8).
        if (attacker && d.attackerSurvivors > 0) await refundTroops(this.core, attacker, d.attackerSurvivors, t);
        await this.applySectLeaderPenalty(d.worldId, defenderId, t);
        await this.passiveRelocate(d.worldId, defenderId, t);
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
              hp: maxHp,
              ...(isCrossing && attacker?.familyId ? { familyId: attacker.familyId } : {}),
            },
            $unset: { protectedUntil: '', ...(isCrossing && !attacker?.familyId ? { familyId: '' } : {}) },
            $inc: { rev: 1 },
          },
        );
        const atkYield = await this.core.recomputeYield(d.worldId, d.attackerId);
        if (attacker) await cols.playerWorld.updateOne({ _id: attacker._id }, { $set: { yieldRate: atkYield, lastTickAt: t }, $inc: { rev: 1 } });
        const defYield = await this.core.recomputeYield(d.worldId, defenderId);
        await cols.playerWorld.updateOne({ _id: playerWorldId(d.worldId, defenderId) }, { $set: { yieldRate: defYield }, $inc: { rev: 1 } });
        void this.core.applyNationChange(d.worldId, tile.x, tile.y, d.attackerId, attacker?.familyId);
      }

      const after = await cols.tiles.findOne({ _id: d.tile });
      if (after) { void this.core.pushTile(d.attackerId, after); void this.core.pushTile(defenderId, after); }
    }
  };
}
