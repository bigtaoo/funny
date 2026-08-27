// ADR-074 P3: the OWNER's side of a wild-city siege (SLG_CITY_SIEGE_DESIGN §P3 "宗门驻防队接入波次防守").
//
// A held city can now be defended by real players: sect members park garrison-mode teams inside its
// footprint (`stationableCityAt` is the gate; `move` with `stationMode:'garrison'` is the order), and an
// assault has to fight through them.
//
// **Additive, not substitutive** — the design doc's P3 line said 替代 (replace), and that was decided
// against on 2026-08-27 (user's call) because the same document makes the 3 NPC waves the ONLY thing
// bounding one player's damage per hour (§5, measured in P2). Replacing a rung with a defender team means a
// city defended by weak teams is EASIER to break than an NPC-held one, which is both a balance regression
// against a measured gate and a trap for the player who garrisoned it. Defender teams therefore run AHEAD
// of the untouched NPC ladder: garrisoning your own city is a strict upside, and P2's troop-cost floor is
// preserved to the unit.
//
// Shape is deliberately `applyBaseSiege`'s, rung for rung — non-injured teams in a deterministic order,
// attacker survivors carried between rungs by the ADR-069 honest survival ratio, and each defeated team
// locked out with `teamState.{id}.injuredUntil = t + SLG_TEAM_INJURY_MS`.
//
// ⚠️ `CityDoc.defenderLock` is NOT used, and P1's comment on that field (which reserved it for exactly this
// feature) is retired. The mechanism already existed: `PlayerWorldDoc.teamState[id].injuredUntil` is what
// `applyBaseSiege` writes, `SLG_TEAM_INJURY_MS` is the same window, and `CITY_WAVE_RESPAWN_MS` is asserted
// equal to it in `shared/test/citySiege.test.ts`. A per-CITY lock would additionally be wrong: a team spent
// defending city X could immediately defend city Y, since nothing about the team itself recorded that it had
// fought. One team, one injury clock.
import {
  playerWorldId,
  resolveSiege,
  waveSeed,
  SLG_TEAM_INJURY_MS,
  NATION_BONUS_DEFENSE,
  cityWaveBaseHp,
  cityDefenderFortifyMult,
  cityDefenderTeamFortify,
  cityDefenderBaseHp,
  type SiegeResolution,
} from '@nw/shared';
import {
  runSiegeBattle, scaleArmyHp, scaleArmyByRatio, sumArmyHp, toDefenderFormation, resolveCardArmy,
  toEngineCardInstances, shouldUseCheapSiege,
} from '../../siegeEngine';
import { computeCardStateUpdates, cardStateDeltaPipeline } from '../../cardStateSettlement';
import { garrisonProgressionRatios } from '@nw/engine';
import type { GarrisonEntry, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import type { MarchDoc, StationedDoc, PlayerWorldDoc } from '../../db';
import type { WorldCore } from '../../core';
import type { CityState } from '../../core/citySiege';
import type { SiegeReplayInputs } from '../../worldTypes';

/** One garrison team standing in the city, with everything needed to field it. */
interface CityDefender {
  stationed: StationedDoc;
  owner: PlayerWorldDoc;
  /**
   * The team's REAL army — one entry per card, `initialHp` = the troops that card actually carries.
   * Deliberately unscaled: this is the troop truth the post-battle loss bookkeeping settles against
   * (`computeCardStateUpdates(..., sumArmyHp(d.army))` at the bottom of this file). The progression
   * bonus below is a combat-only buff and must never be written back as troops the player owns.
   */
  army: GarrisonEntry[];
  /**
   * ADR-077 §12: how much this team's OWNER's card levels and gear fortify the position it holds, as a
   * multiplier on the rung's symbolic base HP. Exactly 1 for a bare level-1 roster, and for a team whose
   * save could not be read — both of which reproduce the pre-P4 battle to the unit.
   *
   * Base HP rather than the garrison's own HP, and that was decided by measurement, not taste: scaling
   * garrison HP was implemented first and econ-sim gate ⑦ measured it as worth nothing at all (a garrison
   * fielding 32,508 effective HP cost the reference attacker 1,209 troops against 1,245 on bare
   * blueprints). The objective is `destroy_base` against a deliberately small `cityWaveBaseHp`, so one
   * attacker unit slipping past ends the rung however fat the garrison is. See @nw/shared's
   * `cityDefenderBaseHp` for the full measured curve.
   */
  fortify: number;
}

/** Outcome of the defender-team half of the ladder, in the shape the NPC half needs to continue from. */
export interface DefenderLadderResult {
  /** False once a defender team repelled the assault — the NPC ladder is then never reached. */
  cleared: boolean;
  /** How many defender teams were beaten (0 when the city had none — the pre-P3 case). */
  teamsCleared: number;
  /** Attacker army after carrying survivors through every rung fought. */
  survivorArmy: GarrisonEntry[];
  /** Product of each rung's honest survival ratio (1 when no rung was fought). */
  cumSurvivalRatio: number;
  /** Last rung's replay inputs, or null. */
  replay: SiegeReplayInputs | null;
  /** Whether any defender team was present at all — used only for logging/telemetry decisions. */
  hadDefenders: boolean;
}

/**
 * The garrison teams eligible to defend this city right now.
 *
 * Eligibility is deliberately re-derived here rather than trusted from the parked document: the city can
 * have changed hands, and the parker can have left the sect, since the team landed. A team belonging to a
 * sect that no longer owns the city simply does not defend it (it is also, by then, standing in someone
 * else's fortress — recalling it is the owner's problem, not this function's).
 */
async function eligibleDefenders(core: WorldCore, city: CityState, t: number): Promise<CityDefender[]> {
  const { cols } = core.deps;
  if (!city.ownerSectId) return [];
  const r = (city.footprint - 1) / 2;
  const parked = await cols.stationed
    .find({
      worldId: city.worldId,
      x: { $gte: city.x - r, $lte: city.x + r },
      y: { $gte: city.y - r, $lte: city.y + r },
      mode: 'garrison',
    })
    .toArray();
  if (parked.length === 0) return [];

  // Deterministic order (by cell id) so the ladder — and therefore its replay seeds — is reproducible from
  // the march id alone, the property the replay viewer depends on.
  parked.sort((a, b) => a._id.localeCompare(b._id));

  const owners = await cols.playerWorld
    .find({ _id: { $in: [...new Set(parked.map((p) => playerWorldId(city.worldId, p.ownerId)))] } })
    .toArray();
  const byId = new Map(owners.map((o) => [o._id, o]));

  const out: CityDefender[] = [];
  for (const st of parked) {
    const owner = byId.get(playerWorldId(city.worldId, st.ownerId));
    if (!owner) continue;
    if (owner.sectId !== city.ownerSectId) continue;                                  // left the sect, or never was in it
    if ((owner.teamState?.[st.teamId]?.injuredUntil ?? 0) > t) continue;               // spent; healing
    // The team's live strength comes from the owner's cardState (a card army's troops live there), not from
    // the roster template — the same resolution `applyBaseSiege` uses for in-base teams.
    const save = await core.meta.getSaveFields(st.ownerId).catch(() => null);
    const resolved = resolveCardArmy(st.army, owner.cardState ?? {}, save?.cardInv ?? {});
    const army = toDefenderFormation(resolved);
    if (army.length === 0 || sumArmyHp(army) <= 0) continue;                           // empty/stale park
    // ADR-077: the defending team's own progression, spent as effective HP. `getSaveFields` with no
    // field list already returns BOTH cardInv and equipmentInv, so this costs no extra round trip —
    // the equipment half of that response was simply being discarded before. A save that failed to
    // load leaves `hpMult` empty, i.e. the plain baseline, which is exactly the pre-P4 behaviour.
    const { cardInstances, engEquipInv } = toEngineCardInstances(st.army, save?.cardInv ?? {}, save?.equipmentInv ?? {});
    const ratios = garrisonProgressionRatios(cardInstances, engEquipInv);
    // Troop-weighted over the RESOLVED army, so eleven empty level-9 cards behind one full level-1 card
    // cannot buy the maximum factor — `resolved` carries each card's real troop allotment.
    const fortify = cityDefenderTeamFortify(
      resolved.map((e) => ({
        troops: e.initialHp ?? 0,
        mult: cityDefenderFortifyMult(ratios.hp[e.unitType] ?? 1, ratios.attack[e.unitType] ?? 1),
      })),
    );
    out.push({ stationed: st, owner, army, fortify });
  }
  return out;
}

/**
 * Fight the city's garrison teams, ahead of the NPC wave ladder.
 *
 * Returns immediately with `cleared: true` and an untouched attacker when the city has no eligible
 * defenders, which is every NPC-held city and therefore the overwhelmingly common path — so the pre-P3
 * behaviour is reached without so much as a battle call.
 */
export async function fightCityDefenders(
  core: WorldCore,
  m: MarchDoc,
  city: CityState,
  attackerArmy: GarrisonEntry[],
  nominalDeployed: number,
  attackerSynthesized: boolean,
  cardInstances: EngineCardInstance[] | undefined,
  cardEquipInv: EngineEquipInv | undefined,
  t: number,
): Promise<DefenderLadderResult> {
  const { cols } = core.deps;
  const defenders = await eligibleDefenders(core, city, t);
  const base: DefenderLadderResult = {
    cleared: true, teamsCleared: 0, survivorArmy: attackerArmy, cumSurvivalRatio: 1, replay: null, hadDefenders: false,
  };
  if (defenders.length === 0) return base;

  // §9 (2026-08-27): the province-capital defence bonus is now keyed on CITY ownership. `nations` has had no
  // writer since P0 deleted `applyNationChange`, so reading it here would be reading a field nothing sets —
  // the bonus would silently never apply. A capital defended by the sect that holds it gets it; a graded
  // city does not (§8.3 gives capitals their military identity, graded cities stay purely economic).
  const defenceMult = city.kind === 'capital' || city.kind === 'worldCenter' ? 1 + NATION_BONUS_DEFENSE : 1;

  let survivorArmy: GarrisonEntry[] = attackerArmy.map((e) => ({ ...e }));
  let cumSurvivalRatio = 1;
  let teamsCleared = 0;
  let cleared = true;
  let lastReplay: SiegeReplayInputs | null = null;
  const defeated: CityDefender[] = [];

  for (let i = 0; i < defenders.length; i++) {
    const d = defenders[i]!;
    const deployedHp = sumArmyHp(survivorArmy);
    if (survivorArmy.length === 0 || deployedHp <= 0) { cleared = false; break; }
    const defArmy = defenceMult === 1 ? d.army : scaleArmyHp(d.army, defenceMult);
    // `defenderBaseHp` is NOT optional here, for exactly the reason citySiege.ts's difference #1 spells out
    // and measured: the engine's symbolic base defaults to BASE_HP=100, which one ADR-069 siege unit
    // one-shots — the battle then ends before the defender team ever engages, so the rung is FREE regardless
    // of how strong the garrison is. Written without it first, and the "a strong defender team repels the
    // assault" case failed with the strong team beaten by a token attacker: 480 HP through 4,800.
    // ADR-077: the garrison's own progression fortifies the position it holds. `cityDefenderBaseHp`
    // returns exactly `cityWaveBaseHp(level)` for an unfortified team, so an ungeared level-1 garrison
    // reproduces the pre-P4 battle to the unit. Applied here, BEFORE `lastReplay` is written a few lines
    // down, which is what makes the feature replay-safe with no engine change and no payload field: the
    // fortified figure is literally what a client reconstructs the battle from.
    const defenderConfig = { garrison: defArmy, defenderBaseLevel: 0, defenderBaseHp: cityDefenderBaseHp(city.level, d.fortify) };
    // Seeds continue the SAME sequence the NPC ladder uses (`waveSeed(marchId, index)`), offset by however
    // many defender rungs came first — so no two rungs of one assault can share a seed, and the whole
    // ladder still reconstructs from the march id.
    const seed = waveSeed(m._id, i);
    lastReplay = {
      seed, attackerArmy: survivorArmy, defenderConfig, tileLevel: city.level,
      ...(cardInstances ? { cardInstances } : {}),
      ...(cardEquipInv ? { equipmentInv: cardEquipInv } : {}),
    };
    let res: SiegeResolution;
    // Defender teams are real level-schema-validated formations, never synthesized — so only the attacker
    // side can be over board capacity (same asymmetry applyBaseSiege documents).
    if (shouldUseCheapSiege({ attackerTroops: deployedHp, defenderTroops: sumArmyHp(defArmy), attackerSynthesized, defenderSynthesized: false })) {
      res = resolveSiege(deployedHp, sumArmyHp(defArmy));
    } else {
      try {
        res = await runSiegeBattle({ attackerArmy: survivorArmy, defenderConfig, tileLevel: city.level, seed, cardInstances, equipmentInv: cardEquipInv });
      } catch (err) {
        console.error('[worldsvc] city defender siege engine failed — cheap fallback', { city: city._id, rung: i, err: (err as Error).message });
        res = resolveSiege(deployedHp, sumArmyHp(defArmy));
      }
    }
    const waveDeployed = res.attackerDeployed > 0 ? res.attackerDeployed : deployedHp;
    const ratio = waveDeployed > 0 ? Math.min(1, res.attackerSurvivors / waveDeployed) : 0;
    cumSurvivalRatio *= ratio;
    if (res.outcome !== 'attacker_win') { cleared = false; break; }   // repelled by this team
    teamsCleared++;
    defeated.push(d);
    survivorArmy = scaleArmyByRatio(survivorArmy, ratio);
    if (survivorArmy.length === 0) { cleared = false; break; }        // spent: beat some teams, cannot continue
  }

  // Defender bookkeeping. Only DEFEATED teams are injured — a team that repelled the assault is still fit,
  // exactly as in a base siege. Losses are written per owner because a city's defenders belong to different
  // accounts (unlike a base's, which are all the defender's own): one document update each, not one shared.
  for (const d of defeated) {
    const updates: Record<string, unknown> = { [`teamState.${d.stationed.teamId}.injuredUntil`]: t + SLG_TEAM_INJURY_MS };
    await cols.playerWorld.updateOne({ _id: d.owner._id }, { $set: updates, $inc: { rev: 1 } });
    // A beaten defender team also loses its troops. `computeCardStateUpdates(..., survivors = 0, ...)` is the
    // same call the attacker path makes; writing nothing here would leave a wiped-out garrison at full
    // strength the moment its injury healed.
    const pipeline = cardStateDeltaPipeline(
      computeCardStateUpdates(d.stationed.army, d.owner.cardState ?? {}, 0, t, sumArmyHp(d.army)),
    );
    if (pipeline.length > 0) await cols.playerWorld.updateOne({ _id: d.owner._id }, pipeline);
  }

  return { cleared, teamsCleared, survivorArmy, cumSurvivalRatio, replay: lastReplay, hadDefenders: true };
}
