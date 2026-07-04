// worldsvc combat domain: siege / sweep arrival settlement (S8-3) + delayed building-HP model (ADR-026).
// Peeled out of CombatService (2026-07-03). Depends on WorldCore for shared state, settle/yield, push/schedule
// infra, nations (applyNationChange), loot protection and vision. Marches (combatMarch) dispatch attack/sweep
// arrivals here via applySiege / applySweep. No behavior change.
import {
  proceduralTile,
  tileId,
  siegeId,
  playerWorldId,
  resolveSiege,
  siegeSeedFromId,
  npcGarrison,
  strongholdGarrison,
  STRONGHOLD_LOOT_PER_LEVEL,
  strongholdMaterialLoot,
  nearestCapitalIdx,
  SIEGE_LOOT_RATE,
  SWEEP_LOOT_PER_LEVEL,
  RESOURCE_CAP,
  RESOURCE_TYPES,
  PROTECTION_SEC,
  NATION_BONUS_DEFENSE,
  nationDefenseStrength,
  wallDefenseMult,
  cabinetLootProtect,
  academyBuff,
  teamSiegeValue,
  waveSeed,
  buildingMaxHp,
  SLG_SIEGE_DAMAGE_DELAY_MS,
  SLG_TEAM_INJURY_MS,
  SECT_LEADER_PENALTY_RATE,
  type CardInstance,
  type ResourceType,
  type SiegeOutcome,
  type SiegeResolution,
  type ProceduralTile,
} from '@nw/shared';
import { runSiegeBattle, synthesizeArmy, scaleArmyHp, scaleArmyByRatio, sumArmyHp, toDefenderFormation, resolveCardArmy, toEngineCardInstances, computeCardStateUpdates } from './siegeEngine';
import type { GarrisonEntry, EngineEquipmentInput, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { ENGINE_VERSION } from '@nw/engine';
import type { TileDoc, PlayerWorldDoc, MarchDoc, SiegeDoc, SiegeDamageDoc, DefenseConfig, ArmyEntry } from './db';
import { WorldCore, lootSummary, emptyResources } from './core';
import type { SiegeReplayInputs } from './worldTypes';
import { refundTroops } from './combatShared';

export class SiegeService {
  constructor(private readonly core: WorldCore) {}

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

    const maxHp = buildingMaxHp(tile.level ?? 1);
    const curHp = tile.hp ?? maxHp;
    const newHp = curHp - Math.max(0, Math.floor(d.damage));

    if (newHp > 0) {
      // Building survives: reduce HP; besiegers return to the pool.
      await cols.tiles.updateOne({ _id: d.tile }, { $set: { hp: newHp }, $inc: { rev: 1 } });
      if (attacker && d.attackerSurvivors > 0) await refundTroops(this.core, attacker, d.attackerSurvivors, t);
      const after = await cols.tiles.findOne({ _id: d.tile });
      if (after) { void this.core.pushTile(d.attackerId, after); void this.core.pushTile(defenderId, after); }
      return;
    }

    // HP depleted → capture. Loot first (settles both sides' resources).
    const defender = await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, defenderId) });
    if (attacker && defender) await this.transferLoot(defender, attacker, t);

    if (d.isBase) {
      // Main base captured: it cannot be permanently held → besiegers return; sect-leader penalty; passive relocation
      // (all territory lost + shield + a fresh full-HP base at a random tile).
      if (attacker && d.attackerSurvivors > 0) await refundTroops(this.core, attacker, d.attackerSurvivors, t);
      await this.applySectLeaderPenalty(d.worldId, defenderId, t);
      await this.passiveRelocate(d.worldId, defenderId, t);
    } else {
      // Non-base building handed over: survivors become the new garrison; HP resets to full for the new owner.
      await cols.tiles.updateOne(
        { _id: d.tile },
        {
          $set: { type: 'territory', ownerId: d.attackerId, garrison: d.attackerSurvivors, hp: maxHp },
          $unset: { protectedUntil: '' },
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
    const target = await cols.tiles.findOne({ _id: m.toTile });
    // Stronghold PvE capture (G8 §3.1): target has no owner and procedural type is stronghold → fight the ultra-strong system NPC garrison;
    // victory captures it as territory + grants a one-time rich reward; defeat causes surviving attackers to retreat and return. Intercept before the "miss and refund" branch.
    if (!target?.ownerId) {
      const proc = proceduralTile(m.worldId, this.core.coordX(m.toTile), this.core.coordY(m.toTile));
      if (proc.type === 'stronghold') {
        await this.applyStrongholdSiege(m, pw, t, proc);
        return;
      }
    }
    // On arrival, target is no longer enemy-owned (abandoned / transferred to own / ownerless) or is now protected → treat as a miss; refund and return troops.
    if (
      !target?.ownerId ||
      target.ownerId === m.ownerId ||
      (target.protectedUntil && target.protectedUntil > t)
    ) {
      await refundTroops(this.core, pw, m.troops, t);
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
    // Nation defense bonus (§2.4 / G1): if the garrison tile is within the Voronoi region of a capital the defender occupies → effective garrison strength is increased.
    const capIdx = nearestCapitalIdx(baseTile.x, baseTile.y, this.core.capitals);
    const nation = await cols.nations.findOne({ _id: `nation:${m.worldId}:${capIdx}` });
    const inOwnNation = !!nation?.ownerId && nation.ownerId === defenderId;
    const effGarrison = nationDefenseStrength(baseTile.garrison ?? 0, inOwnNation);

    // E8/CC-3: fetch attacker's progression snapshot early (needed for card army resolution + blueprint injection).
    const attackerSave = await this.core.meta.getSaveFields(m.ownerId).catch(() => null);

    // Attacker formation (G3-2c): marched with a team → use the real formation snapshot (m.army); otherwise synthesize from flat troop count as fallback (v1 bridge).
    // CC-3: when army entries carry cardInstanceId, resolve to engine GarrisonEntry[] via cardState.currentTroops + CARD_DEFS.unitType.
    const rawArmy = m.army ?? [];
    const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);
    const attackerArmy: GarrisonEntry[] =
      hasCardArmy
        ? resolveCardArmy(rawArmy, pw.cardState ?? {}, attackerSave?.cardInv ?? {})
        : (rawArmy.length > 0 ? (rawArmy as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker'));
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
      await this.applyBaseSiege(
        m, pw, baseTile, defenderId, defender, inOwnNation,
        attackerArmy, cardInstances, cardEquipInv, siegeAcademy, attackerSave?.cardInv ?? {}, t,
      );
      return;
    }

    // ── Territory tile (non-base): single deterministic battle + immediate settlement (unchanged, §16) ──
    const defenderConfig = this.buildDefenderConfig(baseTile, effGarrison, inOwnNation);
    const tileLevel = baseTile.level ?? 1;
    const seed = siegeSeedFromId(m._id);

    // Bad formation / engine error → fall back to cheap resolveSiege; a single siege must never stall a march.
    let res: SiegeResolution;
    let replay: SiegeReplayInputs | null = { seed, attackerArmy, defenderConfig, tileLevel };
    try {
      res = runSiegeBattle({ attackerArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv, siegeAcademy });
    } catch (err) {
      console.error('[worldsvc] siege engine failed — fallback to cheap resolve', { tile: m.toTile, err: (err as Error).message });
      res = resolveSiege(m.troops, effGarrison);
      replay = null; // cheap fallback result is inconsistent with engine replay → do not store replay inputs (replay button degrades to hidden).
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
    t: number,
  ): Promise<void> {
    const { cols } = this.core.deps;
    const tileLevel = baseTile.level ?? 1;
    const wallMult = wallDefenseMult(defender?.buildings);

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
      if (wallMult > 1) defArmy = scaleArmyHp(defArmy, wallMult);               // P2 wall HP buff
      if (defArmy.length === 0) { defeatedTeamIds.push(tm.id); continue; }      // empty/stale team → already cleared (still injured)
      // ADR-026: the per-wave engine "base" is only a battle terminator (the real building durability is TileDoc.hp,
      // reduced separately by the delayed siege-value hit). Pin it to the weakest level so each wave is decided by
      // team-vs-attacker, not by a symbolic base tanking the assault.
      const defenderConfig = { garrison: defArmy, defenderBaseLevel: 0 };
      const seed = waveSeed(m._id, i);
      const deployedHp = sumArmyHp(survivorArmy);
      let res: SiegeResolution;
      try {
        res = runSiegeBattle({ attackerArmy: survivorArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv, siegeAcademy });
      } catch (err) {
        console.error('[worldsvc] base wave siege engine failed — cheap fallback', { tile: baseTile._id, wave: i, err: (err as Error).message });
        res = resolveSiege(deployedHp, sumArmyHp(defArmy));
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

    // CC-3: attacker card post-battle state (uniform survival over the whole siege).
    const attackArmy = m.army ?? [];
    if (attackArmy.some((e) => !!e.cardInstanceId)) {
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
      // (sum of the team's per-card 攻城值; a real card team is always > 0). Attacker keeps besieging; survivors are refunded at settlement.
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
    } else {
      // Attacker repelled: survivors retreat and return to the troop pool immediately.
      if (attackerSurvivors > 0) await refundTroops(this.core, pw, attackerSurvivors, t);
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
    // Re-validate on arrival: already occupied by another player or self (including simultaneous captures) → skip NPC fight; refund troops as a miss.
    const occ = await cols.tiles.findOne({ _id: m.toTile });
    if (occ?.ownerId) {
      await refundTroops(this.core, pw, m.troops, t);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      return;
    }

    const garrison = strongholdGarrison(proc.level);
    const attackerArmy: GarrisonEntry[] =
      m.army && m.army.length > 0 ? (m.army as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker');
    // System ultra-strong default garrison + elevated base (defenderBaseLevel is derived and clamped by buildSiegeLevel from tileLevel).
    const defenderConfig = { garrison: synthesizeArmy(garrison, 'defender') };
    const tileLevel = proc.level;
    const seed = siegeSeedFromId(m._id);

    // E8: stronghold is also a PvE-like siege; attacker equipment applies in the same way.
    const attackerSave = await this.core.meta.getSaveFields(m.ownerId).catch(() => null);
    const siegeEquip: EngineEquipmentInput | undefined =
      attackerSave ? { gear: attackerSave.gear, inv: attackerSave.equipmentInv } : undefined;
    let res: SiegeResolution;
    let replay: SiegeReplayInputs | null = { seed, attackerArmy, defenderConfig, tileLevel };
    try {
      res = runSiegeBattle({
        attackerArmy, defenderConfig, tileLevel, seed,
        pveUpgrades: attackerSave?.pveUpgrades,
        unitLevels: attackerSave?.unitLevels,
        equipment: siegeEquip,
      });
    } catch (err) {
      console.error('[worldsvc] stronghold siege engine failed — fallback to cheap resolve', {
        tile: m.toTile,
        err: (err as Error).message,
      });
      res = resolveSiege(m.troops, garrison);
      replay = null;
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
      // Capture failed: surviving attacker troops retreat and return to the troop pool (troops were deducted on departure; casualties are a permanent loss). NPC garrison is not persisted; no casualty write.
      if (res.attackerSurvivors > 0) await refundTroops(this.core, pw, res.attackerSurvivors, t);
      void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      const siege = await this.recordSiege(m, undefined, res.outcome, t, replay);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
      void this.core.pushSiege(m.ownerId, siege, '');
    }
  }

  /**
   * Build the defender's formation for a siege (G3-2b): a custom formation (`tile.defense` contains a garrison array, written by the G3-2c editor) takes priority;
   * otherwise, synthesize a deterministic default formation from the effective garrison size (including nation bonus). Empty garrison (no custom + 0 troops) → null;
   * buildSiegeBattle derives a token base defense.
   *
   * Nation bonus (§2.4 / G1 item②, completed in G3-2c): when the garrison tile is within the defender's own capital Voronoi region (inOwnNation):
   * **synthesis path** already benefits by having extra units from effGarrison (troop count amplified by nationDefenseStrength);
   * **custom formation path** scales each unit's initialHp by (1+NATION_BONUS_DEFENSE) (scaleArmyHp, engine caps at full HP).
   */
  private buildDefenderConfig(
    target: TileDoc,
    effGarrison: number,
    inOwnNation: boolean,
  ): { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown } | null {
    const custom = target.defense as DefenseConfig | undefined;
    const customGarrison = custom && (custom as { garrison?: unknown }).garrison;
    if (Array.isArray(customGarrison) && customGarrison.length > 0) {
      const garrison = inOwnNation
        ? scaleArmyHp(customGarrison as GarrisonEntry[], 1 + NATION_BONUS_DEFENSE)
        : (customGarrison as GarrisonEntry[]);
      return { ...custom, garrison };
    }
    return effGarrison > 0 ? { garrison: synthesizeArmy(effGarrison, 'defender') } : null;
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

    if (res.outcome === 'attacker_win') {
      // Loot the defeated player's resources (transfer a proportion from defender to attacker).
      if (defender) loot = await this.transferLoot(defender, pw, t);
      if (target.type === 'base') {
        // The capital cannot be permanently taken, but being defeated triggers passive relocation (§3.4/§8.2, applies to all players):
        //   1) attacker survivors return to the troop pool; 2) if the defender is a sect leader, all sect members lose 50% of resources (§8.2 major penalty);
        //   3) defender's capital is randomly relocated to a new empty tile + all currently occupied territory is lost (passiveRelocate).
        await refundTroops(this.core, pw, res.attackerSurvivors, t);
        await this.applySectLeaderPenalty(m.worldId, defenderId, t);
        await this.passiveRelocate(m.worldId, defenderId, t);
      } else {
        // Territory changes hands: survivors become the new garrison (troops were deducted on departure; do not modify the attacker pool again); both sides recompute yield.
        await cols.tiles.updateOne(
          { _id: m.toTile },
          {
            $set: { type: 'territory', ownerId: m.ownerId, garrison: res.attackerSurvivors },
            $unset: { protectedUntil: '' },
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
      if (res.attackerSurvivors > 0) await refundTroops(this.core, pw, res.attackerSurvivors, t);
    }

    const siege = await this.recordSiege(m, defenderId, res.outcome, t, replay);

    // CC-3: write post-battle cardState (currentTroops + injuredUntil) for attacker card army.
    const attackArmy = m.army ?? [];
    if (attackArmy.some((e) => !!e.cardInstanceId)) {
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
    const res = resolveSiege(m.troops, npcGarrison(proc.level));
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

  /**
   * Record a siege battle report (transient record, §14.3 sieges). When replay is non-null (decisive siege ran through the engine), persist seed + both sides'
   * formations + tile level for client-side replay spectating (getSiegeReplay); cheap fallback / NPC sweep → replay=null (no replay available).
   */
  private async recordSiege(
    m: MarchDoc,
    defenderId: string | undefined,
    outcome: SiegeOutcome,
    t: number,
    replay: SiegeReplayInputs | null,
  ): Promise<SiegeDoc> {
    const doc: SiegeDoc = {
      _id: siegeId(m.worldId, m.ownerId, t, ++this.core.siegeSeq),
      worldId: m.worldId,
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
  private async transferLoot(
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
  private async applySectLeaderPenalty(worldId: string, defenderId: string, t: number): Promise<void> {
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
   */
  private async passiveRelocate(worldId: string, defenderId: string, t: number): Promise<void> {
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
      return;
    }

    const newTid = tileId(worldId, spot.x, spot.y);
    // ADR-025: write the full 3×3 footprint (anchor garrison:0 + protection shield); ring cells carry the same shield.
    const baseDocs = this.core.baseTileDocs(worldId, spot.x, spot.y, defenderId, {
      garrison: 0,
      level: spot.level,
      ...(spot.resType ? { resType: spot.resType } : {}),
      protectedUntil: t + PROTECTION_SEC * 1000, // relocated to safety: apply protection shield
      ...(pw.familyId ? { familyId: pw.familyId } : {}),
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
  }
}
