// S8-3 siege / sweep arrival settlement: applySiege dispatches to the ADR-026 main-base wave path
// (applyBaseSiege), the stronghold PvE path (applyStrongholdSiege), or the territory/base/structure/
// crossing landing (landSiege) — 2026-08-09: a plain-territory win there is no longer instant, see
// landSiege's own doc comment; applySweep handles neutral/resource-tile clears. Bodies moved verbatim
// out of combatSiege.ts (2026-07-07 split). Depends on SiegeHelpersService (buildDefenderConfig /
// recordSiege / transferLoot / applySectLeaderPenalty / passiveRelocate) and OccupationService
// (applyOccupationExpulsion / writeContestedHold / startOccupationHold).
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md's "拆分形态的优先级"
// 形态②): constructed with references to SiegeHelpersService and OccupationService — the only siege
// domain class that needs both. Builds one bound `ctx: SiegeCtx` (see ./ctx.ts) at construction time
// to pass into the five arrival/*.ts free functions below, which only ever need a handful of specific
// methods, not the full sibling instances. Assembled by composition in ../combatSiege.ts.
//
// Split into independent function modules (2026-08-10, 独立函数模块 form — applyBaseSiege/
// applyStrongholdSiege/applyCrossingSiege/landSiege are all PRIVATE, called only from applySiege in
// this same file, so unlike pve.ts/liveops.ts's public-mixin-interface handlers there is no
// requirement that they stay methods on the assembled class at all: each takes `core` (a plain
// WorldCore instance) and `ctx` (typed narrowly as SiegeCtx). applyStrongholdSiege/
// applyCrossingSiege additionally shrank a lot: their NPC-garrison battle-resolution logic turned out
// to be byte-identical to applyOccupy's (occupation.ts), so both now call occupationBattle.ts's
// resolveOccupationBattle/writeOccupyCardState instead of duplicating it locally.
// - arrival/baseSiege.ts:       applyBaseSiege (ADR-026 wave defense)
// - arrival/strongholdSiege.ts: applyStrongholdSiege (G8 §3.1 PvE)
// - arrival/crossingSiege.ts:   applyCrossingSiege (bridge/plankway PvE)
// - arrival/landSiege.ts:       landSiege (G3-1 territory/base/structure/crossing settlement, §16.4)
// - arrival/sweep.ts:           applySweep (neutral/resource tile clear)
// No behavior change.
import {
  proceduralTile,
  siegeSeedFromId,
  playerWorldId,
  resolveSiege,
  provinceIdxAt,
  nationDefenseStrength,
  academyBuff,
  MARCH_MORALE_MAX,
  moraleCombatMultiplier,
  type SiegeResolution,
} from '@nw/shared';
import { runSiegeBattle, synthesizeArmy, scaleArmyByRatio, sumArmyHp, resolveCardArmy, toEngineCardInstances, shouldUseCheapSiege } from '../siegeEngine';
import type { GarrisonEntry, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { ENGINE_VERSION } from '@nw/engine';
import type { TileDoc, PlayerWorldDoc, MarchDoc } from '../db';
import { WorldCore } from '../core';
import type { SiegeReplayInputs } from '../worldTypes';
import { refundTroops, parkMarchInPlace } from '../combatShared';
import type { SiegeHelpersService } from './helpers';
import type { OccupationService } from './occupation';
import type { SiegeCtx } from './ctx';
import { applyBaseSiege } from './arrival/baseSiege';
import { applyStrongholdSiege } from './arrival/strongholdSiege';
import { applyCrossingSiege } from './arrival/crossingSiege';
import { landSiege } from './arrival/landSiege';
import { applySweep as applySweepImpl } from './arrival/sweep';

export class ArrivalService {
  private readonly ctx: SiegeCtx;

  constructor(
    private readonly core: WorldCore,
    private readonly helpers: SiegeHelpersService,
    private readonly occupation: OccupationService,
  ) {
    // Narrow ctx passed into the five arrival/*.ts free functions (see ./ctx.ts's doc comment) — each
    // method bound to whichever sibling actually owns it, so `ctx.recordSiege(...)` etc. still resolve
    // `this` correctly inside helpers/occupation's own method bodies.
    this.ctx = {
      recordSiege: helpers.recordSiege.bind(helpers),
      transferLoot: helpers.transferLoot.bind(helpers),
      applySectLeaderPenalty: helpers.applySectLeaderPenalty.bind(helpers),
      passiveRelocate: helpers.passiveRelocate.bind(helpers),
      writeContestedHold: occupation.writeContestedHold.bind(occupation),
      startOccupationHold: occupation.startOccupationHold.bind(occupation),
    };
  }

  // ── S8-3: siege / sweep arrival settlement (cheap formula, §5.3; decisive battles use engine re-computation in S8-3b via judge) ──

  /**
   * Siege another player's territory/capital (attack arrival). On arrival, re-validate that the target is still enemy-owned and unprotected; otherwise refund troops.
   * Cheap linear settlement resolveSiege(attacker troops, garrison):
   *   - attacker_win + plain territory → 2026-08-09: NOT instant anymore — starts the same OCCUPY_HOLD_SEC
   *     occupation hold as occupying neutral land (mirrors ADR-037 §5.4's startOccupationHold): the defender
   *     loses the tile (and its yield) right away, but the attacker's ownerId only lands OCCUPY_HOLD_SEC later
   *     via settleOccupation — during which anyone (including the original owner) can expel the pending
   *     claim via a fresh 'attack' march (see the `!target?.ownerId && contestedBy` branch above). Loot still
   *     transfers and the win is still recorded/pushed immediately, unaffected. A team the attacker marched
   *     with is held busy for the hold too and defaults to stationing on the tile once it settles — same
   *     team-lifecycle semantics as a real occupy hold, deliberate (user decision), not a bug.
   *   - attacker_win + player-owned bridge/plankway → unchanged, still instant (excluded from the above so
   *     settleOccupation's hardcoded `type:'territory'` on settlement doesn't turn a crossing into plain land).
   *   - attacker_win + base      → capital cannot be permanently taken: garrison wiped + defeated player gets a protection shield + loot taken + attacker survivors return to troop pool;
   *   - defender_win             → all attacker committed troops destroyed (already deducted on departure, not refunded) + defender garrison takes casualties.
   */
  async applySiege(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
    const { cols } = this.core.deps;
    // CC-3: a card-army march's committed strength lives entirely in cardState.currentTroops, never in
    // playerWorld.troops (CHARACTER_CARDS_DESIGN §6.1/§9) — every refund path below must skip the pool credit
    // for such a march (nothing was ever deducted from the pool for it; see combatMarch/command.ts's matching guard).
    const hasCardArmy = !!m.army?.some((e) => !!e.cardInstanceId);
    const target = await cols.tiles.findOne({ _id: m.toTile });
    // ADR-039 territory connectivity: the attacker's sect territory can shift during transit (an intervening
    // loss can strand the attacker), so re-validate here before any capture branch — treat like a miss (refund).
    // Capitals check against their whole 3×3 footprint (targetFootprintCells), not just the landed cell.
    const footprint = this.core.targetFootprintCells(target, this.core.coordX(m.toTile), this.core.coordY(m.toTile));
    if (!(await this.core.isConnectedToSectTerritory(m.worldId, m.ownerId, footprint))) {
      // 2026-08-01 (SLG_DESIGN_LOG §46): target invalidated on arrival → park in place (team-dispatched
      // marches) rather than teleport home instantly; a teamless march has no team-slot identity to park
      // under, so it keeps the old instant refund.
      if (m.teamId) {
        await parkMarchInPlace(this.core, m, m.troops, t);
      } else {
        if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      }
      return;
    }
    // Stronghold PvE capture (G8 §3.1): target has no owner and procedural type is stronghold → fight the ultra-strong system NPC garrison;
    // victory captures it as territory + grants a one-time rich reward; defeat causes surviving attackers to retreat and return. Intercept before the "miss and refund" branch.
    if (!target?.ownerId) {
      const proc = proceduralTile(m.worldId, this.core.coordX(m.toTile), this.core.coordY(m.toTile));
      if (proc.type === 'stronghold') {
        await applyStrongholdSiege(this.core, this.ctx, m, pw, t, proc);
        return;
      }
      // Crossing PvE capture (bridge/plankway): fight the NPC garrison; victory captures it as an owned crossing
      // (KEEPS its bridge/plankway type so it stays a passage), defeat retreats. Intercept before the miss/refund branch.
      if (proc.type === 'bridge' || proc.type === 'plankway') {
        await applyCrossingSiege(this.core, this.ctx, m, pw, t, proc);
        return;
      }
      // ADR-037 (§5.4): target has no owner but is mid occupation-hold (an occupy march already won its PvE
      // battle and is waiting out the hold countdown) — this attack expels the pending occupier, fighting their
      // held garrison (not a re-fetched NPC garrison). Intercept before the miss/refund branch below.
      if (target?.contestedBy && (target.contestedUntil ?? 0) > t) {
        await this.occupation.applyOccupationExpulsion(m, pw, target, t);
        return;
      }
    }
    // On arrival, target is no longer enemy-owned (abandoned / transferred to own / ownerless) or is now protected → treat as a miss; refund and return troops.
    if (
      !target?.ownerId ||
      target.ownerId === m.ownerId ||
      (target.protectedUntil && target.protectedUntil > t)
    ) {
      if (m.teamId) {
        await parkMarchInPlace(this.core, m, m.troops, t);
      } else {
        if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      }
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
    // For a base siege, also kick off the defender's card-only snapshot here so it runs in parallel with the
    // attacker fetch instead of after (comm-audit batch F item 6 — applyBaseSiege used to fetch it itself,
    // sequentially, once this method reached it); defender only ever needs cardInv (no per-card gear buff on
    // defence — see applyBaseSiege's doc comment).
    const isBaseSiege = target.type === 'base';
    const [attackerSave, defenderSaveForBase] = await Promise.all([
      this.core.meta.getSaveFields(m.ownerId, ['cardInv', 'equipmentInv']).catch(() => null),
      isBaseSiege ? this.core.meta.getSaveFields(defenderId, ['cardInv']).catch(() => null) : Promise.resolve(null),
    ]);

    // Attacker formation (G3-2c): marched with a team → use the real formation snapshot (m.army); otherwise synthesize from flat troop count as fallback (v1 bridge).
    // CC-3: when army entries carry cardInstanceId, resolve to engine GarrisonEntry[] via cardState.currentTroops + CARD_DEFS.unitType.
    const rawArmy = m.army ?? [];
    // Morale (行军疲劳 — see SLG_DESIGN.md §4.4; distinct from the card "士气加成" bonus): long-distance marches arrive fatigued — scale the whole attacker formation's effective HP
    // down by the march's remaining morale (captured once at departure, combatMarch/command.ts). Also used below to
    // scale the cheap-formula troop count so both settlement paths stay consistent.
    const moraleMult = moraleCombatMultiplier(m.morale ?? MARCH_MORALE_MAX);
    // hasCardArmy already computed at the top of applySiege (miss/recall branches need it before we get here).
    const rawAttackerArmy: GarrisonEntry[] = hasCardArmy
      ? resolveCardArmy(rawArmy, pw.cardState ?? {}, attackerSave?.cardInv ?? {})
      : (rawArmy.length > 0 ? (rawArmy as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker'));
    const attackerArmy: GarrisonEntry[] = scaleArmyByRatio(rawAttackerArmy, moraleMult);
    // Real attacker strength for the cheap-siege path: for a card army, m.troops degenerates to roughly the
    // card-slot count (CC-3 — real strength lives in cardState.currentTroops, already folded into
    // rawAttackerArmy above via resolveCardArmy), so using m.troops here would floor every card to the base
    // survival rate regardless of true strength. A single Math.round(...*moraleMult) on the UNSCALED army's
    // HP sum (rather than summing the already per-unit-floored attackerArmy) avoids quantization loss
    // compounding across many small HP_PER_UNIT-sized chunks — for a flat/synthesized army
    // sumArmyHp(rawAttackerArmy) equals m.troops exactly (1 troop = 1 HP unit), so this is byte-for-byte the
    // same as the old m.troops-based formula for every non-card march, and only changes behavior for card armies.
    const attackerHp = Math.round(sumArmyHp(rawAttackerArmy) * moraleMult);
    // CC-3: extract EngineCardInstance[] from the attacker's card army for blueprint injection (level + gear); shared by both paths.
    let cardInstances: EngineCardInstance[] | undefined;
    let cardEquipInv: EngineEquipInv | undefined;
    if (hasCardArmy && attackerSave) {
      const { cardInstances: ci, engEquipInv } = toEngineCardInstances(rawArmy, attackerSave.cardInv ?? {}, attackerSave.equipmentInv ?? {});
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
      await applyBaseSiege(
        this.core, this.ctx, m, pw, baseTile, defenderId, defender, inOwnNation,
        attackerArmy, cardInstances, cardEquipInv, siegeAcademy, attackerSave?.cardInv ?? {}, attackerSynthesized, t,
        defenderSaveForBase,
      );
      return;
    }

    // ── Territory tile (non-base): single deterministic battle + immediate settlement (unchanged, §16) ──
    const defenderConfig = this.helpers.buildDefenderConfig(baseTile, effGarrison, inOwnNation);
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
    // 2026-08-01 (traceability decision): replay inputs are kept unconditionally, even when only the cheap
    // linear formula ran or the engine itself crashed — the user judged "save one engine run / hide a crash"
    // not worth losing the ability to inspect or reproduce a battle after the fact. getSiegeReplay's fetch is
    // wrapped in try/catch on both the server (httpApi.ts's top-level handler → clean 500) and the client
    // (world.ts's goSiegeReplay → falls back to the map) — a replay that itself fails to reconstruct/re-run
    // degrades safely, it does not crash worldsvc or the client. The client's "replay" is a from-scratch
    // re-simulation from seed+army (db.ts SiegeDoc.seed doc comment — already documented as presentation-only,
    // not authoritative), so replaying a cheap-resolved battle can show a different winner than the
    // recorded/settled `res.outcome` — an accepted tradeoff (same drift category already accepted for
    // mid-season engineVersion drift, see the warning a few lines up).
    // 2026-08-12 fix: cardInstances/equipmentInv/siegeAcademy must ride along too — these are the exact
    // inputs about to be passed to runSiegeBattle a few lines down (or already fed the shared-blueprint
    // table `buildSiegeBlueprints` builds from); omitting them made every card-army replay reconstruct
    // from plain baseline blueprints instead of the attacker's real stats (see SiegeReplayInputs' doc
    // comment, worldTypes.ts, for the production incident this closes).
    const replay: SiegeReplayInputs = {
      seed, attackerArmy, defenderConfig, tileLevel,
      ...(cardInstances ? { cardInstances } : {}),
      ...(cardEquipInv ? { equipmentInv: cardEquipInv } : {}),
      ...(siegeAcademy ? { siegeAcademy } : {}),
    };
    if (shouldUseCheapSiege({ attackerTroops: attackerHp, defenderTroops: effGarrison, attackerSynthesized, defenderSynthesized })) {
      res = resolveSiege(attackerHp, effGarrison);
    } else {
      try {
        res = await runSiegeBattle({ attackerArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv, siegeAcademy });
      } catch (err) {
        console.error('[worldsvc] siege engine failed — fallback to cheap resolve', { tile: m.toTile, err: (err as Error).message });
        res = resolveSiege(attackerHp, effGarrison);
      }
    }
    // Replay inputs: persisted to SiegeDoc; the client uses seed + both sides' formations to replay the battle locally for spectating (§16.3).
    await landSiege(this.core, this.ctx, m, pw, target, defenderId, defender, res, t, replay);
  }

  /** Sweep NPC garrison from a neutral / resource tile (sweep arrival) — see arrival/sweep.ts. */
  async applySweep(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
    return applySweepImpl(this.core, this.ctx, m, pw, t);
  }
}
