// ADR-051 (P2b): real-time field encounter settlement. `resolveFieldEncounter` is invoked by a stepping march
// (combatMarch/arrival.ts advanceMarch) the moment it enters a cell already held by an ENEMY field unit — either a
// parked/stationed team (scenario 1) or an earlier-arriving march still on the cell (scenario 2, occ region
// overlap). Both are the same check: the entering march is the ATTACKER, the resident unit is the DEFENDER
// (§3.4). The battle runs through the shared deterministic engine (runSiegeBattle) with a weak symbolic base
// (defenderBaseLevel:0) so the outcome is decided army-vs-army, mirroring the ADR-026 per-wave base model.
//
// Outcome propagation (§2.2 — the winner keeps marching / standing with survivors; the loser folds back per the
// existing 折返/永损 rules):
//   attacker_win  → marcher continues (survivors carried forward, persisted on the MarchDoc by advanceMarch);
//                   the resident defender is destroyed (StationedDoc/MarchDoc removed, occ cleared, survivors=0).
//   defender_win  → marcher is destroyed (flat survivors refunded to pool / card survivors to cardState; the
//                   MarchDoc is deleted by advanceMarch); the resident defender stays with reduced survivors.
// Card armies on either side keep their own strength ledger (cardState.currentTroops via computeCardStateUpdates,
// never playerWorld.troops); flat armies deduct/refund the pool exactly like a siege. Card blueprints (level/gear)
// are injected for the ATTACKER only (defender uses base blueprints — same v1 simplification as applyBaseSiege).
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md's "拆分形态的优先级" 形态②):
// constructed with a reference to SiegeHelpersService (./helpers.ts, for recordSiege) — assembled by
// composition in ../combatSiege.ts. No behavior change.
import {
  siegeSeedFromId,
  playerWorldId,
  resolveSiege,
  MARCH_MORALE_MAX,
  moraleCombatMultiplier,
  ARROW_TOWER_DMG_RATIO,
  ARROW_TOWER_DMG_CAP,
  type SiegeResolution,
} from '@nw/shared';
import {
  runSiegeBattle,
  synthesizeArmy,
  scaleArmyByRatio,
  resolveCardArmy,
  toEngineCardInstances,
  sumArmyHp,
  toDefenderFormation,
  shouldUseCheapSiege,
} from '../siegeEngine';
import { computeCardStateUpdates, cardStateDeltaPipeline } from '../cardStateSettlement';
import type { GarrisonEntry, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import type { MarchDoc, PlayerWorldDoc, StationedDoc, ArmyEntry } from '../db';
import { WorldCore } from '../core';
import type { SiegeReplayInputs } from '../worldTypes';
import type { OccEntry, CoverEntry } from '../core/push';
import type { SiegeHelpersService } from './helpers';

/**
 * Result handed back to advanceMarch. The encounter module owns every combat ledger (both sides' cardState /
 * pool, and the DESTRUCTION of the resident defender); advanceMarch owns the entering march's OWN lifecycle
 * (persisting survivors on victory, deleting the MarchDoc on defeat) since it already claims/reschedules it.
 */
export interface FieldEncounterResult {
  /** True iff a battle actually ran (false = the occupant turned out to be a friend / no longer present). */
  fought: boolean;
  /** True iff the entering march survived and should keep marching. False → advanceMarch must remove the march. */
  marcherContinues: boolean;
  /** New (unscaled) troop count to persist on the MarchDoc when it continues (flat armies; unchanged for card). */
  marcherTroops: number;
  /** New army snapshot to persist when it continues (scaled flat/team army). Undefined → leave MarchDoc.army as-is. */
  marcherArmy?: ArmyEntry[];
  /**
   * 2026-08-01 (SLG_DESIGN_LOG §46): only set when marcherContinues=false (a defeat). The flat troop count a
   * travel-time return leg should carry home (0 for a card army, whose strength already lives in cardState) —
   * undefined means no return leg at all (a full flat-army wipe, matching the pre-existing convention that
   * there's nothing to send home). advanceMarch must spawn the return leg AFTER it deletes the original
   * MarchDoc (not here) — both docs share the same teamId, and a unique {worldId,ownerId,teamId} index would
   * reject the new leg while the old one (same team, still 'marching') hasn't been removed yet.
   */
  returnTroops?: number;
}

/** ADR-051 (P5): result of one arrow-tower chip on a march entering a covered cell. */
export interface TowerDamageResult {
  /** False = friendly tower / nothing to chip (no persistence needed). */
  applied: boolean;
  /** True = a flat army was reduced to 0 → advanceMarch must delete the march. Card armies never wipe from towers. */
  marcherDestroyed: boolean;
  /** New troop count to persist on the MarchDoc (flat survivors; card total after reduction, for display). */
  marcherTroops: number;
  /** New flat army snapshot to persist; undefined → leave MarchDoc.army as-is (card armies keep their entries). */
  marcherArmy?: ArmyEntry[];
}

/** Two field units are friends (no encounter) when they share an owner or a family. */
function isFriendlyOcc(pwFamilyId: string | undefined, ownerId: string, occ: OccEntry): boolean {
  return occ.ownerId === ownerId || (!!pwFamilyId && !!occ.familyId && occ.familyId === pwFamilyId);
}

export class EncounterService {
  constructor(
    private readonly core: WorldCore,
    private readonly helpers: SiegeHelpersService,
  ) {}

  /**
   * Write post-battle card survivors (currentTroops + injuredUntil) for one side's card army, and mirror the
   * change onto the in-memory playerWorld doc so a march that fights MULTIPLE encounters in one step batch
   * computes each subsequent survival off the already-reduced troops (not the stale departure count).
   */
  private async writeFieldCardState(pw: PlayerWorldDoc, army: ArmyEntry[], survivors: number, t: number, deployed?: number): Promise<void> {
    const core = this.core;
    const cardUpdates = computeCardStateUpdates(army, pw.cardState ?? {}, survivors, t, deployed);
    // 2026-08-24: persist the battle's per-card LOSS, not an absolute survivor count — see
    // cardStateDeltaPipeline. Identical result with no concurrent write; a distributeTroops top-up that does
    // land in the window now survives instead of being erased.
    pw.cardState = pw.cardState ?? {};
    for (const [id, update] of Object.entries(cardUpdates)) {
      // Keep the in-memory copy consistent for a possible second encounter in the same advanceMarch loop.
      // Mirror the same clamped subtraction the pipeline performs, so the second encounter's `deployed`
      // matches what the database now holds rather than the absolute this used to assume.
      const prev = pw.cardState[id]?.currentTroops ?? 0;
      pw.cardState[id] = {
        ...(pw.cardState[id] ?? { currentTroops: 0 }),
        currentTroops: Math.max(0, prev - update.losses),
        ...(update.injuredUntil != null ? { injuredUntil: update.injuredUntil } : {}),
      };
    }
    const cardPipeline = cardStateDeltaPipeline(cardUpdates);
    if (cardPipeline.length > 0) await core.deps.cols.playerWorld.updateOne({ _id: pw._id }, cardPipeline);
  }

  /**
   * ADR-051 (P5 §5.2): apply one arrow-tower's pass-through chip to a march entering a cell inside the tower's
   * 3×3 coverage. No battle, no stop — just `min(troops·ratio, cap)` off the marcher's army, once per covered
   * cell. Card armies scale each card's currentTroops (floored, never wiped/injured — an auto-weaken tower);
   * flat armies lose troops and can be destroyed outright (0 survivors). The tower's own hp is untouched (only an
   * attack march damages it). advanceMarch owns persisting the returned troops/army and deleting on destruction.
   */
  async applyTowerDamage(m: MarchDoc, pw: PlayerWorldDoc, tower: CoverEntry, t: number): Promise<TowerDamageResult> {
    const noOp: TowerDamageResult = { applied: false, marcherDestroyed: false, marcherTroops: m.troops, marcherArmy: m.army };
    // Own / same-family tower never chips (advanceMarch already filters, but stay defensive).
    if (tower.ownerId === m.ownerId || (!!pw.familyId && tower.familyId === pw.familyId)) return noOp;

    const rawA = m.army ?? [];
    const aHasCard = rawA.some((e) => !!e.cardInstanceId);

    if (aHasCard) {
      // Reduce card strength proportionally off the CURRENT card total (reflects earlier encounters this batch,
      // so repeated tower hits compound). Kept > 0 so a tower only weakens — never wipes or injures — a card army.
      const cardIds = rawA.map((e) => e.cardInstanceId).filter((id): id is string => !!id);
      const cs = pw.cardState ?? {};
      const currentTotal = cardIds.reduce((s, id) => s + (cs[id]?.currentTroops ?? 0), 0);
      if (currentTotal <= 0) return noOp;
      const dmg = Math.min(Math.round(currentTotal * ARROW_TOWER_DMG_RATIO), ARROW_TOWER_DMG_CAP);
      if (dmg <= 0) return noOp;
      const survivors = Math.max(1, currentTotal - dmg);
      await this.writeFieldCardState(pw, rawA, survivors, t);
      const newTotal = cardIds.reduce((s, id) => s + (pw.cardState?.[id]?.currentTroops ?? 0), 0);
      return { applied: true, marcherDestroyed: false, marcherTroops: newTotal, marcherArmy: m.army };
    }

    // Flat / synthesized army: subtract troops and scale the army snapshot; 0 survivors → the march is destroyed.
    const troops = m.troops;
    if (troops <= 0) return noOp;
    const dmg = Math.min(Math.round(troops * ARROW_TOWER_DMG_RATIO), ARROW_TOWER_DMG_CAP);
    if (dmg <= 0) return noOp;
    const survivors = Math.max(0, troops - dmg);
    const ratio = survivors / troops;
    const newArmy = rawA.length > 0 ? (scaleArmyByRatio(rawA as GarrisonEntry[], ratio) as ArmyEntry[]) : undefined;
    return { applied: true, marcherDestroyed: survivors <= 0, marcherTroops: survivors, marcherArmy: newArmy };
  }

  async resolveFieldEncounter(m: MarchDoc, pw: PlayerWorldDoc, defenderOcc: OccEntry, tid: string, t: number): Promise<FieldEncounterResult> {
    const core = this.core;
    const { cols } = core.deps;
    const noFight: FieldEncounterResult = { fought: false, marcherContinues: true, marcherTroops: m.troops, marcherArmy: m.army };

    // Friend on the tile (same owner / same family) → no encounter (O1: passing an ally's field unit is free).
    if (isFriendlyOcc(pw.familyId, m.ownerId, defenderOcc)) return noFight;

    // Load the resident defender doc. Scenario 1: a StationedDoc keyed by the tile. Scenario 2: a MarchDoc by id.
    // If it has vanished since the occ read (recalled / already settled), treat as no encounter — advanceMarch
    // will overwrite the stale occ entry with its own as it steps on.
    let defRaw: ArmyEntry[];
    let defTroops: number;
    const defOwnerId = defenderOcc.ownerId;
    let defMarch: MarchDoc | null = null;
    let defStationed: StationedDoc | null = null;
    if (defenderOcc.kind === 'stationed') {
      defStationed = await cols.stationed.findOne({ _id: defenderOcc.id });
      if (!defStationed) return noFight;
      defRaw = defStationed.army ?? [];
      defTroops = defStationed.troops;
    } else {
      defMarch = await cols.marches.findOne({ _id: defenderOcc.id, status: 'marching' });
      if (!defMarch) return noFight;
      defRaw = defMarch.army ?? [];
      defTroops = defMarch.troops;
    }

    // ── Build both armies (attacker = the entering march, morale-scaled + card blueprints; defender = resident,
    //    no morale, base blueprints — same asymmetry as applyBaseSiege). ──
    const rawA = m.army ?? [];
    const aHasCard = rawA.some((e) => !!e.cardInstanceId);
    const dHasCard = defRaw.some((e) => !!e.cardInstanceId);
    // Attacker/defender snapshots are independent internal-HTTP round trips — fetch them together instead of
    // sequentially (comm-audit batch F item 6). Defender only ever needs cardInv (no per-card gear buff on
    // defence, same v1 simplification as applyBaseSiege).
    const [aSave, dSave] = await Promise.all([
      aHasCard ? core.meta.getSaveFields(m.ownerId, ['cardInv', 'equipmentInv']).catch(() => null) : Promise.resolve(null),
      dHasCard ? core.meta.getSaveFields(defOwnerId, ['cardInv']).catch(() => null) : Promise.resolve(null),
    ]);
    const moraleMult = moraleCombatMultiplier(m.morale ?? MARCH_MORALE_MAX);
    const attackerArmy: GarrisonEntry[] = scaleArmyByRatio(
      aHasCard
        ? resolveCardArmy(rawA, pw.cardState ?? {}, aSave?.cardInv ?? {})
        : (rawA.length > 0 ? (rawA as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker')),
      moraleMult,
    );
    let aCardInstances: EngineCardInstance[] | undefined;
    let aCardEquipInv: EngineEquipInv | undefined;
    if (aHasCard && aSave) {
      const { cardInstances, engEquipInv } = toEngineCardInstances(rawA, aSave.cardInv ?? {}, aSave.equipmentInv ?? {});
      aCardInstances = cardInstances;
      aCardEquipInv = engEquipInv;
    }

    const defPw = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, defOwnerId) });
    const defenderGarrison: GarrisonEntry[] = toDefenderFormation(
      dHasCard
        ? resolveCardArmy(defRaw, defPw?.cardState ?? {}, dSave?.cardInv ?? {})
        : (defRaw.length > 0 ? (defRaw as GarrisonEntry[]) : synthesizeArmy(defTroops, 'defender')),
    );

    const attackerHp = sumArmyHp(attackerArmy);
    const defenderHp = sumArmyHp(defenderGarrison);
    // Pure army-vs-army: pin the symbolic base to the weakest level so it never tanks the fight (§3.4/ADR-026).
    const defenderConfig = { garrison: defenderGarrison, defenderBaseLevel: 0 };
    const tileLevel = 1;
    // Seed from the encounter instance (marcher × defender × tile) so a re-computation / replay is identical.
    const seed = siegeSeedFromId(`${m._id}:${defenderOcc.id}:${tid}`);

    const attackerSynthesized = !aHasCard && rawA.length === 0;
    const defenderSynthesized = !dHasCard && defRaw.length === 0;
    let res: SiegeResolution;
    // 2026-08-01 (traceability decision, see combatSiege/arrival.ts applySiege for the full rationale): replay
    // inputs are kept unconditionally, including on an engine crash — getSiegeReplay degrades safely on both
    // ends rather than crashing, so there is no downside to keeping the exact inputs that caused a crash.
    // 2026-08-12 fix: aCardInstances/aCardEquipInv are the exact attacker inputs fed into runSiegeBattle
    // just below (or the shared blueprint table, on the cheap path) — omitting them made a from-scratch
    // replay of a card-army encounter reconstruct from plain baseline blueprints instead of the
    // attacker's real stats (see SiegeReplayInputs' doc comment, worldTypes.ts). Field encounters have
    // no siegeAcademy input (v1 simplification, same as the defender's gear — see the comment above).
    const replay: SiegeReplayInputs = {
      seed, attackerArmy, defenderConfig, tileLevel,
      ...(aCardInstances ? { cardInstances: aCardInstances } : {}),
      ...(aCardEquipInv ? { equipmentInv: aCardEquipInv } : {}),
    };
    if (shouldUseCheapSiege({ attackerTroops: attackerHp, defenderTroops: defenderHp, attackerSynthesized, defenderSynthesized })) {
      res = resolveSiege(attackerHp, defenderHp);
    } else {
      try {
        res = await runSiegeBattle({ attackerArmy, defenderConfig, tileLevel, seed, cardInstances: aCardInstances, equipmentInv: aCardEquipInv });
      } catch (err) {
        console.error('[worldsvc] field encounter engine failed — fallback to cheap resolve', { tile: tid, err: (err as Error).message });
        res = resolveSiege(attackerHp, defenderHp);
      }
    }

    const marcherWon = res.outcome === 'attacker_win';
    const aSurvivors = res.attackerSurvivors;
    const dSurvivors = res.outcome === 'defender_win' ? res.defenderSurvivors : 0;
    // ADR-069: ratios (and the cardState writes below) divide by what each side ACTUALLY deployed —
    // per-unit HP clamped to blueprint capacity on the engine path — not by the nominal troop sums
    // `attackerHp`/`defenderHp`, which for a real card team are typically ~2× larger. The cheap path
    // reports nominal troops as its deployed values, so those fights are unchanged.
    const aDeployed = res.attackerDeployed > 0 ? res.attackerDeployed : attackerHp;
    const dDeployed = res.defenderDeployed > 0 ? res.defenderDeployed : defenderHp;
    const aRatio = aDeployed > 0 ? aSurvivors / aDeployed : 0;
    const dRatio = dDeployed > 0 ? dSurvivors / dDeployed : 0;

    // ── Marcher (attacker) ledger. Card survivors → cardState (both outcomes). Flat: carry forward on win
    //    (troops stay in transit); on defeat, retreat home over a travel-time return leg (2026-08-01,
    //    SLG_DESIGN_LOG §46) instead of an instant pool credit — but the return leg itself is spawned by
    //    advanceMarch AFTER it deletes this MarchDoc (see FieldEncounterResult.returnTroops), not here: both
    //    docs share the same teamId, and inserting the new leg while the old one (same team) still exists
    //    trips the {worldId,ownerId,teamId} uniqueness guard.
    if (aHasCard) {
      await this.writeFieldCardState(pw, rawA, aSurvivors, t, aDeployed);
    }

    // ── Defender ledger. Card survivors → cardState (both outcomes). ──
    if (dHasCard && defPw) {
      await this.writeFieldCardState(defPw, defRaw, dSurvivors, t, dDeployed);
    }
    if (marcherWon) {
      // Resident defender destroyed: remove its doc + occupancy so the marcher can take the cell (advanceMarch
      // writes its own occ next). Flat survivors are 0 (permanent loss); card floor already written above.
      if (defStationed) {
        await cols.stationed.deleteOne({ _id: defenderOcc.id });
        // A destroyed garrison (P3b scenario-3 interception) also drops its 3×3 coverage from the reverse index.
        if (defStationed.mode === 'garrison') await core.removeCover(m.worldId, defStationed.x, defStationed.y, defStationed.tile);
      } else if (defMarch) {
        const claimed = await cols.marches.findOneAndDelete({ _id: defenderOcc.id, status: 'marching' });
        if (claimed) {
          void core.pushMarch(defOwnerId, core.marchView({ ...claimed, status: 'recalled' }));
        }
      }
      await core.clearOccupancy(m.worldId, tid, defenderOcc.id);
    } else {
      // Defender holds with reduced survivors; occupancy stays. Flat: rewrite troops (+ scaled army snapshot).
      if (!dHasCard) {
        const newDefTroops = Math.round(defTroops * dRatio);
        const newDefArmy = defRaw.length > 0 ? (scaleArmyByRatio(defRaw as GarrisonEntry[], dRatio) as ArmyEntry[]) : undefined;
        if (defStationed) {
          await cols.stationed.updateOne(
            { _id: defenderOcc.id },
            { $set: { troops: newDefTroops, ...(newDefArmy ? { army: newDefArmy } : {}) } },
          );
        } else if (defMarch) {
          await cols.marches.updateOne(
            { _id: defenderOcc.id, status: 'marching' },
            { $set: { troops: newDefTroops, ...(newDefArmy ? { army: newDefArmy } : {}) }, $inc: { rev: 1 } },
          );
        }
      }
    }

    // Battle report (attacker=marcher, defender=resident owner) pinned to the ENCOUNTER cell, not the march's
    // ultimate destination — so the replay/report points where the fight happened. Pushed to both owners.
    const siege = await this.helpers.recordSiege({ ...m, toTile: tid }, defOwnerId, res.outcome, t, replay);
    void core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
    void core.bumpFamilyActivity(m.worldId, defPw?.familyId, 1);
    void core.pushSiege(m.ownerId, siege, '');
    void core.pushSiege(defOwnerId, siege, '');

    if (marcherWon) {
      return {
        fought: true,
        marcherContinues: true,
        marcherTroops: aHasCard ? m.troops : Math.round(m.troops * aRatio),
        marcherArmy: aHasCard ? m.army : (rawA.length > 0 ? (scaleArmyByRatio(rawA as GarrisonEntry[], aRatio) as ArmyEntry[]) : undefined),
      };
    }
    // Marcher defeated: advanceMarch deletes the MarchDoc, then — if returnTroops is set (a card army always
    // qualifies at 0; a flat army only if it has real survivors) — spawns the travel-time return leg.
    return {
      fought: true,
      marcherContinues: false,
      marcherTroops: 0,
      ...(aHasCard || aSurvivors > 0 ? { returnTroops: aHasCard ? 0 : aSurvivors } : {}),
    };
  }
}
