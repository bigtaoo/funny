// Unit tests (hand-built fake WorldCore + fake SiegeCtx, no Mongo — same style as
// combatSiege-arrival-variants-gaps.test.ts / occupation-battle.test.ts) targeting the branch-coverage
// gaps in the two wild-city arrival modules: combatSiege/arrival/citySiege.ts (the NPC wave ladder +
// delayed durability hit) and combatSiege/arrival/cityDefenders.ts (ADR-074 P3's owner-stationed
// garrison rungs, fought ahead of that ladder). Both are plain free functions over `core`/`ctx`, so
// every dependency here is stubbed directly — no Mongo, no engine worker pool.
//
// Battle outcomes are steered deterministically onto the CHEAP linear formula (@nw/shared resolveSiege)
// by exploiting shouldUseCheapSiege's board-overflow guard: a city level whose `cityWaveGarrison`
// exceeds SIEGE_SYNTH_ARMY_MAX_TROOPS (9,600) routes every NPC wave to resolveSiege regardless of the
// attacker, and a SYNTHESIZED attacker above the same ceiling does the same for a defender rung — the
// technique occupation-battle.test.ts / combatSiege-arrival-variants-gaps.test.ts already use. That
// makes both a win and a loss reachable without ever running the real engine, which the cheap ratio
// rule alone cannot do (`attacker >= defender * SIEGE_CHEAP_RATIO` is by construction a win).
//
// `runSiegeBattle` is vi.mock-ed (file-scoped, the same partial-mock shape siege-crash-replay.e2e.test.ts
// and field-encounter-card-zero.e2e.test.ts use) and defaults to throwing "unexpected engine call": every
// other siegeEngine export passes through unmocked. Only the four tests that are ABOUT the engine path —
// the crash fallback and the ADR-069 "engine reported no deployment" denominator fallback — give it an
// implementation; the cheap-path tests assert it was never called.
//
// No @nw/shared pure function is mocked: expected damage/survivor/fortify figures are recomputed here
// with the real cityWaveGarrison / resolveSiege / teamSiegeValue / cityDefenderBaseHp / computeCardStateUpdates,
// so these assertions follow a constant change instead of pinning a stale literal.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/siegeEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/siegeEngine')>();
  return {
    ...actual,
    runSiegeBattle: vi.fn(async () => {
      throw new Error('unexpected engine call');
    }),
  };
});

import {
  MARCH_MORALE_MAX,
  NATION_BONUS_DEFENSE,
  SLG_SIEGE_DAMAGE_DELAY_MS,
  SLG_TEAM_INJURY_MS,
  cityDefenderBaseHp,
  cityDefenderFortifyMult,
  cityDefenderTeamFortify,
  cityWaveBaseHp,
  cityWaveCount,
  cityWaveGarrison,
  playerWorldId,
  resolveSiege,
  teamSiegeValue,
  waveSeed,
  type CityKind,
  type SiegeResolution,
} from '@nw/shared';
import { garrisonProgressionRatios } from '@nw/engine';
import type { EngineCardInstance, EngineEquipInv, GarrisonEntry, UnitType } from '@nw/engine';
import {
  resolveCardArmy,
  runSiegeBattle,
  scaleArmyByRatio,
  scaleArmyHp,
  sumArmyHp,
  synthesizeArmy,
  toDefenderFormation,
  toEngineCardInstances,
} from '../src/siegeEngine';
import { cardStateDeltaPipeline, computeCardStateUpdates } from '../src/cardStateSettlement';
import { applyCitySiege } from '../src/combatSiege/arrival/citySiege';
import { fightCityDefenders } from '../src/combatSiege/arrival/cityDefenders';
import { emptyResources } from '../src/core';
import type { WorldCore } from '../src/core';
import type { CityState } from '../src/core/citySiege';
import type { SiegeCtx } from '../src/combatSiege/ctx';
import type { ArmyEntry, MarchDoc, PlayerWorldDoc, SiegeDamageDoc, StationedDoc } from '../src/db';
import type { SiegeReplayInputs } from '../src/worldTypes';

const W = 's1';
const ATK = 'atk-1';
const DEF1 = 'def-1';
const DEF2 = 'def-2';
const SECT = 'sect-a';
const OTHER_SECT = 'sect-b';
const TILE = `${W}:5:5`;
const NOW = 1_700_000_000_000;
const CARD_DEF_ID = 'lichuang'; // a real @nw/shared CARD_DEFS entry (unitType: infantry)

/**
 * A city level whose per-wave NPC garrison is above SIEGE_SYNTH_ARMY_MAX_TROOPS (9,600), so
 * `shouldUseCheapSiege`'s defender-overflow guard routes EVERY wave of the ladder to resolveSiege —
 * win or lose, card army or flat. Asserted below so a re-tuned CITY_WAVE_GARRISON_PER_LEVEL fails
 * loudly here instead of silently sending these tests through the real engine.
 */
const CHEAP_LEVEL = 50;
/** A city level small enough that a modest attacker reaches the real engine path instead. */
const ENGINE_LEVEL = 1;
/** Sect siege-value bonus (§8.3) the fake `core.sectPayoff` reports. */
const SECT_SIEGE_BONUS = 0.05;

function cardInv(ids: string[], level = 1) {
  return Object.fromEntries(ids.map((id) => [id, { id, defId: CARD_DEF_ID, level, gear: {}, locked: false }]));
}

function cardArmy(ids: string[]): ArmyEntry[] {
  return ids.map((cardInstanceId, i) => ({ cardInstanceId, col: i, row: 0 })) as unknown as ArmyEntry[];
}

function march(overrides: Partial<MarchDoc> = {}): MarchDoc {
  return {
    _id: 'm1', worldId: W, ownerId: ATK, fromTile: `${W}:0:0`, toTile: TILE,
    kind: 'attack', troops: 100, morale: MARCH_MORALE_MAX, departAt: 0, arriveAt: NOW,
    path: [], stepIndex: 0, nextStepAt: 0, status: 'marching', rev: 0,
    ...overrides,
  } as unknown as MarchDoc;
}

function pw(overrides: Partial<PlayerWorldDoc> = {}): PlayerWorldDoc {
  const accountId = overrides.accountId ?? ATK;
  return {
    _id: playerWorldId(W, accountId), worldId: W, accountId,
    troops: 0, troopCap: 999_999, resources: emptyResources(), yieldRate: emptyResources(),
    lastTickAt: 0, rev: 0, sectId: SECT,
    ...overrides,
  } as unknown as PlayerWorldDoc;
}

function city(overrides: Partial<CityState> = {}): CityState {
  return {
    _id: `city:${W}:garrison-1`, worldId: W, nodeId: 'garrison-1', kind: 'garrison' as CityKind,
    x: 5, y: 5, level: CHEAP_LEVEL, footprint: 3,
    durability: 5_000, durabilityMax: 5_000, durabilityRegenAt: 0, regenPerHour: 0, liveDurability: 5_000,
    rev: 0,
    ...overrides,
  } as unknown as CityState;
}

function stationed(overrides: Partial<StationedDoc> = {}): StationedDoc {
  return {
    _id: TILE, worldId: W, ownerId: DEF1, tile: TILE, x: 5, y: 5,
    teamId: 't1', army: cardArmy(['d1-card']), troops: 0, sinceAt: 0, mode: 'garrison',
    ...overrides,
  } as unknown as StationedDoc;
}

interface SaveFields { cardInv?: Record<string, unknown>; equipmentInv?: Record<string, unknown> }

function fakeCtx() {
  return {
    recordSiege: vi.fn(async (..._args: unknown[]) => ({ _id: 'siege-1' })),
    transferLoot: vi.fn(async (..._args: unknown[]) => emptyResources()),
    applySectLeaderPenalty: vi.fn(async (..._args: unknown[]) => {}),
    passiveRelocate: vi.fn(async (..._args: unknown[]) => {}),
    writeContestedHold: vi.fn(async (..._args: unknown[]) => {}),
    startOccupationHold: vi.fn(async (..._args: unknown[]) => {}),
  } as unknown as SiegeCtx & { recordSiege: ReturnType<typeof vi.fn> };
}

/**
 * Fake WorldCore covering exactly what citySiege.ts + cityDefenders.ts touch: the stationed/playerWorld/
 * siegeDamage collections, `meta.getSaveFields`, `sectPayoff`, and the push/bump fire-and-forget helpers.
 * `saves` is keyed by accountId; an entry may be an Error to make that account's `getSaveFields` reject
 * (both modules wrap the call in `.catch(() => null)`).
 */
function makeCore(opts: {
  stationedDocs?: StationedDoc[];
  owners?: PlayerWorldDoc[];
  pwById?: Record<string, PlayerWorldDoc>;
  saves?: Record<string, SaveFields | Error | null>;
  sectSiegeBonus?: number;
} = {}) {
  const stationedDocs = opts.stationedDocs ?? [];
  const owners = opts.owners ?? [];
  const pwById = opts.pwById ?? {};
  const saves = opts.saves ?? {};

  const stationedFind = vi.fn((_q: unknown) => ({ toArray: async () => stationedDocs.map((d) => ({ ...d })) }));
  const stationedUpdateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
  const pwUpdateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
  const siegeDamageUpdateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
  const pushMarch = vi.fn(async (..._args: unknown[]) => {});
  const pushSiege = vi.fn(async (..._args: unknown[]) => {});
  const bumpFamilyActivity = vi.fn(async (..._args: unknown[]) => {});
  const setOccupancy = vi.fn(async (..._args: unknown[]) => {});
  const getSaveFields = vi.fn(async (accountId: string) => {
    const s = saves[accountId];
    if (s instanceof Error) throw s;
    return s ?? null;
  });
  const sectPayoff = vi.fn(async (..._args: unknown[]) => ({
    yield: emptyResources(), siegeBonus: opts.sectSiegeBonus ?? SECT_SIEGE_BONUS, marchMult: 1,
  }));

  const core = {
    deps: {
      now: () => NOW,
      cols: {
        stationed: { find: stationedFind, updateOne: stationedUpdateOne },
        playerWorld: {
          find: vi.fn((_q: unknown) => ({ toArray: async () => owners.map((o) => ({ ...o })) })),
          findOne: async ({ _id }: { _id: string }) => pwById[_id] ?? null,
          updateOne: pwUpdateOne,
        },
        siegeDamage: { updateOne: siegeDamageUpdateOne },
        marches: { insertOne: vi.fn(async (..._args: unknown[]) => ({})) },
      },
    },
    coordX: (tid: string) => Number(tid.split(':')[1]),
    coordY: (tid: string) => Number(tid.split(':')[2]),
    settle: (doc: PlayerWorldDoc) => ({ ...doc.resources }),
    marchSeq: 0,
    marchView: (m: MarchDoc) => m as unknown as never,
    meta: { getSaveFields },
    sectPayoff,
    pushMarch,
    pushSiege,
    setOccupancy,
    bumpFamilyActivity,
  } as unknown as WorldCore;

  return {
    core, stationedFind, stationedUpdateOne, pwUpdateOne, siegeDamageUpdateOne,
    pushMarch, pushSiege, bumpFamilyActivity, setOccupancy, getSaveFields, sectPayoff,
  };
}

/** The `SiegeDamageDoc` the win path upserts (`updateOne(filter, { $setOnInsert: doc }, …)`). */
function damageDoc(call: unknown[]): SiegeDamageDoc {
  return (call[1] as { $setOnInsert: SiegeDamageDoc }).$setOnInsert;
}

/** The pipeline-shaped (array) `playerWorld.updateOne` calls — the cardState delta writes. */
function pipelineCalls(mock: ReturnType<typeof vi.fn>): unknown[][] {
  return mock.mock.calls.filter((c) => Array.isArray(c[1])) as unknown[][];
}

/** The `$set`-shaped `playerWorld.updateOne` calls — the defender injury writes. */
function setCalls(mock: ReturnType<typeof vi.fn>): unknown[][] {
  return mock.mock.calls.filter((c) => !Array.isArray(c[1])) as unknown[][];
}

beforeEach(() => {
  vi.mocked(runSiegeBattle).mockReset();
  vi.mocked(runSiegeBattle).mockImplementation(async () => {
    throw new Error('unexpected engine call');
  });
});

describe('cheap-path preconditions', () => {
  it('CHEAP_LEVEL really does overflow the synthesized-board ceiling every wave', () => {
    // If CITY_WAVE_GARRISON_PER_LEVEL is re-tuned below this, every "cheap" test in this file would
    // silently start routing through the mocked engine instead. Fail here rather than there.
    expect(cityWaveGarrison(CHEAP_LEVEL)).toBeGreaterThan(9_600);
    expect(cityWaveGarrison(ENGINE_LEVEL)).toBeLessThan(9_600);
    expect(cityWaveCount(CHEAP_LEVEL)).toBe(3); // the three-rung chains asserted below assume the ladder's height
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// citySiege.ts — arrival re-validation ("miss") paths
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('applyCitySiege — stale-target misses', () => {
  it('besieger left its sect in transit → team march parks in place, nothing is besieged', async () => {
    const { core, stationedUpdateOne, setOccupancy, siegeDamageUpdateOne, pushMarch } = makeCore();
    const ctx = fakeCtx();
    // `m.army` absent entirely — the `m.army ?? []` fallback, i.e. a legacy flat-troop march.
    const m = march({ teamId: 't1', troops: 400, army: undefined });
    await applyCitySiege(core, ctx, m, pw({ sectId: undefined }), city(), NOW);

    expect(ctx.recordSiege).not.toHaveBeenCalled();
    expect(siegeDamageUpdateOne).not.toHaveBeenCalled();
    expect(stationedUpdateOne).toHaveBeenCalledTimes(1);
    // The team is parked with its FULL troop count: a miss costs nothing, unlike a repel.
    expect((stationedUpdateOne.mock.calls[0]![1] as { $set: StationedDoc }).$set.troops).toBe(400);
    expect(setOccupancy).toHaveBeenCalledTimes(1);
    expect((pushMarch.mock.calls[0]![1] as MarchDoc).status).toBe('arrived');
  });

  it("own sect took the city mid-flight → miss, and a CARD march is not handed flat troops back", async () => {
    const { core, pwUpdateOne, pushMarch, siegeDamageUpdateOne, stationedUpdateOne } = makeCore();
    const ctx = fakeCtx();
    const m = march({ army: cardArmy(['c1']) }); // no teamId → the recall branch, not the park branch
    await applyCitySiege(core, ctx, m, pw(), city({ ownerSectId: SECT }), NOW);

    expect(ctx.recordSiege).not.toHaveBeenCalled();
    expect(siegeDamageUpdateOne).not.toHaveBeenCalled();
    expect(stationedUpdateOne).not.toHaveBeenCalled();
    // A card army's troops live in cardState, so refundTroops must NOT run — that would mint troops.
    expect(pwUpdateOne).not.toHaveBeenCalled();
    expect((pushMarch.mock.calls[0]![1] as MarchDoc).status).toBe('recalled');
  });

  it('post-capture protection window → miss, and a FLAT march does get its troops back', async () => {
    const attacker = pw({ troops: 25 });
    const { core, pwUpdateOne } = makeCore();
    const ctx = fakeCtx();
    const m = march({ troops: 400, army: [] });
    await applyCitySiege(core, ctx, m, attacker, city({ protectedUntil: NOW + 1 }), NOW);

    expect(ctx.recordSiege).not.toHaveBeenCalled();
    expect(pwUpdateOne).toHaveBeenCalledTimes(1);
    const set = (pwUpdateOne.mock.calls[0]![1] as { $set: { troops: number } }).$set;
    expect(set.troops).toBe(25 + 400); // the whole march came home
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// citySiege.ts — the NPC wave ladder on the cheap path
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('applyCitySiege — NPC wave ladder', () => {
  it('a flat march that clears the ladder schedules exactly one delayed durability hit', async () => {
    const TROOPS = 60_000;
    const attacker = pw({ familyId: 'fam-1' });
    const { core, siegeDamageUpdateOne, bumpFamilyActivity, pushSiege } = makeCore();
    const ctx = fakeCtx();
    const m = march({ troops: TROOPS });
    await applyCitySiege(core, ctx, m, attacker, city(), NOW);

    expect(runSiegeBattle).not.toHaveBeenCalled(); // the whole ladder stayed on the cheap formula
    expect(ctx.recordSiege).toHaveBeenCalledTimes(1);
    expect(ctx.recordSiege.mock.calls[0]![2]).toBe('attacker_win');
    expect(ctx.recordSiege.mock.calls[0]![1]).toBeUndefined(); // a city has no single defender account

    // Three explicit rungs of the real arithmetic, not a re-implemented loop: each wave's survivors
    // scaled back into the army that fights the next one (ADR-069 honest survival ratio).
    const g = cityWaveGarrison(CHEAP_LEVEL);
    const a1 = synthesizeArmy(TROOPS, 'attacker');
    const w1 = resolveSiege(sumArmyHp(a1), g);
    const a2 = scaleArmyByRatio(a1, w1.attackerSurvivors / sumArmyHp(a1));
    const w2 = resolveSiege(sumArmyHp(a2), g);
    const a3 = scaleArmyByRatio(a2, w2.attackerSurvivors / sumArmyHp(a2));
    const w3 = resolveSiege(sumArmyHp(a3), g);
    expect(w3.outcome).toBe('attacker_win');

    expect(siegeDamageUpdateOne).toHaveBeenCalledTimes(1);
    const dmg = damageDoc(siegeDamageUpdateOne.mock.calls[0]!);
    expect(dmg._id).toBe('siege-1');
    expect(dmg.cityId).toBe(city()._id);
    expect(dmg.isBase).toBe(false);
    expect(dmg.attackerSectId).toBe(SECT);
    expect(dmg.familyId).toBe('fam-1');
    expect(dmg.dueAt).toBe(NOW + SLG_SIEGE_DAMAGE_DELAY_MS);
    expect(dmg.attackerSurvivors).toBe(w3.attackerSurvivors);
    // A flat (card-less) march carries no siege value at all, so clearing the ladder chips NOTHING
    // off the wall — the durability hit is the TEAM's siege value, and a flat army has none.
    expect(dmg.damage).toBe(0);
    expect(bumpFamilyActivity).toHaveBeenCalledWith(W, 'fam-1', 1);
    expect(pushSiege).toHaveBeenCalledTimes(1);
  });

  it('a card march that clears the ladder chips teamSiegeValue × (1 + sect bonus) and writes one honest survival fraction', async () => {
    const TROOPS = 60_000;
    const inv = cardInv(['c1']);
    const equipmentInv = {};
    const attacker = pw({ cardState: { c1: { currentTroops: TROOPS } } as never });
    const { core, siegeDamageUpdateOne, pwUpdateOne, sectPayoff } = makeCore({
      saves: { [ATK]: { cardInv: inv, equipmentInv } },
    });
    const ctx = fakeCtx();
    const army = cardArmy(['c1']);
    await applyCitySiege(core, ctx, march({ army }), attacker, city(), NOW);

    expect(runSiegeBattle).not.toHaveBeenCalled();
    expect(sectPayoff).toHaveBeenCalledWith(SECT);
    const dmg = damageDoc(siegeDamageUpdateOne.mock.calls[0]!);
    const expectedDamage = Math.floor(teamSiegeValue(army, inv as never, equipmentInv as never) * (1 + SECT_SIEGE_BONUS));
    expect(expectedDamage).toBeGreaterThan(0); // a real card team does chip the wall, unlike the flat march above
    expect(dmg.damage).toBe(expectedDamage);
    expect(dmg.familyId).toBeUndefined(); // no family on this attacker → the key is omitted, not written null

    // One survival fraction over the WHOLE ladder (ADR-069): the three rungs' ratios multiplied, not
    // the last one alone.
    const g = cityWaveGarrison(CHEAP_LEVEL);
    const a1: GarrisonEntry[] = resolveCardArmy(army, attacker.cardState ?? {}, inv as never);
    const w1 = resolveSiege(sumArmyHp(a1), g);
    const a2 = scaleArmyByRatio(a1, w1.attackerSurvivors / sumArmyHp(a1));
    const w2 = resolveSiege(sumArmyHp(a2), g);
    const a3 = scaleArmyByRatio(a2, w2.attackerSurvivors / sumArmyHp(a2));
    const w3 = resolveSiege(sumArmyHp(a3), g);
    const cum = (w1.attackerSurvivors / sumArmyHp(a1)) * (w2.attackerSurvivors / sumArmyHp(a2)) * (w3.attackerSurvivors / sumArmyHp(a3));
    const writes = pipelineCalls(pwUpdateOne);
    expect(writes).toHaveLength(1);
    expect(writes[0]![1]).toEqual(cardStateDeltaPipeline(
      computeCardStateUpdates(army, attacker.cardState ?? {}, Math.round(TROOPS * cum), NOW, TROOPS),
    ));
    expect(dmg.attackerSurvivors).toBe(w3.attackerSurvivors);
  });

  it('a card army spent to its last hit point wins the wave but cannot field a second one', async () => {
    // Both cards scale below 1 HP at the survival ratio, so `scaleArmyByRatio` returns an empty army:
    // the ladder stops with waves cleared but the assault spent (citySiege.ts "spent" break).
    const g = cityWaveGarrison(CHEAP_LEVEL);
    const inv = cardInv(['c1', 'c2']);
    const attacker = pw({ cardState: { c1: { currentTroops: g - 11 }, c2: { currentTroops: 12 } } as never });
    const { core, siegeDamageUpdateOne, pwUpdateOne } = makeCore({ saves: { [ATK]: { cardInv: inv } } });
    const ctx = fakeCtx();
    const army = cardArmy(['c1', 'c2']);
    await applyCitySiege(core, ctx, march({ army }), attacker, city(), NOW);

    const resolved = resolveCardArmy(army, attacker.cardState ?? {}, inv as never);
    const w1 = resolveSiege(sumArmyHp(resolved), g);
    expect(w1.outcome).toBe('attacker_win');                                  // it DID win the first wave…
    expect(scaleArmyByRatio(resolved, w1.attackerSurvivors / sumArmyHp(resolved))).toHaveLength(0); // …with nothing left
    expect(ctx.recordSiege.mock.calls[0]![2]).toBe('defender_win');           // an unfinished ladder is a loss
    expect(ctx.recordSiege.mock.calls[0]![4]).not.toBeNull();                 // the fought wave's replay is kept
    expect(siegeDamageUpdateOne).not.toHaveBeenCalled();                      // and no durability is scheduled
    expect(pipelineCalls(pwUpdateOne)).toHaveLength(1);                       // the losses are still written
  });

  it('a card march whose save cannot be read fields nothing, is repelled, and walks home with troops:0', async () => {
    // getSaveFields rejecting leaves attackerSave null → resolveCardArmy over an empty cardInv → an empty
    // attacker army → the ladder breaks before its first battle. `pw.cardState` is absent here too, so the
    // whole `pw.cardState ?? {} / attackerSave?.cardInv ?? {}` fallback chain is exercised at once.
    const attacker = pw({ troops: 7 }); // no mainBaseTile → startReturnMarch degrades to a refund
    const { core, pwUpdateOne, siegeDamageUpdateOne } = makeCore({
      saves: { [ATK]: new Error('metaserver down') },
      pwById: { [playerWorldId(W, ATK)]: attacker },
    });
    const ctx = fakeCtx();
    const m = march({ army: cardArmy(['c1']), morale: undefined }); // morale absent → MARCH_MORALE_MAX
    await applyCitySiege(core, ctx, m, attacker, city(), NOW);

    expect(runSiegeBattle).not.toHaveBeenCalled();     // no army, so not a single battle was attempted
    expect(ctx.recordSiege.mock.calls[0]![2]).toBe('defender_win');
    expect(ctx.recordSiege.mock.calls[0]![4]).toBeNull(); // no wave fought → no replay inputs at all
    expect(siegeDamageUpdateOne).not.toHaveBeenCalled();
    // The return leg carries troops:0 for a card army (its survivors live in cardState), so the refund
    // fallback adds nothing to the owner's pool.
    const set = (setCalls(pwUpdateOne)[0]![1] as { $set: { troops: number } }).$set;
    expect(set.troops).toBe(7);
  });

  it('a save with no cardInv is the same as no save: the march fields nothing and is repelled', async () => {
    const attacker = pw({ cardState: { c1: { currentTroops: 5_000 } } as never });
    const { core, siegeDamageUpdateOne } = makeCore({
      saves: { [ATK]: {} }, // present but empty — the `?? {}` fallbacks on both cardInv and equipmentInv
      pwById: { [playerWorldId(W, ATK)]: attacker },
    });
    const ctx = fakeCtx();
    await applyCitySiege(core, ctx, march({ army: cardArmy(['c1']) }), attacker, city(), NOW);

    expect(ctx.recordSiege.mock.calls[0]![2]).toBe('defender_win');
    expect(siegeDamageUpdateOne).not.toHaveBeenCalled();
  });

  it('an explicit non-card army fights as itself (never synthesized) and still chips nothing', async () => {
    // `!hasCardArmy && rawArmy.length > 0`: the legacy explicit-layout march. It is NOT treated as
    // synthesized (its layout is real), and teamSiegeValue over card-less entries is 0.
    const legacy = [{ unitType: 'infantry', col: 0, row: 1, initialHp: 60_000 }] as unknown as ArmyEntry[];
    const { core, siegeDamageUpdateOne, pwUpdateOne } = makeCore();
    const ctx = fakeCtx();
    await applyCitySiege(core, ctx, march({ army: legacy }), pw(), city(), NOW);

    expect(runSiegeBattle).not.toHaveBeenCalled();
    expect(ctx.recordSiege.mock.calls[0]![2]).toBe('attacker_win');
    expect(damageDoc(siegeDamageUpdateOne.mock.calls[0]!).damage).toBe(0);
    expect(pipelineCalls(pwUpdateOne)).toHaveLength(0); // nothing card-shaped to settle
  });

  it('repelled by a garrison team → the NPC ladder is never reached and nothing is scheduled', async () => {
    // ADR-074 P3: the owning sect's defender rungs run AHEAD of the untouched NPC ladder. A team that
    // repels the assault ends it there — the wave ladder is not fought, so no durability can be chipped.
    const d = defenderTeam(DEF1, 'd1-card', BIG + 5_000);
    const held = city({ ownerSectId: OTHER_SECT });
    const owner = pw({ accountId: DEF1, sectId: OTHER_SECT, cardState: d.owner.cardState });
    const attacker = pw({ troops: 0 });
    const { core, siegeDamageUpdateOne, pwUpdateOne } = makeCore({
      stationedDocs: [d.st], owners: [owner], saves: { [DEF1]: d.save },
      pwById: { [playerWorldId(W, ATK)]: attacker },
    });
    const ctx = fakeCtx();
    await applyCitySiege(core, ctx, march({ troops: BIG }), attacker, held, NOW);

    expect(runSiegeBattle).not.toHaveBeenCalled();
    expect(ctx.recordSiege.mock.calls[0]![2]).toBe('defender_win');
    // The replay handed to the client is the defender rung's, since no NPC wave produced one.
    expect((ctx.recordSiege.mock.calls[0]![4] as SiegeReplayInputs).seed).toBe(waveSeed('m1', 0));
    expect(siegeDamageUpdateOne).not.toHaveBeenCalled();
    expect(pwUpdateOne).not.toHaveBeenCalled(); // the defender held, so it is not injured either
  });

  it('a flat march repelled with no survivors sends nothing home at all', async () => {
    const attacker = pw({ troops: 3 });
    const { core, pwUpdateOne, siegeDamageUpdateOne } = makeCore({ pwById: { [playerWorldId(W, ATK)]: attacker } });
    const ctx = fakeCtx();
    await applyCitySiege(core, ctx, march({ troops: 500 }), attacker, city(), NOW);

    // resolveSiege gives the losing side zero survivors, and a flat army has no cardState to settle:
    // `hasCardArmy || survivors > 0` is false on both counts, so no return leg is started.
    expect(ctx.recordSiege.mock.calls[0]![2]).toBe('defender_win');
    expect(siegeDamageUpdateOne).not.toHaveBeenCalled();
    expect(pwUpdateOne).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// citySiege.ts — the engine path (mocked worker dispatch)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('applyCitySiege — engine path', () => {
  it('an engine crash falls back to the cheap formula per wave and still records the pre-crash replay inputs', async () => {
    // SLG_DESIGN_LOG §45: "崩溃也全部存" — the inputs that crashed the engine must survive on the SiegeDoc.
    vi.mocked(runSiegeBattle).mockImplementation(async () => {
      throw new Error('forced engine crash');
    });
    const TROOPS = 500;
    const inv = cardInv(['c1']);
    const attacker = pw({ cardState: { c1: { currentTroops: TROOPS } } as never });
    const { core, siegeDamageUpdateOne } = makeCore({
      saves: { [ATK]: { cardInv: inv, equipmentInv: {} } },
      pwById: { [playerWorldId(W, ATK)]: attacker },
    });
    const ctx = fakeCtx();
    const m = march({ army: cardArmy(['c1']) });
    await applyCitySiege(core, ctx, m, attacker, city({ level: ENGINE_LEVEL }), NOW);

    const g = cityWaveGarrison(ENGINE_LEVEL);
    const a1 = resolveCardArmy(m.army!, attacker.cardState ?? {}, inv as never);
    const w1 = resolveSiege(sumArmyHp(a1), g);
    const a2 = scaleArmyByRatio(a1, w1.attackerSurvivors / sumArmyHp(a1));
    const w2 = resolveSiege(sumArmyHp(a2), g);
    const a3 = scaleArmyByRatio(a2, w2.attackerSurvivors / sumArmyHp(a2));
    const w3 = resolveSiege(sumArmyHp(a3), g);
    expect(w1.outcome).toBe('attacker_win');
    expect(w2.outcome).toBe('attacker_win');
    expect(w3.outcome).toBe('defender_win'); // the cheap fallback loses the third wave

    expect(runSiegeBattle).toHaveBeenCalledTimes(3); // every wave really did try the engine first
    expect(ctx.recordSiege.mock.calls[0]![2]).toBe('defender_win');
    const replay = ctx.recordSiege.mock.calls[0]![4] as SiegeReplayInputs;
    expect(replay).not.toBeNull();
    expect(replay.seed).toBe(waveSeed('m1', 2));                       // the wave that crashed last
    expect((replay.defenderConfig as { defenderBaseHp: number }).defenderBaseHp).toBe(cityWaveBaseHp(ENGINE_LEVEL));
    expect(replay.cardInstances).toHaveLength(1);                      // the card payload is carried into the replay
    expect(replay.equipmentInv).toEqual({});
    expect(siegeDamageUpdateOne).not.toHaveBeenCalled();
  });

  it('an engine result that reports no deployment falls back to the NOMINAL deployment as the survival denominator', async () => {
    // ADR-069: `attackerDeployed` is the clamped figure the engine measured. If it comes back as 0 the
    // ratio must fall back to the army we sent in — reading 0 as the denominator would report every
    // survivor as a casualty.
    const TROOPS = 500;
    const SURVIVORS = 100;
    vi.mocked(runSiegeBattle).mockImplementation(async (): Promise<SiegeResolution> => ({
      outcome: 'attacker_win', attackerSurvivors: SURVIVORS, defenderSurvivors: 0,
      attackerDeployed: 0, defenderDeployed: 0,
    }));
    const inv = cardInv(['c1']);
    const attacker = pw({ cardState: { c1: { currentTroops: TROOPS } } as never });
    const { core, pwUpdateOne, siegeDamageUpdateOne } = makeCore({
      saves: { [ATK]: { cardInv: inv, equipmentInv: {} } },
    });
    const ctx = fakeCtx();
    const army = cardArmy(['c1']);
    await applyCitySiege(core, ctx, march({ army }), attacker, city({ level: ENGINE_LEVEL }), NOW);

    expect(ctx.recordSiege.mock.calls[0]![2]).toBe('attacker_win');
    // Wave 1 kept 100/500 = 20%; waves 2 and 3 then deploy 100 and keep all 100 → 20% overall, NOT 0.
    const writes = pipelineCalls(pwUpdateOne);
    expect(writes[0]![1]).toEqual(cardStateDeltaPipeline(
      computeCardStateUpdates(army, attacker.cardState ?? {}, Math.round(TROOPS * (SURVIVORS / TROOPS)), NOW, TROOPS),
    ));
    expect(damageDoc(siegeDamageUpdateOne.mock.calls[0]!).attackerSurvivors).toBe(SURVIVORS);
  });

  it('a flat march repelled with real engine survivors walks them home', async () => {
    const SURVIVORS = 137;
    vi.mocked(runSiegeBattle).mockImplementation(async (): Promise<SiegeResolution> => ({
      outcome: 'defender_win', attackerSurvivors: SURVIVORS, defenderSurvivors: 40,
      attackerDeployed: 500, defenderDeployed: 210,
    }));
    const attacker = pw({ troops: 11 });
    const { core, pwUpdateOne } = makeCore({ pwById: { [playerWorldId(W, ATK)]: attacker } });
    const ctx = fakeCtx();
    await applyCitySiege(core, ctx, march({ troops: 500 }), attacker, city({ level: ENGINE_LEVEL }), NOW);

    expect(runSiegeBattle).toHaveBeenCalledTimes(1); // repelled on the first wave
    expect(ctx.recordSiege.mock.calls[0]![2]).toBe('defender_win');
    // No mainBaseTile → the return leg degrades to a refund, which is where the survivor count shows up.
    const set = (setCalls(pwUpdateOne)[0]![1] as { $set: { troops: number } }).$set;
    expect(set.troops).toBe(11 + SURVIVORS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// cityDefenders.ts — eligibility
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Attacker big enough to be routed to the cheap formula by the synthesized-board ceiling alone. */
const BIG = 20_000;
const bigArmy = () => synthesizeArmy(BIG, 'attacker');

async function fight(core: WorldCore, opts: {
  attackerArmy?: GarrisonEntry[];
  city?: CityState;
  cardInstances?: EngineCardInstance[];
  cardEquipInv?: EngineEquipInv;
  attackerSynthesized?: boolean;
} = {}) {
  const army = opts.attackerArmy ?? bigArmy();
  return fightCityDefenders(
    core, march(), opts.city ?? city({ ownerSectId: SECT, level: 3 }), army, sumArmyHp(army),
    opts.attackerSynthesized ?? true, opts.cardInstances, opts.cardEquipInv, NOW,
  );
}

describe('fightCityDefenders — eligibility', () => {
  it('an NPC-held city is never even queried — the pre-P3 path, untouched attacker', async () => {
    const { core, stationedFind } = makeCore();
    const army = bigArmy();
    const res = await fight(core, { city: city({ ownerSectId: undefined }), attackerArmy: army });
    expect(stationedFind).not.toHaveBeenCalled();
    expect(res).toEqual({ cleared: true, teamsCleared: 0, survivorArmy: army, cumSurvivalRatio: 1, replay: null, hadDefenders: false });
  });

  it('a held city with nothing parked in its footprint behaves exactly like an NPC-held one', async () => {
    const { core, stationedFind, pwUpdateOne } = makeCore({ stationedDocs: [] });
    const res = await fight(core);
    expect(stationedFind).toHaveBeenCalledTimes(1);
    expect(res.hadDefenders).toBe(false);
    expect(res.cleared).toBe(true);
    expect(pwUpdateOne).not.toHaveBeenCalled();
  });

  it('a parked team whose owner document is gone does not defend', async () => {
    const { core, pwUpdateOne, getSaveFields } = makeCore({ stationedDocs: [stationed()], owners: [] });
    const res = await fight(core);
    expect(res).toMatchObject({ cleared: true, teamsCleared: 0, hadDefenders: false });
    expect(getSaveFields).not.toHaveBeenCalled(); // skipped before the save round trip
    expect(pwUpdateOne).not.toHaveBeenCalled();
  });

  it('a team whose owner left the sect that holds the city does not defend it', async () => {
    const owner = pw({ accountId: DEF1, sectId: OTHER_SECT, cardState: { 'd1-card': { currentTroops: 5_000 } } as never });
    const { core } = makeCore({ stationedDocs: [stationed()], owners: [owner], saves: { [DEF1]: { cardInv: cardInv(['d1-card']) } } });
    expect(await fight(core)).toMatchObject({ teamsCleared: 0, hadDefenders: false });
  });

  it('an injured team is still healing and does not defend', async () => {
    const owner = pw({
      accountId: DEF1,
      cardState: { 'd1-card': { currentTroops: 5_000 } } as never,
      teamState: { t1: { injuredUntil: NOW + 1 } } as never,
    });
    const { core } = makeCore({ stationedDocs: [stationed()], owners: [owner], saves: { [DEF1]: { cardInv: cardInv(['d1-card']) } } });
    expect(await fight(core)).toMatchObject({ teamsCleared: 0, hadDefenders: false });
  });

  it("a team whose owner's save cannot be read fields nothing and is skipped entirely", async () => {
    // resolveCardArmy needs the owner's cardInv to turn the parked ArmyEntry[] into units; a failed
    // save read leaves it empty, so the whole team drops out rather than defending at a baseline.
    const owner = pw({ accountId: DEF1, cardState: { 'd1-card': { currentTroops: 5_000 } } as never });
    const { core, getSaveFields } = makeCore({
      stationedDocs: [stationed()], owners: [owner], saves: { [DEF1]: new Error('metaserver down') },
    });
    expect(await fight(core)).toMatchObject({ teamsCleared: 0, hadDefenders: false });
    expect(getSaveFields).toHaveBeenCalledWith(DEF1);
  });

  it('a parked team with no troops left in its cards is a stale park and does not defend', async () => {
    const owner = pw({ accountId: DEF1, cardState: undefined }); // no cardState at all → every card resolves to 0
    const { core } = makeCore({
      stationedDocs: [stationed()], owners: [owner], saves: { [DEF1]: { cardInv: cardInv(['d1-card']) } },
    });
    expect(await fight(core)).toMatchObject({ teamsCleared: 0, hadDefenders: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// cityDefenders.ts — the rungs themselves
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Owner + save + expected defender formation for a one-card garrison team. */
function defenderTeam(accountId: string, cardId: string, troops: number, opts: { level?: number; teamId?: string; tile?: string } = {}) {
  const inv = cardInv([cardId], opts.level ?? 1);
  const owner = pw({ accountId, cardState: { [cardId]: { currentTroops: troops } } as never });
  const st = stationed({
    _id: opts.tile ?? TILE, tile: opts.tile ?? TILE, ownerId: accountId,
    teamId: opts.teamId ?? 't1', army: cardArmy([cardId]),
  });
  const save: SaveFields = { cardInv: inv, equipmentInv: {} };
  const resolved = resolveCardArmy(st.army, owner.cardState ?? {}, inv as never);
  const formation = toDefenderFormation(resolved);
  const { cardInstances, engEquipInv } = toEngineCardInstances(st.army, inv as never, {});
  const ratios = garrisonProgressionRatios(cardInstances, engEquipInv);
  const fortify = cityDefenderTeamFortify(resolved.map((e) => ({
    troops: e.initialHp ?? 0,
    mult: cityDefenderFortifyMult(ratios.hp[e.unitType as UnitType] ?? 1, ratios.attack[e.unitType as UnitType] ?? 1),
  })));
  return { owner, st, save, resolved, formation, fortify };
}

describe('fightCityDefenders — rungs', () => {
  it('a beaten defender team is injured, wiped, and the attacker carries its survivors on', async () => {
    const d = defenderTeam(DEF1, 'd1-card', 5_000);
    const { core, pwUpdateOne } = makeCore({ stationedDocs: [d.st], owners: [d.owner], saves: { [DEF1]: d.save } });
    const attackerArmy = bigArmy();
    const res = await fight(core, { attackerArmy });

    expect(runSiegeBattle).not.toHaveBeenCalled();
    const rung = resolveSiege(sumArmyHp(attackerArmy), sumArmyHp(d.formation));
    expect(rung.outcome).toBe('attacker_win');
    const ratio = rung.attackerSurvivors / sumArmyHp(attackerArmy);
    expect(res.cleared).toBe(true);
    expect(res.teamsCleared).toBe(1);
    expect(res.hadDefenders).toBe(true);
    expect(res.cumSurvivalRatio).toBeCloseTo(ratio, 12);
    expect(sumArmyHp(res.survivorArmy)).toBe(sumArmyHp(scaleArmyByRatio(attackerArmy, ratio)));

    // The rung is a real, replay-reconstructable battle: seed continues the march's own wave sequence
    // and the garrison is re-placed onto DEFENDER spawn rows.
    expect(res.replay!.seed).toBe(waveSeed('m1', 0));
    expect((res.replay!.defenderConfig as { garrison: GarrisonEntry[] }).garrison).toEqual(d.formation);
    // A bare level-1 garrison must leave the rung exactly where the NPC waves have it (ADR-077 continuity).
    expect(d.fortify).toBe(1);
    expect((res.replay!.defenderConfig as { defenderBaseHp: number }).defenderBaseHp).toBe(cityWaveBaseHp(3));

    // Two writes for the one beaten owner: the team's injury clock, then its cards' losses.
    const injuries = setCalls(pwUpdateOne);
    expect(injuries).toHaveLength(1);
    expect(injuries[0]![0]).toEqual({ _id: d.owner._id });
    expect(injuries[0]![1]).toEqual({ $set: { 'teamState.t1.injuredUntil': NOW + SLG_TEAM_INJURY_MS }, $inc: { rev: 1 } });
    const losses = pipelineCalls(pwUpdateOne);
    expect(losses).toHaveLength(1);
    expect(losses[0]![1]).toEqual(cardStateDeltaPipeline(
      computeCardStateUpdates(d.st.army, d.owner.cardState ?? {}, 0, NOW, sumArmyHp(d.formation)),
    ));
  });

  it("a progressed garrison fortifies the rung's base HP (ADR-077), an unprogressed one does not", async () => {
    const d = defenderTeam(DEF1, 'd1-card', 5_000, { level: 9 });
    const { core } = makeCore({ stationedDocs: [d.st], owners: [d.owner], saves: { [DEF1]: d.save } });
    const res = await fight(core);
    expect(d.fortify).toBeGreaterThan(1); // a level-9 card really does buy something
    expect((res.replay!.defenderConfig as { defenderBaseHp: number }).defenderBaseHp)
      .toBe(cityDefenderBaseHp(3, d.fortify));
    expect(cityDefenderBaseHp(3, d.fortify)).toBeGreaterThan(cityWaveBaseHp(3));
  });

  it('a save that carries no equipmentInv fortifies exactly as an empty one does', async () => {
    // `getSaveFields` with no field list returns both halves, but a save that predates gear (or one
    // whose equipment half is simply absent) must degrade to the plain gear-less baseline rather than
    // changing what the team fields.
    const d = defenderTeam(DEF1, 'd1-card', 5_000, { level: 9 });
    const { core } = makeCore({
      stationedDocs: [d.st], owners: [d.owner], saves: { [DEF1]: { cardInv: d.save.cardInv } },
    });
    const res = await fight(core);
    expect((res.replay!.defenderConfig as { defenderBaseHp: number }).defenderBaseHp)
      .toBe(cityDefenderBaseHp(3, d.fortify)); // d.fortify was derived with an EMPTY equipmentInv
    expect((res.replay!.defenderConfig as { garrison: GarrisonEntry[] }).garrison).toEqual(d.formation);
  });

  it('a defender team that repels the assault stays fit — no injury, no losses written', async () => {
    const d = defenderTeam(DEF1, 'd1-card', BIG + 5_000);
    const { core, pwUpdateOne } = makeCore({ stationedDocs: [d.st], owners: [d.owner], saves: { [DEF1]: d.save } });
    const res = await fight(core);

    expect(resolveSiege(BIG, sumArmyHp(d.formation)).outcome).toBe('defender_win');
    expect(res.cleared).toBe(false);
    expect(res.teamsCleared).toBe(0);
    expect(res.hadDefenders).toBe(true);
    expect(res.cumSurvivalRatio).toBe(0);
    expect(res.replay).not.toBeNull(); // the rung that repelled is still the replay the client gets
    expect(pwUpdateOne).not.toHaveBeenCalled();
  });

  it.each<[CityKind, boolean]>([['capital', true], ['worldCenter', true], ['garrison', false]])(
    'a %s city applies the province-defence bonus to its garrison: %s',
    async (kind, boosted) => {
      const d = defenderTeam(DEF1, 'd1-card', 5_000);
      const { core } = makeCore({ stationedDocs: [d.st], owners: [d.owner], saves: { [DEF1]: d.save } });
      const res = await fight(core, { city: city({ ownerSectId: SECT, level: 3, kind }) });
      const garrison = (res.replay!.defenderConfig as { garrison: GarrisonEntry[] }).garrison;
      const expected = boosted ? scaleArmyHp(d.formation, 1 + NATION_BONUS_DEFENSE) : d.formation;
      expect(garrison).toEqual(expected);
      expect(sumArmyHp(garrison) > sumArmyHp(d.formation)).toBe(boosted);
      // …and the stronger wall really does cost the attacker more.
      expect(res.cumSurvivalRatio).toBeCloseTo(
        resolveSiege(BIG, sumArmyHp(expected)).attackerSurvivors / BIG, 12,
      );
    },
  );

  it('teams are fought in cell-id order, and only the ones actually beaten are injured', async () => {
    // Parked out of order on purpose: the ladder must still fight `${W}:4:4` first, or its replay seeds
    // stop being reconstructable from the march id.
    const weak = defenderTeam(DEF1, 'd1-card', 5_000, { tile: `${W}:4:4` });
    const strong = defenderTeam(DEF2, 'd2-card', BIG + 5_000, { tile: `${W}:6:6`, teamId: 't2' });
    const { core, pwUpdateOne } = makeCore({
      stationedDocs: [strong.st, weak.st],
      owners: [weak.owner, strong.owner],
      saves: { [DEF1]: weak.save, [DEF2]: strong.save },
    });
    const res = await fight(core);

    const r1 = resolveSiege(BIG, sumArmyHp(weak.formation));
    const carried = sumArmyHp(scaleArmyByRatio(bigArmy(), r1.attackerSurvivors / BIG));
    const r2 = resolveSiege(carried, sumArmyHp(strong.formation));
    expect(r2.outcome).toBe('defender_win');
    expect(res.cleared).toBe(false);
    expect(res.teamsCleared).toBe(1);
    expect(res.cumSurvivalRatio).toBe(0); // the second rung wiped the attacker, so the product collapses
    expect(res.replay!.seed).toBe(waveSeed('m1', 1)); // second rung → second seed of the same sequence

    const injuries = setCalls(pwUpdateOne);
    expect(injuries).toHaveLength(1);
    expect(injuries[0]![0]).toEqual({ _id: weak.owner._id }); // DEF2 repelled the assault and is untouched
  });

  it('an attacker that arrives with nothing loses the ladder without a single battle', async () => {
    const d = defenderTeam(DEF1, 'd1-card', 5_000);
    const { core, pwUpdateOne } = makeCore({ stationedDocs: [d.st], owners: [d.owner], saves: { [DEF1]: d.save } });
    const res = await fightCityDefenders(
      core, march(), city({ ownerSectId: SECT, level: 3 }), [], 0, true, undefined, undefined, NOW,
    );
    expect(res).toMatchObject({ cleared: false, teamsCleared: 0, cumSurvivalRatio: 1, replay: null, hadDefenders: true });
    expect(pwUpdateOne).not.toHaveBeenCalled(); // nobody was beaten, so nobody is injured
  });

  it('survivors that scale below one unit end the assault even though the rung was won', async () => {
    // 9,601 attacking HP against 9,600 defending HP: the rung is won by a single hit point, and every
    // surviving unit rounds to zero — the "beat some teams, cannot continue" break.
    const attackerArmy = synthesizeArmy(9_601, 'attacker');
    const d = defenderTeam(DEF1, 'd1-card', 9_600);
    const { core, pwUpdateOne } = makeCore({ stationedDocs: [d.st], owners: [d.owner], saves: { [DEF1]: d.save } });
    const res = await fight(core, { attackerArmy });

    expect(resolveSiege(sumArmyHp(attackerArmy), sumArmyHp(d.formation)).attackerSurvivors).toBe(1);
    expect(res.teamsCleared).toBe(1);
    expect(res.cleared).toBe(false);
    expect(res.survivorArmy).toHaveLength(0);
    expect(setCalls(pwUpdateOne)).toHaveLength(1); // the team it beat is still injured
  });

  it("the attacker's card payload is threaded into every rung's replay inputs", async () => {
    const cardInstances = [{ id: 'c1', defId: CARD_DEF_ID, unitType: 'infantry', level: 4, gear: {} }] as unknown as EngineCardInstance[];
    const cardEquipInv = { e1: { defId: 'probe', level: 0, affixes: [] } } as unknown as EngineEquipInv;
    const d = defenderTeam(DEF1, 'd1-card', 5_000);
    const { core } = makeCore({ stationedDocs: [d.st], owners: [d.owner], saves: { [DEF1]: d.save } });
    const res = await fight(core, { cardInstances, cardEquipInv });
    expect(res.replay!.cardInstances).toBe(cardInstances);
    expect(res.replay!.equipmentInv).toBe(cardEquipInv);
  });

  it('an engine crash on a rung falls back to the cheap formula and keeps the replay inputs', async () => {
    vi.mocked(runSiegeBattle).mockImplementation(async () => {
      throw new Error('forced engine crash');
    });
    const attackerArmy = synthesizeArmy(500, 'attacker');
    const d = defenderTeam(DEF1, 'd1-card', 400);
    const { core, pwUpdateOne } = makeCore({ stationedDocs: [d.st], owners: [d.owner], saves: { [DEF1]: d.save } });
    // attackerSynthesized:false + a small, non-overflowing garrison → this rung really does reach the engine.
    const res = await fight(core, { attackerArmy, attackerSynthesized: false });

    expect(runSiegeBattle).toHaveBeenCalledTimes(1);
    const rung = resolveSiege(500, sumArmyHp(d.formation));
    expect(res.teamsCleared).toBe(1);
    expect(res.cumSurvivalRatio).toBeCloseTo(rung.attackerSurvivors / 500, 12);
    expect(res.replay!.seed).toBe(waveSeed('m1', 0)); // the inputs that crashed the engine survive
    expect(setCalls(pwUpdateOne)).toHaveLength(1);
  });

  it('an engine rung that reports no deployment measures survival against the army that was sent in', async () => {
    const SURVIVORS = 250;
    vi.mocked(runSiegeBattle).mockImplementation(async (): Promise<SiegeResolution> => ({
      outcome: 'attacker_win', attackerSurvivors: SURVIVORS, defenderSurvivors: 0,
      attackerDeployed: 0, defenderDeployed: 0,
    }));
    const attackerArmy = synthesizeArmy(500, 'attacker');
    const d = defenderTeam(DEF1, 'd1-card', 400);
    const { core } = makeCore({ stationedDocs: [d.st], owners: [d.owner], saves: { [DEF1]: d.save } });
    const res = await fight(core, { attackerArmy, attackerSynthesized: false });

    expect(res.cleared).toBe(true);
    expect(res.cumSurvivalRatio).toBe(SURVIVORS / 500); // not 0, which a 0 denominator would have produced
    expect(sumArmyHp(res.survivorArmy)).toBe(sumArmyHp(scaleArmyByRatio(attackerArmy, SURVIVORS / 500)));
  });
});
