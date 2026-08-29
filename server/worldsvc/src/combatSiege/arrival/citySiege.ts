// ADR-074 P1 wild-city siege arrival (SLG_CITY_SIEGE_DESIGN §5). Split as an independent function module
// like its siblings (baseSiege/strongholdSiege/crossingSiege/landSiege): takes `core` (a plain WorldCore)
// plus the narrow `SiegeCtx`, and is called only from `applySiege`.
//
// Shape: the attacking march fights the city's FULL NPC wave ladder (CITY_WAVE_COUNT waves, survivors
// carrying over between waves scaled by each wave's honest survival ratio — the same ADR-069 arithmetic
// `applyBaseSiege` uses). Clearing the ladder schedules ONE delayed durability hit equal to the team's
// `teamSiegeValue`; being repelled deals nothing and still costs the troops that died.
//
// Two deliberate differences from `applyBaseSiege`, both forced by measurement (econ-sim citySiegeRun.ts,
// registered in ECONOMY_VERIFICATION_LOG §13-SLG-CITYSIEGE):
//
//  1. **Each wave gets an explicit `defenderBaseHp`** (`cityWaveBaseHp(level)`). `applyBaseSiege` omits it
//     and falls back to the engine's flat BASE_HP=100 — which, since ADR-069 made a unit's siege value
//     scale with the troops it carries, a single 300-troop shieldbearer one-shots. The wave then ends
//     before the garrison ever engages, so the whole ladder is FREE. Measured: ~99 troops lost at
//     baseHp=100 vs ~730 at baseHp=600 against the same 4,500-troop wave. The per-siege troop cost is the
//     only thing bounding how much durability one player can chip per hour, so a free ladder removes the
//     entire single-player-proof argument.
//  2. **The ladder is per-march, never shared city state.** A shared ladder with a respawn timer means
//     every march arriving while it is empty clears "no defenders" and still collects the full durability
//     hit — one player with SIEGE_TEAM_CAP=5 teams and a ~24-second round trip to an adjacent city lands
//     dozens of zero-cost hits per respawn window. P3's owner-stationed defender teams DO get a lockout
//     (through `teamState[id].injuredUntil`, see cityDefenders.ts); the NPC ladder does not.
import {
  resolveSiege,
  teamSiegeValue,
  waveSeed,
  cityWaveCount,
  cityWaveGarrison,
  cityWaveBaseHp,
  SLG_SIEGE_DAMAGE_DELAY_MS,
  MARCH_MORALE_MAX,
  moraleCombatMultiplier,
  type SiegeResolution,
  type SiegeOutcome,
} from '@nw/shared';
import {
  runSiegeBattle, synthesizeArmy, scaleArmyByRatio, sumArmyHp, resolveCardArmy, toEngineCardInstances, shouldUseCheapSiege,
} from '../../siegeEngine';
import { computeCardStateUpdates, cardStateDeltaPipeline } from '../../cardStateSettlement';
import type { GarrisonEntry, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import type { PlayerWorldDoc, MarchDoc, SiegeDamageDoc } from '../../db';
import type { WorldCore } from '../../core';
import type { CityState } from '../../core/citySiege';
import type { SiegeReplayInputs } from '../../worldTypes';
import { startReturnMarch, parkMarchInPlace, refundTroops } from '../../combatShared';
import type { SiegeCtx } from '../ctx';
import { fightCityDefenders } from './cityDefenders';

/**
 * Fight one city's wave ladder. Returns the outcome plus the honest survival bookkeeping the caller needs
 * (ADR-069: the nominal troop total the march left home with, times the running product of each wave's
 * survivors ÷ that wave's real clamped deployment — dividing engine survivors by nominal troops instead
 * used to shave 40-60% off a card team's troops on every battle, won ones included).
 */
async function fightWaveLadder(
  core: WorldCore,
  m: MarchDoc,
  city: CityState,
  attackerArmy: GarrisonEntry[],
  attackerHp: number,
  attackerSynthesized: boolean,
  cardInstances: EngineCardInstance[] | undefined,
  cardEquipInv: EngineEquipInv | undefined,
  /**
   * How many rungs were already fought before this ladder (P3's defender teams). Folded into every
   * `waveSeed` here so no two rungs of one assault share a seed — the whole ladder still reconstructs from
   * the march id alone, which is what the replay viewer depends on.
   */
  seedOffset = 0,
): Promise<{ cleared: boolean; wavesCleared: number; survivors: number; cumSurvivalRatio: number; replay: SiegeReplayInputs | null }> {
  const waves = cityWaveCount(city.level);
  const waveGarrison = cityWaveGarrison(city.level);
  const waveBaseHp = cityWaveBaseHp(city.level);

  let survivorArmy: GarrisonEntry[] = attackerArmy.map((e) => ({ ...e }));
  let survivors = attackerHp;
  let cumSurvivalRatio = 1;
  let wavesCleared = 0;
  let cleared = true;
  let lastReplay: SiegeReplayInputs | null = null;

  for (let i = 0; i < waves; i++) {
    const deployedHp = sumArmyHp(survivorArmy);
    if (survivorArmy.length === 0 || deployedHp <= 0) { cleared = false; break; }
    const defenderConfig = { garrison: synthesizeArmy(waveGarrison, 'defender'), defenderBaseLevel: 0, defenderBaseHp: waveBaseHp };
    // `waveSeed(marchId, i)` folds the wave index into the march's own siege seed, so the whole ladder is
    // reproducible from the march id alone — the property the replay viewer depends on.
    const seed = waveSeed(m._id, seedOffset + i);
    lastReplay = {
      seed, attackerArmy: survivorArmy, defenderConfig, tileLevel: city.level,
      ...(cardInstances ? { cardInstances } : {}),
      ...(cardEquipInv ? { equipmentInv: cardEquipInv } : {}),
    };
    let res: SiegeResolution;
    if (shouldUseCheapSiege({ attackerTroops: deployedHp, defenderTroops: waveGarrison, attackerSynthesized, defenderSynthesized: true })) {
      res = resolveSiege(deployedHp, waveGarrison);
    } else {
      try {
        res = await runSiegeBattle({ attackerArmy: survivorArmy, defenderConfig, tileLevel: city.level, seed, cardInstances, equipmentInv: cardEquipInv });
      } catch (err) {
        console.error('[worldsvc] city wave siege engine failed — cheap fallback', { city: city._id, wave: i, err: (err as Error).message });
        res = resolveSiege(deployedHp, waveGarrison);
      }
    }
    survivors = res.attackerSurvivors;
    // `deployedHp` (nominal) is the right denominator only on the cheap/flat path, where the two coincide;
    // the engine path reports its own clamped deployment (ADR-069).
    const waveDeployed = res.attackerDeployed > 0 ? res.attackerDeployed : deployedHp;
    const ratio = waveDeployed > 0 ? Math.min(1, res.attackerSurvivors / waveDeployed) : 0;
    cumSurvivalRatio *= ratio;
    if (res.outcome !== 'attacker_win') { cleared = false; break; }
    wavesCleared++;
    survivorArmy = scaleArmyByRatio(survivorArmy, ratio);
    if (survivorArmy.length === 0) { cleared = false; break; } // spent: cleared some waves but cannot continue
  }

  return { cleared, wavesCleared, survivors, cumSurvivalRatio, replay: lastReplay };
}

/**
 * Wild-city siege arrival. The march landed on a cell of the city's footprint; the target is the whole
 * city (§4.1 — the plot is indivisible, so which cell was hit is irrelevant beyond connectivity, already
 * re-validated by `applySiege` before this is reached).
 *
 * Arrival-time re-validation (departure-time checks can all go stale in transit):
 *  · the besieger must still be in a sect (leaving one mid-march must not let the siege land);
 *  · the city must not already belong to the besieger's own sect;
 *  · the city must not be inside its post-capture protection window.
 * Any of those → treat as a miss (park the team in place, or refund a teamless march) exactly like
 * `applySiege`'s own stale-target branch.
 */
export async function applyCitySiege(
  core: WorldCore,
  ctx: SiegeCtx,
  m: MarchDoc,
  pw: PlayerWorldDoc,
  city: CityState,
  t: number,
): Promise<void> {
  const { cols } = core.deps;
  const x = core.coordX(m.toTile);
  const y = core.coordY(m.toTile);
  const rawArmy = m.army ?? [];
  const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);

  const miss = async (): Promise<void> => {
    if (m.teamId) {
      await parkMarchInPlace(core, m, m.troops, t);
    } else {
      if (!hasCardArmy) await refundTroops(core, pw, m.troops, t);
      void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'recalled' }));
    }
  };

  const sectId = pw.sectId;
  if (!sectId) return miss();                                  // left the sect in transit
  if (city.ownerSectId === sectId) return miss();               // own sect took it while this march flew
  if ((city.protectedUntil ?? 0) > t) return miss();            // post-capture protection

  // ── Attacker force resolution (same shape as resolveOccupationBattle / applySiege) ──
  const attackerSave = hasCardArmy ? await core.meta.getSaveFields(m.ownerId).catch(() => null) : null;
  const moraleMult = moraleCombatMultiplier(m.morale ?? MARCH_MORALE_MAX);
  const rawAttackerArmy: GarrisonEntry[] = hasCardArmy
    ? resolveCardArmy(rawArmy, pw.cardState ?? {}, attackerSave?.cardInv ?? {})
    : (rawArmy.length > 0 ? (rawArmy as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker'));
  const attackerArmy: GarrisonEntry[] = scaleArmyByRatio(rawAttackerArmy, moraleMult);
  const nominalDeployed = Math.round(sumArmyHp(rawAttackerArmy) * moraleMult);
  let cardInstances: EngineCardInstance[] | undefined;
  let cardEquipInv: EngineEquipInv | undefined;
  if (hasCardArmy && attackerSave) {
    const { cardInstances: ci, engEquipInv } = toEngineCardInstances(rawArmy, attackerSave.cardInv ?? {}, attackerSave.equipmentInv ?? {});
    cardInstances = ci;
    cardEquipInv = engEquipInv;
  }
  const attackerSynthesized = !hasCardArmy && rawArmy.length === 0;

  // ADR-074 P3: the owning sect's garrison teams fight FIRST, ahead of the untouched NPC ladder (see
  // cityDefenders.ts for why additive rather than substitutive). An NPC-held city has none, so this returns
  // without a single battle call and the pre-P3 path is reached unchanged.
  const guard = await fightCityDefenders(
    core, m, city, attackerArmy, nominalDeployed, attackerSynthesized, cardInstances, cardEquipInv, t,
  );
  // Repelled by a defender team → the NPC ladder is never reached and nothing is scheduled. The attacker
  // still paid for the attempt (its card losses are written below from the combined ratio).
  const ladder = guard.cleared
    ? await fightWaveLadder(
        core, m, city, guard.survivorArmy, Math.round(nominalDeployed * guard.cumSurvivalRatio),
        attackerSynthesized, cardInstances, cardEquipInv, guard.teamsCleared,
      )
    : { cleared: false, wavesCleared: 0, survivors: 0, cumSurvivalRatio: 1, replay: guard.replay };
  // ONE survival fraction over the whole assault, defender rungs and NPC waves together — multiplying the
  // two ladders' ratios rather than letting the second overwrite the first (the ADR-069 mistake).
  const cumSurvivalRatio = guard.cumSurvivalRatio * ladder.cumSurvivalRatio;

  // Attacker card bookkeeping: one honest survival fraction over the whole multi-wave assault (ADR-069).
  if (hasCardArmy) {
    const cardUpdates = computeCardStateUpdates(
      rawArmy, pw.cardState ?? {}, Math.round(nominalDeployed * cumSurvivalRatio), t, nominalDeployed,
    );
    const pipeline = cardStateDeltaPipeline(cardUpdates);
    if (pipeline.length > 0) await cols.playerWorld.updateOne({ _id: pw._id }, pipeline);
  }

  const outcome: SiegeOutcome = ladder.cleared ? 'attacker_win' : 'defender_win';
  // `defenderId` stays undefined: a city is held by a SECT, not an account, so there is no single
  // defender to record or to push an under_attack warning at. The owning sect learns about it from the
  // sect-channel announcement `settleCityDamage` posts on capture.
  const siege = await ctx.recordSiege(m, undefined, outcome, t, ladder.replay ?? guard.replay);

  if (ladder.cleared) {
    // Ladder cleared → schedule the delayed durability hit (§5: 5-minute settlement delay, the same
    // `siegeDamage` pipeline the main-base path uses). Survivors keep besieging and are returned at
    // settlement, exactly like `applyBaseSiege`.
    //
    // ADR-074 P3 (§8.3): the attacker's sect adds a siege-value bonus from the capitals and world center it
    // holds (+3% each, +5%). Applied HERE, on the durability hit, and as its OWN multiplier — deliberately
    // not summed into `EFFECT_CAPS.siegePct_fp`, which is equipment's accumulator and is capped: sharing one
    // accumulator would mean a well-equipped attacker gets nothing from their sect's conquests because the
    // cap was already reached. Whole-map control is x1.32, which P2's single-player-proof gate was measured
    // with (ECONOMY_VERIFICATION_LOG §13-SLG-CITYSIEGE ③ carried both this and equipment's +60% as
    // hypothetical channels, leaving 1.43x-1.56x of margin), so wiring it does not move that verdict.
    const sectSiegeBonus = (await core.sectPayoff(sectId)).siegeBonus;
    // SLG_CITY_SIEGE_DESIGN §12.7 twin item (wired 2026-08-29): the attacker's equipped gear now feeds the
    // same m_siege/s_siege channel the in-battle engine already reads, saturating at +60% like everything else.
    const damage = Math.floor(teamSiegeValue(rawArmy, attackerSave?.cardInv ?? {}, attackerSave?.equipmentInv ?? {}) * (1 + sectSiegeBonus));
    const dmg: SiegeDamageDoc = {
      _id: siege._id,
      worldId: m.worldId,
      attackerId: m.ownerId,
      tile: m.toTile,
      isBase: false,
      cityId: city._id,
      attackerSectId: sectId,
      damage,
      attackerSurvivors: ladder.survivors,
      ...(pw.familyId ? { familyId: pw.familyId } : {}),
      dueAt: t + SLG_SIEGE_DAMAGE_DELAY_MS,
    };
    await cols.siegeDamage.updateOne({ _id: dmg._id }, { $setOnInsert: dmg }, { upsert: true });
  } else if (hasCardArmy || ladder.survivors > 0) {
    // Repelled: survivors walk home over a real return leg (2026-08-01, SLG_DESIGN_LOG §46). A card
    // army's survivors are already written to cardState above, so its return leg carries troops:0.
    await startReturnMarch(core, {
      worldId: m.worldId, ownerId: m.ownerId, fromTile: m.toTile, x, y,
      troops: hasCardArmy ? 0 : ladder.survivors,
      army: m.army, teamId: m.teamId, leaderUnitType: m.leaderUnitType,
    }, t);
  }

  void core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
  void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'arrived' }));
  void core.pushSiege(m.ownerId, siege, '');
}
