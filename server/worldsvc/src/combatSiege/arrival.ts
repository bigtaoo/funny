// S8-3 siege / sweep arrival settlement: applySiege dispatches to the ADR-026 main-base wave path
// (applyBaseSiege), the stronghold PvE path (applyStrongholdSiege), or the immediate territory landing
// (landSiege); applySweep handles neutral/resource-tile clears. Bodies moved verbatim out of
// combatSiege.ts (2026-07-07 split). Depends on the helpers mixin (buildDefenderConfig / recordSiege /
// transferLoot / applySectLeaderPenalty / passiveRelocate). No behavior change.
import {
  proceduralTile,
  siegeSeedFromId,
  playerWorldId,
  resolveSiege,
  npcGarrison,
  npcBaseHp,
  strongholdGarrison,
  passageGarrison,
  STRONGHOLD_LOOT_PER_LEVEL,
  strongholdMaterialLoot,
  provinceIdxAt,
  SWEEP_LOOT_PER_LEVEL,
  RESOURCE_CAP,
  RESOURCE_TYPES,
  NATION_BONUS_DEFENSE,
  nationDefenseStrength,
  academyBuff,
  teamSiegeValue,
  waveSeed,
  SLG_SIEGE_DAMAGE_DELAY_MS,
  SLG_TEAM_INJURY_MS,
  MARCH_MORALE_MAX,
  moraleCombatMultiplier,
  type CardInstance,
  type ResourceType,
  type SiegeOutcome,
  type SiegeResolution,
  type ProceduralTile,
} from '@nw/shared';
import { runSiegeBattle, synthesizeArmy, scaleArmyHp, scaleArmyByRatio, sumArmyHp, toDefenderFormation, resolveCardArmy, toEngineCardInstances, computeCardStateUpdates, shouldUseCheapSiege } from '../siegeEngine';
import type { GarrisonEntry, EngineEquipmentInput, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { ENGINE_VERSION } from '@nw/engine';
import type { TileDoc, PlayerWorldDoc, MarchDoc, SiegeDamageDoc } from '../db';
import { lootSummary, emptyResources } from '../core';
import type { SiegeReplayInputs } from '../worldTypes';
import { refundTroops } from '../combatShared';
import type { SiegeServiceBaseCtor, Constructor } from './base';

export interface SiegeArrivalHandlers {
  applySiege(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void>;
  applySweep(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void>;
}

export function SiegeArrivalMixin<TBase extends SiegeServiceBaseCtor>(Base: TBase): TBase & Constructor<SiegeArrivalHandlers> {
  return class extends Base {
    // ── S8-3: siege / sweep arrival settlement (cheap formula, §5.3; decisive battles use engine re-computation in S8-3b via judge) ──

    /**
     * Siege another player's territory/capital (attack arrival). On arrival, re-validate that the target is still enemy-owned and unprotected; otherwise refund troops.
     * Cheap linear settlement resolveSiege(attacker troops, garrison):
     *   - attacker_win + territory → tile changes hands (survivors become the new garrison) + loot defeated player's resources + both sides recompute yield;
     *   - attacker_win + base      → capital cannot be permanently taken: garrison wiped + defeated player gets a protection shield + loot taken + attacker survivors return to troop pool;
     *   - defender_win             → all attacker committed troops destroyed (already deducted on departure, not refunded) + defender garrison takes casualties.
     */
    async applySiege(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
      const { cols } = this.core.deps;
      // CC-3: a card-army march's committed strength lives entirely in cardState.currentTroops, never in
      // playerWorld.troops (CHARACTER_CARDS_DESIGN §6.1/§9) — every refund path below must skip the pool credit
      // for such a march (nothing was ever deducted from the pool for it; see combatMarch.ts's matching guard).
      const hasCardArmy = !!m.army?.some((e) => !!e.cardInstanceId);
      const target = await cols.tiles.findOne({ _id: m.toTile });
      // ADR-039 territory connectivity: the attacker's sect territory can shift during transit (an intervening
      // loss can strand the attacker), so re-validate here before any capture branch — treat like a miss (refund).
      // Capitals check against their whole 3×3 footprint (targetFootprintCells), not just the landed cell.
      const footprint = this.core.targetFootprintCells(target, this.core.coordX(m.toTile), this.core.coordY(m.toTile));
      if (!(await this.core.isConnectedToSectTerritory(m.worldId, m.ownerId, footprint))) {
        if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
        return;
      }
      // Stronghold PvE capture (G8 §3.1): target has no owner and procedural type is stronghold → fight the ultra-strong system NPC garrison;
      // victory captures it as territory + grants a one-time rich reward; defeat causes surviving attackers to retreat and return. Intercept before the "miss and refund" branch.
      if (!target?.ownerId) {
        const proc = proceduralTile(m.worldId, this.core.coordX(m.toTile), this.core.coordY(m.toTile));
        if (proc.type === 'stronghold') {
          await this.applyStrongholdSiege(m, pw, t, proc);
          return;
        }
        // Crossing PvE capture (bridge/plankway): fight the NPC garrison; victory captures it as an owned crossing
        // (KEEPS its bridge/plankway type so it stays a passage), defeat retreats. Intercept before the miss/refund branch.
        if (proc.type === 'bridge' || proc.type === 'plankway') {
          await this.applyCrossingSiege(m, pw, t, proc);
          return;
        }
        // ADR-037 (§5.4): target has no owner but is mid occupation-hold (an occupy march already won its PvE
        // battle and is waiting out the hold countdown) — this attack expels the pending occupier, fighting their
        // held garrison (not a re-fetched NPC garrison). Intercept before the miss/refund branch below.
        if (target?.contestedBy && (target.contestedUntil ?? 0) > t) {
          await this.applyOccupationExpulsion(m, pw, target, t);
          return;
        }
      }
      // On arrival, target is no longer enemy-owned (abandoned / transferred to own / ownerless) or is now protected → treat as a miss; refund and return troops.
      if (
        !target?.ownerId ||
        target.ownerId === m.ownerId ||
        (target.protectedUntil && target.protectedUntil > t)
      ) {
        if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
        return;
      }

      const defenderId = target.ownerId;
      // ADR-025 unified defense: attacking ANY of the 9 base cells besieges the whole base. If the attacker
      // landed on a ring cell, resolve garrison + defense config against the ANCHOR (which holds them); the
      // attacker still marched to m.toTile. Falls back to target if the anchor is somehow missing.
      const baseTile = target.baseRing
        ? ((await cols.tiles.findOne({ _id: target.baseAnchor })) ?? target)
        : target;
      // Nation defense bonus (§2.4 / G1, ADR-034): if the garrison tile is within the province of a capital the defender occupies → effective garrison strength is increased.
      const capIdx = provinceIdxAt(baseTile.x, baseTile.y);
      const nation = await cols.nations.findOne({ _id: `nation:${m.worldId}:${capIdx}` });
      const inOwnNation = !!nation?.ownerId && nation.ownerId === defenderId;
      const effGarrison = nationDefenseStrength(baseTile.garrison ?? 0, inOwnNation);

      // E8/CC-3: fetch attacker's progression snapshot early (needed for card army resolution + blueprint injection).
      const attackerSave = await this.core.meta.getSaveFields(m.ownerId).catch(() => null);

      // Attacker formation (G3-2c): marched with a team → use the real formation snapshot (m.army); otherwise synthesize from flat troop count as fallback (v1 bridge).
      // CC-3: when army entries carry cardInstanceId, resolve to engine GarrisonEntry[] via cardState.currentTroops + CARD_DEFS.unitType.
      const rawArmy = m.army ?? [];
      // Morale (行军疲劳 — see SLG_DESIGN.md §4.4; distinct from the card "士气加成" bonus): long-distance marches arrive fatigued — scale the whole attacker formation's effective HP
      // down by the march's remaining morale (captured once at departure, combatMarch.ts). Also used below to
      // scale the cheap-formula troop count so both settlement paths stay consistent.
      const moraleMult = moraleCombatMultiplier(m.morale ?? MARCH_MORALE_MAX);
      const effTroops = Math.round(m.troops * moraleMult);
      // hasCardArmy already computed at the top of applySiege (miss/recall branches need it before we get here).
      const attackerArmy: GarrisonEntry[] = scaleArmyByRatio(
        hasCardArmy
          ? resolveCardArmy(rawArmy, pw.cardState ?? {}, attackerSave?.cardInv ?? {})
          : (rawArmy.length > 0 ? (rawArmy as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker')),
        moraleMult,
      );
      // CC-3: extract EngineCardInstance[] from the attacker's card army for blueprint injection (level + gear); shared by both paths.
      let cardInstances: EngineCardInstance[] | undefined;
      let cardEquipInv: EngineEquipInv | undefined;
      if (hasCardArmy && attackerSave) {
        const { cardInstances: ci, engEquipInv } = toEngineCardInstances(rawArmy, attackerSave.cardInv, attackerSave.equipmentInv);
        cardInstances = ci;
        cardEquipInv = engEquipInv;
      }
      // P2 academy: attacker's academy building gives a seasonal blueprint HP/damage/siege buff (both paths).
      const atkAcademy = academyBuff(pw.buildings);
      const siegeAcademy = (atkAcademy.hp > 0 || atkAcademy.damage > 0 || atkAcademy.siege > 0) ? atkAcademy : undefined;

      // Fetch defender world state before the battle (wave teams, wall/academy buffs, cabinet loot protection).
      const defender = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, defenderId) });

      // C7/§17.9: mid-season engine drift detection (non-blocking; warning only — replays may drift frame by frame; ops treatment in §17.9).
      const wv = await cols.worlds.findOne({ _id: m.worldId }, { projection: { engineVersion: 1 } });
      if (wv?.engineVersion != null && wv.engineVersion !== ENGINE_VERSION) {
        console.warn('[worldsvc] siege engineVersion drift (engine upgraded mid-season without reopening the shard)', {
          worldId: m.worldId, pinned: wv.engineVersion, runtime: ENGINE_VERSION,
        });
      }

      // ADR-026: a main base uses the wave-defender + building-HP + delayed-siege-value model. Attacking any of the 9
      // footprint cells lands here with target.type==='base' (anchor resolution already done above); territory tiles keep
      // the pre-ADR-026 single-battle instant path below.
      if (target.type === 'base') {
        // Attacker synthesized iff neither a card army nor a real (team-authored) rawArmy was marched with — a
        // synthesized army beyond board capacity clogs lanes (see SIEGE_SYNTH_ARMY_MAX_TROOPS) and must never
        // reach the per-wave engine below.
        const attackerSynthesized = !hasCardArmy && rawArmy.length === 0;
        await this.applyBaseSiege(
          m, pw, baseTile, defenderId, defender, inOwnNation,
          attackerArmy, cardInstances, cardEquipInv, siegeAcademy, attackerSave?.cardInv ?? {}, attackerSynthesized, t,
        );
        return;
      }

      // ── Territory tile (non-base): single deterministic battle + immediate settlement (unchanged, §16) ──
      const defenderConfig = this.buildDefenderConfig(baseTile, effGarrison, inOwnNation);
      const tileLevel = baseTile.level ?? 1;
      const seed = siegeSeedFromId(m._id);

      // Attacker synthesized iff neither a card army nor a real (team-authored) rawArmy was marched with.
      const attackerSynthesized = !hasCardArmy && rawArmy.length === 0;
      // Defender synthesized iff the tile has no custom formation (buildDefenderConfig fell back to synthesizeArmy).
      const defenderCustomGarrison = (baseTile.defense as { garrison?: unknown } | undefined)?.garrison;
      const defenderSynthesized = !(Array.isArray(defenderCustomGarrison) && defenderCustomGarrison.length > 0);

      // Overwhelming ratio (SIEGE_CHEAP_RATIO) or synthesized-army board overflow → skip the engine outright
      // (a synthesized army beyond board capacity clogs lanes and can spuriously time out to a defender win
      // regardless of true strength); bad formation / engine error also falls back — a siege must never stall a march.
      let res: SiegeResolution;
      let replay: SiegeReplayInputs | null = { seed, attackerArmy, defenderConfig, tileLevel };
      if (shouldUseCheapSiege({ attackerTroops: effTroops, defenderTroops: effGarrison, attackerSynthesized, defenderSynthesized })) {
        res = resolveSiege(effTroops, effGarrison);
        replay = null;
      } else {
        try {
          res = runSiegeBattle({ attackerArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv, siegeAcademy });
        } catch (err) {
          console.error('[worldsvc] siege engine failed — fallback to cheap resolve', { tile: m.toTile, err: (err as Error).message });
          res = resolveSiege(effTroops, effGarrison);
          replay = null; // cheap fallback result is inconsistent with engine replay → do not store replay inputs (replay button degrades to hidden).
        }
      }
      // Replay inputs: persisted to SiegeDoc; the client uses seed + both sides' formations to replay the battle locally for spectating (§16.3).
      await this.landSiege(m, pw, target, defenderId, defender, res, t, replay);
    }

    /**
     * ADR-026 main-base siege: in-base, non-injured defender teams (t1..t5) fight the attacker in waves; the attacker's
     * surviving troops carry over between waves. Clearing all defenders (or none present) is a garrison win → schedule a
     * delayed building-HP hit (SiegeDamageDoc, +SLG_SIEGE_DAMAGE_DELAY_MS) equal to the attacking team's siege value.
     * Each defeated defender team is injured for SLG_TEAM_INJURY_MS (never defends until healed). An attacker wiped
     * mid-waves fails the siege (no HP damage) and retreats immediately. The real building HP (TileDoc.hp on the anchor)
     * is only reduced later by processDueSiegeDamage → capture (passiveRelocate) at HP≤0.
     */
    private async applyBaseSiege(
      m: MarchDoc,
      pw: PlayerWorldDoc,
      baseTile: TileDoc,
      defenderId: string,
      defender: PlayerWorldDoc | null,
      inOwnNation: boolean,
      attackerArmy: GarrisonEntry[],
      cardInstances: EngineCardInstance[] | undefined,
      cardEquipInv: EngineEquipInv | undefined,
      siegeAcademy: { hp: number; damage: number; siege: number } | undefined,
      attackerCardInv: Record<string, CardInstance>,
      attackerSynthesized: boolean,
      t: number,
    ): Promise<void> {
      const { cols } = this.core.deps;
      const tileLevel = baseTile.level ?? 1;
      // wall no longer buffs garrison HP during battle — its effect moved to persistent durability
      // (D-CITY-8; see settleSiegeDamage's use of baseDurabilityMax for the delayed HP hit below).

      // Teams currently out on active (non-recalled) marches are skipped as defenders (ADR-026 §2).
      const activeMarches = await cols.marches
        .find({ worldId: m.worldId, ownerId: defenderId, status: { $ne: 'recalled' }, teamId: { $exists: true } })
        .toArray();
      const outTeams = new Set(activeMarches.map((x) => x.teamId).filter((id): id is string => !!id));

      // Defender card inventory (resolve team card armies → unit type + troop count). v1: defender cards use base blueprints on defence (no per-card level/gear buff; follow-up).
      const defenderSave = await this.core.meta.getSaveFields(defenderId).catch(() => null);
      const defCardInv = defenderSave?.cardInv ?? {};
      const defCardState = defender?.cardState ?? {};
      const teamState = defender?.teamState ?? {};

      // In-base, non-injured teams in t1..t5 order.
      const defenders = (defender?.teams ?? [])
        .filter((tm) => tm.army.length > 0 && !outTeams.has(tm.id))
        .filter((tm) => !((teamState[tm.id]?.injuredUntil ?? 0) > t))
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));

      // Wave battle: attacker survivors carry over between waves (scaled by survival ratio).
      let survivorArmy: GarrisonEntry[] = attackerArmy.map((e) => ({ ...e }));
      let attackerSurvivors = sumArmyHp(survivorArmy);
      const defeatedTeamIds: string[] = [];
      const replays: SiegeReplayInputs[] = [];
      let cleared = true;

      for (let i = 0; i < defenders.length; i++) {
        const tm = defenders[i]!;
        if (survivorArmy.length === 0 || attackerSurvivors <= 0) { cleared = false; break; }
        // Re-place the attack-authored team onto defender spawn positions (top half) so the auto-battle isn't degenerate.
        let defArmy = toDefenderFormation(resolveCardArmy(tm.army, defCardState, defCardInv));
        if (inOwnNation) defArmy = scaleArmyHp(defArmy, 1 + NATION_BONUS_DEFENSE); // §2.4 nation defence bonus
        if (defArmy.length === 0) { defeatedTeamIds.push(tm.id); continue; }      // empty/stale team → already cleared (still injured)
        // ADR-026: the per-wave engine "base" is only a battle terminator (the real building durability is TileDoc.hp,
        // reduced separately by the delayed siege-value hit). Pin it to the weakest level so each wave is decided by
        // team-vs-attacker, not by a symbolic base tanking the assault.
        const defenderConfig = { garrison: defArmy, defenderBaseLevel: 0 };
        const seed = waveSeed(m._id, i);
        const deployedHp = sumArmyHp(survivorArmy);
        let res: SiegeResolution;
        // A synthesized attacker army beyond board capacity clogs lanes and must never reach the engine (defender
        // teams are always real, level-schema-validated formations — never synthesized, so no symmetric check needed).
        if (shouldUseCheapSiege({ attackerTroops: deployedHp, defenderTroops: sumArmyHp(defArmy), attackerSynthesized, defenderSynthesized: false })) {
          res = resolveSiege(deployedHp, sumArmyHp(defArmy));
        } else {
          try {
            res = runSiegeBattle({ attackerArmy: survivorArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv, siegeAcademy });
          } catch (err) {
            console.error('[worldsvc] base wave siege engine failed — cheap fallback', { tile: baseTile._id, wave: i, err: (err as Error).message });
            res = resolveSiege(deployedHp, sumArmyHp(defArmy));
          }
        }
        replays.push({ seed, attackerArmy: survivorArmy, defenderConfig, tileLevel });
        attackerSurvivors = res.attackerSurvivors;
        if (res.outcome === 'attacker_win') {
          defeatedTeamIds.push(tm.id);
          const ratio = deployedHp > 0 ? res.attackerSurvivors / deployedHp : 0;
          survivorArmy = scaleArmyByRatio(survivorArmy, ratio);
          if (survivorArmy.length === 0) { cleared = false; break; } // attacker spent — cleared some waves but cannot continue
        } else {
          cleared = false; // repelled by this wave
          break;
        }
      }

      // Persist defender team injuries (each defeated team locked for SLG_TEAM_INJURY_MS).
      if (defeatedTeamIds.length > 0 && defender) {
        const injSet: Record<string, unknown> = {};
        for (const id of defeatedTeamIds) injSet[`teamState.${id}.injuredUntil`] = t + SLG_TEAM_INJURY_MS;
        await cols.playerWorld.updateOne({ _id: playerWorldId(m.worldId, defenderId) }, { $set: injSet, $inc: { rev: 1 } });
      }

      const outcome: SiegeOutcome = cleared ? 'attacker_win' : 'defender_win';
      const replay = replays.length > 0 ? (replays[replays.length - 1] ?? null) : null;
      const siege = await this.recordSiege(m, defenderId, outcome, t, replay);

      // CC-3: attacker card post-battle state (uniform survival over the whole siege). Card-army survivors are
      // written ONLY to cardState.currentTroops here — never to playerWorld.troops (see the `else` branch below).
      const attackArmy = m.army ?? [];
      const hasCardArmy = attackArmy.some((e) => !!e.cardInstanceId);
      if (hasCardArmy) {
        const cardUpdates = computeCardStateUpdates(attackArmy, pw.cardState ?? {}, attackerSurvivors, t);
        const cardStateSet: Record<string, unknown> = {};
        for (const [id, update] of Object.entries(cardUpdates)) {
          cardStateSet[`cardState.${id}.currentTroops`] = update.currentTroops;
          cardStateSet[`cardState.${id}.injuredUntil`] = update.injuredUntil != null ? update.injuredUntil : null;
        }
        if (Object.keys(cardStateSet).length > 0) {
          await cols.playerWorld.updateOne({ _id: pw._id }, { $set: cardStateSet, $inc: { rev: 1 } });
        }
      }

      if (cleared) {
        // Garrison cleared (or no defenders present): schedule the delayed building-HP hit = attacking team's siege value
        // (sum of the team's per-card siege value; a real card team is always > 0). Attacker keeps besieging; survivors are refunded at settlement.
        const damage = teamSiegeValue(m.army ?? [], attackerCardInv);
        const dmg: SiegeDamageDoc = {
          _id: siege._id,
          worldId: m.worldId,
          attackerId: m.ownerId,
          defenderId,
          tile: baseTile._id,
          isBase: true,
          damage,
          attackerSurvivors,
          ...(pw.familyId ? { familyId: pw.familyId } : {}),
          dueAt: t + SLG_SIEGE_DAMAGE_DELAY_MS,
        };
        await cols.siegeDamage.updateOne({ _id: dmg._id }, { $setOnInsert: dmg }, { upsert: true });
        await this.core.scheduleSiegeDamage(m.worldId, dmg._id, dmg.dueAt);
      } else if (attackerSurvivors > 0) {
        // Attacker repelled: survivors retreat and return to the troop pool immediately (flat/legacy armies
        // only — a card army's survivors were already written to cardState above, not the pool).
        if (!hasCardArmy) await refundTroops(this.core, pw, attackerSurvivors, t);
      }

      // Activity + battle-report push (loot only happens at capture, in settleSiegeDamage → empty here).
      void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      void this.core.bumpFamilyActivity(m.worldId, defender?.familyId, 1);
      const lootStr = lootSummary(emptyResources());
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
      void this.core.pushSiege(m.ownerId, siege, lootStr);
      void this.core.pushSiege(defenderId, siege, lootStr);
    }

    /**
     * Stronghold PvE siege capture (G8 §3.1): an ownerless stronghold tile; the system derives an ultra-strong NPC garrison + high base from the tile level.
     * Uses the authoritative engine siege (bad formation / error → cheap fallback). Victory → write territory (survivors become garrison) + one-time rich resource reward + nation founding / activity refresh;
     * Defeat → surviving attackers retreat and return (NPC garrison is not persisted — procedural, not stored in DB; resets next time).
     * Defender is NPC throughout: no defenderId, no player loot, no protection shield.
     */
    private async applyStrongholdSiege(
      m: MarchDoc,
      pw: PlayerWorldDoc,
      t: number,
      proc: ProceduralTile,
    ): Promise<void> {
      const { cols } = this.core.deps;
      const x = this.core.coordX(m.toTile);
      const y = this.core.coordY(m.toTile);
      // CC-3: a card army's committed strength lives in cardState.currentTroops, not playerWorld.troops (see applySiege).
      const rawArmy = m.army ?? [];
      const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);
      // Re-validate on arrival: already occupied by another player or self (including simultaneous captures) → skip NPC fight; refund troops as a miss.
      const occ = await cols.tiles.findOne({ _id: m.toTile });
      if (occ?.ownerId) {
        if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
        return;
      }

      const garrison = strongholdGarrison(proc.level);
      // E8/CC-3: fetch attacker's progression snapshot (equipment for the legacy path; cardInv+equipmentInv for a real card army).
      const attackerSave = await this.core.meta.getSaveFields(m.ownerId).catch(() => null);
      // Morale (行军疲劳, not the card 士气加成): scale attacker strength by the march's remaining morale (see applySiege above for detail).
      const moraleMult = moraleCombatMultiplier(m.morale ?? MARCH_MORALE_MAX);
      const effTroops = Math.round(m.troops * moraleMult);
      const attackerArmy: GarrisonEntry[] = scaleArmyByRatio(
        hasCardArmy
          ? resolveCardArmy(rawArmy, pw.cardState ?? {}, attackerSave?.cardInv ?? {})
          : (rawArmy.length > 0 ? (rawArmy as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker')),
        moraleMult,
      );
      let cardInstances: EngineCardInstance[] | undefined;
      let cardEquipInv: EngineEquipInv | undefined;
      if (hasCardArmy && attackerSave) {
        const { cardInstances: ci, engEquipInv } = toEngineCardInstances(rawArmy, attackerSave.cardInv, attackerSave.equipmentInv);
        cardInstances = ci;
        cardEquipInv = engEquipInv;
      }
      // System ultra-strong default garrison + tile-level-scaled base HP (npcBaseHp; 2026-07-17). Stronghold
      // tiles are max level, so the base is at the top of the curve — consistent with the "extremely hard to
      // conquer" intent (§3.1); the real gate is still the huge garrison.
      const tileLevel = proc.level;
      const defenderConfig = { garrison: synthesizeArmy(garrison, 'defender'), defenderBaseHp: npcBaseHp(tileLevel) };
      const seed = siegeSeedFromId(m._id);

      // E8: stronghold is also a PvE-like siege; attacker equipment applies in the same way (legacy path only — a
      // card army's gear is already folded into cardInstances/cardEquipInv above).
      const siegeEquip: EngineEquipmentInput | undefined =
        !hasCardArmy && attackerSave ? { gear: attackerSave.gear, inv: attackerSave.equipmentInv } : undefined;
      // Attacker synthesized iff neither a card army nor a real (team-authored) rawArmy was marched with; the NPC
      // garrison (`defenderConfig`) is always synthesized via synthesizeArmy.
      const attackerSynthesized = !hasCardArmy && rawArmy.length === 0;
      let res: SiegeResolution;
      let replay: SiegeReplayInputs | null = { seed, attackerArmy, defenderConfig, tileLevel };
      if (shouldUseCheapSiege({ attackerTroops: effTroops, defenderTroops: garrison, attackerSynthesized, defenderSynthesized: true })) {
        res = resolveSiege(effTroops, garrison);
        replay = null;
      } else {
        try {
          res = runSiegeBattle({
            attackerArmy, defenderConfig, tileLevel, seed,
            pveUpgrades: attackerSave?.pveUpgrades,
            unitLevels: attackerSave?.unitLevels,
            equipment: siegeEquip,
            cardInstances, equipmentInv: cardEquipInv,
          });
        } catch (err) {
          console.error('[worldsvc] stronghold siege engine failed — fallback to cheap resolve', {
            tile: m.toTile,
            err: (err as Error).message,
          });
          res = resolveSiege(effTroops, garrison);
          replay = null;
        }
      }
      if (hasCardArmy) {
        const cardUpdates = computeCardStateUpdates(rawArmy, pw.cardState ?? {}, res.attackerSurvivors, t);
        const cardStateSet: Record<string, unknown> = {};
        for (const [id, update] of Object.entries(cardUpdates)) {
          cardStateSet[`cardState.${id}.currentTroops`] = update.currentTroops;
          cardStateSet[`cardState.${id}.injuredUntil`] = update.injuredUntil != null ? update.injuredUntil : null;
        }
        if (Object.keys(cardStateSet).length > 0) {
          await cols.playerWorld.updateOne({ _id: pw._id }, { $set: cardStateSet, $inc: { rev: 1 } });
        }
      }

      if (res.outcome === 'attacker_win') {
        const tileDoc: TileDoc = {
          _id: m.toTile,
          worldId: m.worldId,
          x,
          y,
          type: 'territory',
          level: proc.level,
          ...(proc.resType ? { resType: proc.resType } : {}),
          ownerId: m.ownerId,
          garrison: res.attackerSurvivors,
          rev: 0,
        };
        await cols.tiles.updateOne({ _id: m.toTile }, { $set: tileDoc }, { upsert: true });
        // One-time capture reward (§3.1 "substantial resources"): add to the attacker's resource pool by tile level + resource type (capped).
        const rt: ResourceType = proc.resType ?? 'ink';
        const reward = emptyResources();
        reward[rt] = STRONGHOLD_LOOT_PER_LEVEL * Math.max(1, proc.level);
        const resources = this.core.settle(pw, t);
        for (const r of RESOURCE_TYPES) resources[r] = Math.min(RESOURCE_CAP, (resources[r] ?? 0) + reward[r]);
        const yieldRate = await this.core.recomputeYield(m.worldId, m.ownerId);
        await cols.playerWorld.updateOne(
          { _id: pw._id },
          { $set: { resources, yieldRate, lastTickAt: t }, $inc: { rev: 1 } },
        );
        // Extra progression material drop (§19.5 + G4 §15.6): sent to meta SaveData.materials unified pool (cross-process,
        // best-effort, orderId idempotent; march is settled once — (worldId, toTile, arriveAt) is stable as idempotent key).
        const matLoot = strongholdMaterialLoot(proc.level);
        void this.core.meta.grantMaterial(m.ownerId, matLoot.material, matLoot.qty, `stronghold_loot:${m.worldId}:${m.toTile}:${m.arriveAt}`);
        void this.core.applyNationChange(m.worldId, x, y, m.ownerId, pw.familyId);
        void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
        const siege = await this.recordSiege(m, undefined, res.outcome, t, replay);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
        void this.core.pushSiege(m.ownerId, siege, `${lootSummary(reward)},${matLoot.material}+${matLoot.qty}`);
        void this.core.pushTile(m.ownerId, tileDoc);
        await this.core.pushTileToObservers(tileDoc, new Set([m.ownerId])); // G5-2: stronghold capture arrival is visible to observers
      } else {
        // Capture failed: surviving attacker troops retreat and return to the troop pool (flat/legacy armies only —
        // a card army's survivors were already written to cardState above). NPC garrison is not persisted; no casualty write.
        if (!hasCardArmy && res.attackerSurvivors > 0) await refundTroops(this.core, pw, res.attackerSurvivors, t);
        void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
        const siege = await this.recordSiege(m, undefined, res.outcome, t, replay);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
        void this.core.pushSiege(m.ownerId, siege, '');
      }
    }

    /**
     * Crossing PvE siege capture (gate→bridge/plankway migration): an ownerless bridge/plankway tile guarded by an
     * NPC garrison (passageGarrison, weaker than a stronghold). Victory → write the tile back as an OWNED crossing
     * (KEEP its bridge/plankway type so it stays a passage; carry ownerId + familyId so `passableGateKeys` grants the
     * owner & family passage) with survivors as garrison; no resource/material loot (crossings are strategic choke
     * points, not resource tiles). Defeat → surviving attackers retreat and return. Defender is NPC throughout.
     */
    private async applyCrossingSiege(
      m: MarchDoc,
      pw: PlayerWorldDoc,
      t: number,
      proc: ProceduralTile,
    ): Promise<void> {
      const { cols } = this.core.deps;
      const x = this.core.coordX(m.toTile);
      const y = this.core.coordY(m.toTile);
      // CC-3: a card army's committed strength lives in cardState.currentTroops, not playerWorld.troops (see applySiege).
      const rawArmy = m.army ?? [];
      const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);
      // Re-validate on arrival: captured by someone (or self) in the meantime → skip NPC fight; refund troops as a miss.
      const occ = await cols.tiles.findOne({ _id: m.toTile });
      if (occ?.ownerId) {
        if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
        return;
      }

      const garrison = passageGarrison(proc.level);
      const attackerSave = await this.core.meta.getSaveFields(m.ownerId).catch(() => null);
      // Morale (行军疲劳, not the card 士气加成): scale attacker strength by the march's remaining morale (see applySiege above for detail).
      const moraleMult = moraleCombatMultiplier(m.morale ?? MARCH_MORALE_MAX);
      const effTroops = Math.round(m.troops * moraleMult);
      const attackerArmy: GarrisonEntry[] = scaleArmyByRatio(
        hasCardArmy
          ? resolveCardArmy(rawArmy, pw.cardState ?? {}, attackerSave?.cardInv ?? {})
          : (rawArmy.length > 0 ? (rawArmy as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker')),
        moraleMult,
      );
      let cardInstances: EngineCardInstance[] | undefined;
      let cardEquipInv: EngineEquipInv | undefined;
      if (hasCardArmy && attackerSave) {
        const { cardInstances: ci, engEquipInv } = toEngineCardInstances(rawArmy, attackerSave.cardInv, attackerSave.equipmentInv);
        cardInstances = ci;
        cardEquipInv = engEquipInv;
      }
      const tileLevel = proc.level;
      // Crossing (bridge/plankway) NPC base HP scales with tile level (npcBaseHp; 2026-07-17).
      const defenderConfig = { garrison: synthesizeArmy(garrison, 'defender'), defenderBaseHp: npcBaseHp(tileLevel) };
      const seed = siegeSeedFromId(m._id);

      const siegeEquip: EngineEquipmentInput | undefined =
        !hasCardArmy && attackerSave ? { gear: attackerSave.gear, inv: attackerSave.equipmentInv } : undefined;
      // Attacker synthesized iff neither a card army nor a real (team-authored) rawArmy was marched with; the NPC
      // garrison (`defenderConfig`) is always synthesized via synthesizeArmy.
      const attackerSynthesized = !hasCardArmy && rawArmy.length === 0;
      let res: SiegeResolution;
      let replay: SiegeReplayInputs | null = { seed, attackerArmy, defenderConfig, tileLevel };
      if (shouldUseCheapSiege({ attackerTroops: effTroops, defenderTroops: garrison, attackerSynthesized, defenderSynthesized: true })) {
        res = resolveSiege(effTroops, garrison);
        replay = null;
      } else {
        try {
          res = runSiegeBattle({
            attackerArmy, defenderConfig, tileLevel, seed,
            pveUpgrades: attackerSave?.pveUpgrades,
            unitLevels: attackerSave?.unitLevels,
            equipment: siegeEquip,
            cardInstances, equipmentInv: cardEquipInv,
          });
        } catch (err) {
          console.error('[worldsvc] crossing siege engine failed — fallback to cheap resolve', {
            tile: m.toTile,
            err: (err as Error).message,
          });
          res = resolveSiege(effTroops, garrison);
          replay = null;
        }
      }
      if (hasCardArmy) {
        const cardUpdates = computeCardStateUpdates(rawArmy, pw.cardState ?? {}, res.attackerSurvivors, t);
        const cardStateSet: Record<string, unknown> = {};
        for (const [id, update] of Object.entries(cardUpdates)) {
          cardStateSet[`cardState.${id}.currentTroops`] = update.currentTroops;
          cardStateSet[`cardState.${id}.injuredUntil`] = update.injuredUntil != null ? update.injuredUntil : null;
        }
        if (Object.keys(cardStateSet).length > 0) {
          await cols.playerWorld.updateOne({ _id: pw._id }, { $set: cardStateSet, $inc: { rev: 1 } });
        }
      }

      if (res.outcome === 'attacker_win') {
        const tileDoc: TileDoc = {
          _id: m.toTile,
          worldId: m.worldId,
          x,
          y,
          type: proc.type, // KEEP bridge/plankway — a captured crossing stays a passage, it does not become plain territory
          level: proc.level,
          ownerId: m.ownerId,
          ...(pw.familyId ? { familyId: pw.familyId } : {}), // family passage (passableGateKeys) needs the tile to carry familyId
          garrison: res.attackerSurvivors,
          rev: 0,
        };
        await cols.tiles.updateOne({ _id: m.toTile }, { $set: tileDoc }, { upsert: true });
        void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
        const siege = await this.recordSiege(m, undefined, res.outcome, t, replay);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
        void this.core.pushSiege(m.ownerId, siege, '');
        void this.core.pushTile(m.ownerId, tileDoc);
        await this.core.pushTileToObservers(tileDoc, new Set([m.ownerId]));
      } else {
        if (!hasCardArmy && res.attackerSurvivors > 0) await refundTroops(this.core, pw, res.attackerSurvivors, t);
        void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
        const siege = await this.recordSiege(m, undefined, res.outcome, t, replay);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
        void this.core.pushSiege(m.ownerId, siege, '');
      }
    }

    /**
     * Apply a single siege settlement result (G3-1 extraction, §16.4): write tile hand-off / loot / garrison / nation founding / passive relocation (attacker_win)
     * or defender garrison casualties (defender_win) according to res + record SiegeDoc + push march/siege/tile events.
     * Currently called immediately by `applySiege` (cheap settlement path unchanged); after G3-2 delayed settlement, both the judge re-computation confirmation and
     * the timeout fallback paths will share this single landing point.
     */
    private async landSiege(
      m: MarchDoc,
      pw: PlayerWorldDoc,
      target: TileDoc,
      defenderId: string,
      defender: PlayerWorldDoc | null,
      res: SiegeResolution,
      t: number,
      replay: SiegeReplayInputs | null,
    ): Promise<void> {
      const { cols } = this.core.deps;
      let loot = emptyResources();
      // CC-3: a card army's survivors are written to cardState.currentTroops below, never to playerWorld.troops.
      const hasCardArmy = !!m.army?.some((e) => !!e.cardInstanceId);

      if (res.outcome === 'attacker_win') {
        // Loot the defeated player's resources (transfer a proportion from defender to attacker).
        if (defender) loot = await this.transferLoot(defender, pw, t);
        if (target.type === 'base') {
          // The capital cannot be permanently taken, but being defeated triggers passive relocation (§3.4/§8.2, applies to all players):
          //   1) attacker survivors return to the troop pool (flat/legacy armies only); 2) if the defender is a sect leader, all sect members lose 50% of resources (§8.2 major penalty);
          //   3) defender's capital is randomly relocated to a new empty tile + all currently occupied territory is lost (passiveRelocate).
          if (!hasCardArmy) await refundTroops(this.core, pw, res.attackerSurvivors, t);
          await this.applySectLeaderPenalty(m.worldId, defenderId, t);
          await this.passiveRelocate(m.worldId, defenderId, t);
        } else {
          // Territory changes hands: survivors become the new garrison (troops were deducted on departure; do not modify the attacker pool again); both sides recompute yield.
          // A captured crossing (bridge/plankway) KEEPS its type so it stays a passage, and carries the new owner's
          // familyId so `passableGateKeys` grants the owner & family transit (plain territory captures set no familyId).
          const isCrossing = target.type === 'bridge' || target.type === 'plankway';
          await cols.tiles.updateOne(
            { _id: m.toTile },
            {
              $set: {
                type: isCrossing ? target.type : 'territory',
                ownerId: m.ownerId,
                garrison: res.attackerSurvivors,
                ...(isCrossing && pw.familyId ? { familyId: pw.familyId } : {}),
              },
              // Clear stale family passage on a crossing captured by a familyless player, plus the protection shield.
              $unset: { protectedUntil: '', ...(isCrossing && !pw.familyId ? { familyId: '' } : {}) },
              $inc: { rev: 1 },
            },
          );
          const atkYield = await this.core.recomputeYield(m.worldId, m.ownerId);
          await cols.playerWorld.updateOne(
            { _id: pw._id },
            { $set: { yieldRate: atkYield, lastTickAt: t }, $inc: { rev: 1 } },
          );
          const defYield = await this.core.recomputeYield(m.worldId, defenderId);
          await cols.playerWorld.updateOne(
            { _id: playerWorldId(m.worldId, defenderId) },
            { $set: { yieldRate: defYield }, $inc: { rev: 1 } },
          );
          // Capital tile captured → nation changes hands (S8-6.5)
          void this.core.applyNationChange(m.worldId, target.x, target.y, m.ownerId, pw.familyId);
        }
      } else {
        // Defender wins: garrison reduced to survivors; attacker survivors retreat and return to the troop pool (§16.5 survivor refund; engine provides real survivors);
        // fallen troops are permanently lost. On the cheap fallback path where attackerSurvivors=0, there is naturally no return march; behavior is unchanged.
        await cols.tiles.updateOne(
          { _id: m.toTile },
          { $set: { garrison: res.defenderSurvivors }, $inc: { rev: 1 } },
        );
        if (!hasCardArmy && res.attackerSurvivors > 0) await refundTroops(this.core, pw, res.attackerSurvivors, t);
      }

      const siege = await this.recordSiege(m, defenderId, res.outcome, t, replay);

      // CC-3: write post-battle cardState (currentTroops + injuredUntil) for attacker card army.
      const attackArmy = m.army ?? [];
      if (hasCardArmy) {
        const cardUpdates = computeCardStateUpdates(attackArmy, pw.cardState ?? {}, res.attackerSurvivors, t);
        const cardStateSet: Record<string, unknown> = {};
        for (const [id, update] of Object.entries(cardUpdates)) {
          cardStateSet[`cardState.${id}.currentTroops`] = update.currentTroops;
          if (update.injuredUntil != null) cardStateSet[`cardState.${id}.injuredUntil`] = update.injuredUntil;
          else cardStateSet[`cardState.${id}.injuredUntil`] = null; // clear stale injury
        }
        if (Object.keys(cardStateSet).length > 0) {
          await cols.playerWorld.updateOne({ _id: pw._id }, { $set: cardStateSet, $inc: { rev: 1 } });
        }
      }

      // §17.4 activity increment: siege (attacker / defender) → both sides' families +1 (landing point for decisive battles).
      void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      void this.core.bumpFamilyActivity(m.worldId, defender?.familyId, 1);
      const lootStr = lootSummary(loot);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
      void this.core.pushSiege(m.ownerId, siege, lootStr);
      void this.core.pushSiege(defenderId, siege, lootStr);
      const after = await cols.tiles.findOne({ _id: m.toTile });
      if (after) {
        void this.core.pushTile(m.ownerId, after);
        void this.core.pushTile(defenderId, after);
        await this.core.pushTileToObservers(after, new Set([m.ownerId, defenderId])); // G5-2: tile hand-off is visible to observers within vision
      }
    }

    /**
     * Sweep NPC garrison from a neutral / resource tile (sweep arrival). No occupation: on success, loot resources + surviving troops return to the pool;
     * on failure, attacker troop losses (survivors still return to the pool, possibly 0). If the tile is already player-occupied on arrival → refund troops (miss).
     */
    async applySweep(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
      const { cols } = this.core.deps;
      const occ = await cols.tiles.findOne({ _id: m.toTile });
      if (occ?.ownerId) {
        // Already occupied (should use attack) → miss; refund troops.
        await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
        return;
      }
      const proc = proceduralTile(m.worldId, this.core.coordX(m.toTile), this.core.coordY(m.toTile));
      // Morale (行军疲劳, not the card 士气加成): scale attacker strength by the march's remaining morale (see applySiege above for detail).
      const effTroops = Math.round(m.troops * moraleCombatMultiplier(m.morale ?? MARCH_MORALE_MAX));
      const res = resolveSiege(effTroops, npcGarrison(proc.level));
      let loot = emptyResources();
      if (res.outcome === 'attacker_win') {
        const rt: ResourceType = proc.resType ?? 'ink';
        loot = emptyResources();
        loot[rt] = SWEEP_LOOT_PER_LEVEL * Math.max(1, proc.level);
      }
      // Surviving troops return (loot merged into attacker resources, capped).
      await refundTroops(this.core, pw, res.attackerSurvivors, t, loot);
      const siege = await this.recordSiege(m, undefined, res.outcome, t, null);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
      void this.core.pushSiege(m.ownerId, siege, lootSummary(loot));
    }
  };
}
