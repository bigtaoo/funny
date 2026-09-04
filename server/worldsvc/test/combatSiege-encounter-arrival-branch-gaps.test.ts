// Unit tests (hand-built fake WorldCore, no Mongo — same style as occupation-battle.test.ts /
// combatSiege-damage-helpers-gaps.test.ts) targeting the branch-coverage gaps in
// combatSiege/encounter.ts (EncounterService.resolveFieldEncounter + the card half of
// applyTowerDamage) and combatSiege/arrival.ts (ArrivalService.applySiege's dispatch/guard
// ladder). Both classes only ever touch `this.core` (deps.cols + a handful of core methods),
// `SiegeHelpersService` and — for arrival — `OccupationService`, so every dependency is stubbed
// directly and no real Mongo is needed.
//
// Two things ARE module-mocked, both deliberately:
//   1. `src/siegeWorkerPool` — the real `runSiegeBattle` hands the fight to a worker thread whose
//      outcome is engine-decided. Stubbing the pool (not the battle helpers) lets a test pin the
//      exact SiegeResolution the settlement code then has to divide, write and persist, and lets
//      the engine-crash fallback be reached without fabricating an illegal formation. Tests that
//      want the deterministic cheap formula instead steer `shouldUseCheapSiege` with real
//      SIEGE_CHEAP_RATIO / SIEGE_SYNTH_ARMY_MAX_TROOPS-derived sizes; the default pool stub returns
//      an obviously-bogus sentinel so a test that lands on the engine by accident fails loudly.
//   2. `src/combatSiege/arrival/*` — applySiege is a DISPATCHER; the five landing modules it
//      delegates to already have their own unit suite (combatSiege-arrival-variants-gaps.test.ts).
//      Mocking them keeps these tests on applySiege's own decisions and, crucially, makes the
//      values it computes (baseTile resolution, effGarrison, tileLevel, replay inputs) directly
//      assertable at the call boundary.
//
// No @nw/shared pure function is mocked: expected values are recomputed here with the same
// functions the source uses (resolveSiege / moraleCombatMultiplier / nationDefenseStrength /
// academyBuff / npcBaseHp / synthesizeArmy / scaleArmyByRatio / toDefenderFormation /
// computeCardStateUpdates), so these assertions stay true if a constant is retuned.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  ARROW_TOWER_DMG_RATIO,
  ARROW_TOWER_DMG_CAP,
  MARCH_MORALE_MAX,
  moraleCombatMultiplier,
  resolveSiege,
  playerWorldId,
  nationDefenseStrength,
  tileGarrisonBaseline,
  academyBuff,
  npcBaseHp,
  type SiegeResolution,
} from '@nw/shared';
import { ENGINE_VERSION } from '@nw/engine';
import {
  synthesizeArmy,
  scaleArmyByRatio,
  sumArmyHp,
  toDefenderFormation,
  SIEGE_SYNTH_ARMY_MAX_TROOPS,
} from '../src/siegeEngine';
import { computeCardStateUpdates, cardStateDeltaPipeline } from '../src/cardStateSettlement';
import { EncounterService } from '../src/combatSiege/encounter';
import { ArrivalService } from '../src/combatSiege/arrival';
import { SiegeHelpersService } from '../src/combatSiege/helpers';
import { emptyResources } from '../src/core';
import type { WorldCore } from '../src/core';
import type { OccEntry, CoverEntry } from '../src/core/push';
import type { OccupationService } from '../src/combatSiege/occupation';
import type { MarchDoc, PlayerWorldDoc, StationedDoc, TileDoc, ArmyEntry } from '../src/db';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module mocks (see the file header for why).
// ─────────────────────────────────────────────────────────────────────────────────────────────

const engineStub = vi.hoisted(() => ({
  submit: null as null | ((input: unknown) => Promise<unknown>),
}));

vi.mock('../src/siegeWorkerPool', () => ({
  getSiegeWorkerPool: () => ({
    submit: async (input: unknown) => {
      if (!engineStub.submit) {
        return {
          outcome: 'attacker_win',
          attackerSurvivors: 424_242,
          defenderSurvivors: 424_242,
          attackerDeployed: 424_242,
          defenderDeployed: 424_242,
        };
      }
      return engineStub.submit(input);
    },
  }),
}));

const landing = vi.hoisted(() => ({
  applyBaseSiege: vi.fn(async (..._args: unknown[]) => {}),
  applyStrongholdSiege: vi.fn(async (..._args: unknown[]) => {}),
  applyCitySiege: vi.fn(async (..._args: unknown[]) => {}),
  applyCrossingSiege: vi.fn(async (..._args: unknown[]) => {}),
  landSiege: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../src/combatSiege/arrival/baseSiege', () => ({ applyBaseSiege: landing.applyBaseSiege }));
vi.mock('../src/combatSiege/arrival/strongholdSiege', () => ({ applyStrongholdSiege: landing.applyStrongholdSiege }));
vi.mock('../src/combatSiege/arrival/citySiege', () => ({ applyCitySiege: landing.applyCitySiege }));
vi.mock('../src/combatSiege/arrival/crossingSiege', () => ({ applyCrossingSiege: landing.applyCrossingSiege }));
vi.mock('../src/combatSiege/arrival/landSiege', () => ({ landSiege: landing.landSiege }));

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────

const W = 's1';
const ATK = 'atk-1';
const DEF = 'def-1';
const TILE = `${W}:5:5`;              // procedural 'resource' ground for world 's1' (no city / stronghold / crossing)
const CITY_TILE = `${W}:0:470`;       // procedural 'familyKeep' — city ground (isCityGroundTile === true)
const T = 1_700_000_000_000;

function march(overrides: Partial<MarchDoc> = {}): MarchDoc {
  return {
    _id: 'm1', worldId: W, ownerId: ATK, fromTile: `${W}:0:0`, toTile: TILE,
    kind: 'attack', troops: 100, morale: MARCH_MORALE_MAX, departAt: 0, arriveAt: 0,
    status: 'marching', rev: 0,
    ...overrides,
  } as unknown as MarchDoc;
}

function pw(overrides: Partial<PlayerWorldDoc> = {}): PlayerWorldDoc {
  return {
    _id: playerWorldId(W, (overrides.accountId as string | undefined) ?? ATK), worldId: W, accountId: ATK,
    troops: 0, troopCap: 999_999, resources: emptyResources(), yieldRate: emptyResources(),
    lastTickAt: 0, rev: 0,
    ...overrides,
  } as unknown as PlayerWorldDoc;
}

/**
 * `garrisonRegenAt: T` (2026-09-04, garrison regen / SLG_DESIGN §5.6) is part of the DEFAULT because these
 * cases are about siege resolution, not about the baseline heal: an owned tile with no checkpoint reads as
 * "no recent battle", i.e. already healed to `tileGarrisonBaseline(level)`, which would silently replace
 * every `garrison:` this file sets with a level-derived number. Stamping the current instant pins each tile
 * at exactly the garrison the case asked for. The absent-checkpoint read has its own case below, and the
 * heal arithmetic is pinned in core-helpers-gaps.test.ts / shared/test/garrison.test.ts.
 */
function tile(overrides: Partial<TileDoc> = {}): TileDoc {
  return { _id: TILE, worldId: W, x: 5, y: 5, type: 'territory', level: 1, garrisonRegenAt: T, rev: 0, ...overrides } as unknown as TileDoc;
}

/** A flat (non-card) army entry — `initialHp` is what sumArmyHp/scaleArmyByRatio operate on. */
function flat(initialHp: number, col = 2, row = 1): ArmyEntry {
  return { unitType: 'infantry', col, row, initialHp } as unknown as ArmyEntry;
}

function card(cardInstanceId: string, col = 2, row = 1): ArmyEntry {
  return { cardInstanceId, col, row } as unknown as ArmyEntry;
}

beforeEach(() => {
  engineStub.submit = null;
  landing.applyBaseSiege.mockClear();
  landing.applyStrongholdSiege.mockClear();
  landing.applyCitySiege.mockClear();
  landing.applyCrossingSiege.mockClear();
  landing.landSiege.mockClear();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// encounter.ts — EncounterService
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface EncounterOpts {
  stationed?: StationedDoc | null;
  defMarch?: MarchDoc | null;
  defPw?: PlayerWorldDoc | null;
  /** `'reject'` makes meta.getSaveFields throw (encounter swallows it via .catch(() => null)). */
  attackerSave?: unknown;
  defenderSave?: unknown;
}

function encounterCore(opts: EncounterOpts = {}) {
  const stationedFindOne = vi.fn(async (..._args: unknown[]) => opts.stationed ?? null);
  const stationedDeleteOne = vi.fn(async (..._args: unknown[]) => ({}));
  const stationedUpdateOne = vi.fn(async (..._args: unknown[]) => ({}));
  const marchesFindOne = vi.fn(async (..._args: unknown[]) => opts.defMarch ?? null);
  const marchesFindOneAndDelete = vi.fn(async (..._args: unknown[]) => opts.defMarch ?? null);
  const marchesUpdateOne = vi.fn(async (..._args: unknown[]) => ({}));
  const playerWorldFindOne = vi.fn(async (..._args: unknown[]) => opts.defPw ?? null);
  const playerWorldUpdateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
  const getSaveFields = vi.fn(async (accountId: string, ..._rest: unknown[]) => {
    const v = accountId === ATK ? opts.attackerSave : opts.defenderSave;
    if (v === 'reject') throw new Error('meta unreachable');
    return (v ?? null) as never;
  });
  const removeCover = vi.fn(async (..._args: unknown[]) => {});
  const pushOrderEnded = vi.fn(async (..._args: unknown[]) => {});
  const pushMarch = vi.fn(async (..._args: unknown[]) => {});
  const clearOccupancy = vi.fn(async (..._args: unknown[]) => {});
  const bumpFamilyActivity = vi.fn(async (..._args: unknown[]) => {});
  const pushSiege = vi.fn(async (..._args: unknown[]) => {});

  const core = {
    deps: {
      now: () => T,
      cols: {
        stationed: { findOne: stationedFindOne, deleteOne: stationedDeleteOne, updateOne: stationedUpdateOne },
        marches: { findOne: marchesFindOne, findOneAndDelete: marchesFindOneAndDelete, updateOne: marchesUpdateOne },
        playerWorld: { findOne: playerWorldFindOne, updateOne: playerWorldUpdateOne },
      },
    },
    meta: { getSaveFields },
    removeCover, pushOrderEnded, pushMarch, clearOccupancy, bumpFamilyActivity, pushSiege,
    marchView: (m: MarchDoc) => m as unknown as never,
  } as unknown as WorldCore;

  const helpers = {
    recordSiege: vi.fn(async (..._args: unknown[]) => ({ _id: 'siege-1' })),
  } as unknown as SiegeHelpersService;

  return {
    svc: new EncounterService(core, helpers), core, helpers,
    stationedFindOne, stationedDeleteOne, stationedUpdateOne,
    marchesFindOne, marchesFindOneAndDelete, marchesUpdateOne,
    playerWorldFindOne, playerWorldUpdateOne, getSaveFields,
    removeCover, pushOrderEnded, pushMarch, clearOccupancy, bumpFamilyActivity, pushSiege,
    recordSiege: helpers.recordSiege as unknown as ReturnType<typeof vi.fn>,
  };
}

function occ(overrides: Partial<OccEntry> = {}): OccEntry {
  return { kind: 'stationed', id: TILE, ownerId: DEF, tile: TILE, leaveAt: 0, ...overrides };
}

function stationedDoc(overrides: Partial<StationedDoc> = {}): StationedDoc {
  return {
    _id: TILE, worldId: W, ownerId: DEF, tile: TILE, x: 5, y: 5, teamId: 't1',
    troops: 300, sinceAt: 0,
    ...overrides,
  } as unknown as StationedDoc;
}

describe('EncounterService.resolveFieldEncounter — friend/foe gate (isFriendlyOcc)', () => {
  it('a same-family occupant with a DIFFERENT owner is a friend: no fight, no defender doc even loaded', async () => {
    const h = encounterCore();
    const m = march({ troops: 100, army: [flat(100)] });
    const result = await h.svc.resolveFieldEncounter(m, pw({ familyId: 'fam-1' }), occ({ familyId: 'fam-1' }), TILE, T);
    expect(result).toEqual({ fought: false, marcherContinues: true, marcherTroops: 100, marcherArmy: m.army });
    expect(h.stationedFindOne).not.toHaveBeenCalled();
    expect(h.recordSiege).not.toHaveBeenCalled();
  });

  it('an occupancy entry pointing at a march that has already settled/recalled is a no-op, not a fight', async () => {
    // Stale occ read: the resident march doc is gone by the time the entering march looks it up.
    const h = encounterCore({ defMarch: null });
    const m = march({ troops: 100, army: [flat(100)] });
    const result = await h.svc.resolveFieldEncounter(m, pw(), occ({ kind: 'march', id: 'dm1' }), TILE, T);

    expect(result).toEqual({ fought: false, marcherContinues: true, marcherTroops: 100, marcherArmy: m.army });
    expect(h.marchesFindOne).toHaveBeenCalledWith({ _id: 'dm1', status: 'marching' });
    expect(h.recordSiege).not.toHaveBeenCalled();
    expect(h.clearOccupancy).not.toHaveBeenCalled();
  });

  it('an occupant with NO family is never a friend, even when the marcher has one → the battle runs', async () => {
    const h = encounterCore({ stationed: stationedDoc({ troops: 300 }) });
    // occ.familyId is absent, so the family half of the OR must not short-circuit to "friendly".
    const result = await h.svc.resolveFieldEncounter(
      march({ troops: 10_000 }), pw({ familyId: 'fam-1' }), occ({ familyId: undefined }), TILE, T,
    );
    expect(result.fought).toBe(true);
  });

  it('a marcher with NO family is never a friend of a family occupant → the battle runs', async () => {
    const h = encounterCore({ defMarch: march({ _id: 'dm1', ownerId: DEF, troops: 300, army: [flat(300)] }) });
    const result = await h.svc.resolveFieldEncounter(
      march({ troops: 20_000, army: [flat(20_000)] }), pw({ familyId: undefined }), occ({ kind: 'march', id: 'dm1', familyId: 'fam-2' }), TILE, T,
    );
    expect(result.fought).toBe(true);
  });
});

describe('EncounterService.resolveFieldEncounter — attacker wins (cheap deterministic path)', () => {
  it('flat marcher with no army snapshot vs stationed garrison with no army: both sides synthesize, morale defaults to MAX', async () => {
    const st = stationedDoc({ troops: 300, army: undefined, mode: 'garrison' });
    const h = encounterCore({ stationed: st });
    // morale omitted → MARCH_MORALE_MAX fallback; army omitted → synthesizeArmy on both sides.
    const m = march({ troops: 10_000, army: undefined, morale: undefined });

    const result = await h.svc.resolveFieldEncounter(m, pw({ familyId: 'fam-1' }), occ({ familyId: undefined }), TILE, T);

    const mult = moraleCombatMultiplier(MARCH_MORALE_MAX);
    const attackerHp = sumArmyHp(scaleArmyByRatio(synthesizeArmy(10_000, 'attacker'), mult));
    const defenderHp = sumArmyHp(toDefenderFormation(synthesizeArmy(300, 'defender')));
    const expected = resolveSiege(attackerHp, defenderHp);
    expect(expected.outcome).toBe('attacker_win'); // sanity: the sizes really do overwhelm
    const aRatio = expected.attackerSurvivors / expected.attackerDeployed;

    expect(result.fought).toBe(true);
    expect(result.marcherContinues).toBe(true);
    expect(result.marcherTroops).toBe(Math.round(10_000 * aRatio));
    // No army snapshot went in, so none comes out — advanceMarch leaves MarchDoc.army as-is.
    expect(result.marcherArmy).toBeUndefined();
    // Resident garrison destroyed: doc removed, its 3×3 coverage dropped, owner told, occ cleared.
    expect(h.stationedDeleteOne).toHaveBeenCalledWith({ _id: TILE });
    expect(h.removeCover).toHaveBeenCalledWith(W, 5, 5, TILE);
    expect(h.pushOrderEnded).toHaveBeenCalledWith(DEF, expect.objectContaining({ tile: TILE, status: 'recalled' }));
    expect(h.clearOccupancy).toHaveBeenCalledWith(W, TILE, TILE);
    // Report is pinned to the ENCOUNTER cell and pushed to both owners.
    expect(h.recordSiege).toHaveBeenCalledWith(expect.objectContaining({ toTile: TILE }), DEF, 'attacker_win', T, expect.anything());
    expect(h.pushSiege).toHaveBeenCalledTimes(2);
  });

  it('flat marcher WITH an army snapshot vs a resident march: both armies come from the docs, survivors are scaled', async () => {
    const defArmy = [flat(400)];
    const dm = march({ _id: 'dm1', ownerId: DEF, troops: 400, army: defArmy });
    const h = encounterCore({ defMarch: dm });
    const atkArmy = [flat(20_000)];
    const m = march({ troops: 20_000, army: atkArmy });

    const result = await h.svc.resolveFieldEncounter(m, pw(), occ({ kind: 'march', id: 'dm1' }), TILE, T);

    const mult = moraleCombatMultiplier(MARCH_MORALE_MAX);
    const attackerHp = sumArmyHp(scaleArmyByRatio(atkArmy as never, mult));
    const defenderHp = sumArmyHp(toDefenderFormation(defArmy as never));
    const expected = resolveSiege(attackerHp, defenderHp);
    expect(expected.outcome).toBe('attacker_win');
    const aRatio = expected.attackerSurvivors / expected.attackerDeployed;

    expect(result.marcherContinues).toBe(true);
    expect(result.marcherTroops).toBe(Math.round(20_000 * aRatio));
    expect(result.marcherArmy).toEqual(scaleArmyByRatio(atkArmy as never, aRatio));
    // A resident MARCH is claimed+deleted (not the stationed collection) and its owner sees it recalled.
    expect(h.marchesFindOneAndDelete).toHaveBeenCalledWith({ _id: 'dm1', status: 'marching' });
    expect(h.stationedDeleteOne).not.toHaveBeenCalled();
    expect(h.pushMarch).toHaveBeenCalledWith(DEF, expect.objectContaining({ status: 'recalled' }));
    // An idle (non-garrison) resident never had coverage to drop.
    expect(h.removeCover).not.toHaveBeenCalled();
  });

  it('a card DEFENDER whose playerWorld doc is gone resolves against an empty formation and no cardState is written', async () => {
    const st = stationedDoc({ troops: 500, army: [card('d1')] });
    // defPw null + a failed defender save fetch → both `??` fallbacks feed resolveCardArmy empty tables.
    const h = encounterCore({ stationed: st, defPw: null, defenderSave: 'reject' });

    const result = await h.svc.resolveFieldEncounter(march({ troops: 5_000, army: undefined }), pw(), occ(), TILE, T);

    expect(result.fought).toBe(true);
    expect(result.marcherContinues).toBe(true);
    // The defender resolved to zero units, so the marcher walks over it and the doc is destroyed …
    expect(h.stationedDeleteOne).toHaveBeenCalledWith({ _id: TILE });
    // … and with no defender playerWorld doc there is nothing to write a card ledger to.
    expect(h.playerWorldUpdateOne).not.toHaveBeenCalled();
  });

  it('a card DEFENDER whose owner has an empty ledger and an empty card inventory also fields nothing', async () => {
    const st = stationedDoc({ troops: 500, army: [card('d1')] });
    const defPw = pw({ accountId: DEF, cardState: undefined });
    // Present-but-empty defender snapshot: the `??` fallbacks (not the optional-chain ones) supply the tables.
    const h = encounterCore({ stationed: st, defPw, defenderSave: {} });

    const result = await h.svc.resolveFieldEncounter(march({ troops: 5_000, army: undefined }), pw(), occ(), TILE, T);

    expect(result.marcherContinues).toBe(true);
    expect(h.stationedDeleteOne).toHaveBeenCalledWith({ _id: TILE });
    // The defender's ledger is normalized in memory but has no deployed troops to debit.
    expect(defPw.cardState).toEqual({});
    expect(h.playerWorldUpdateOne).not.toHaveBeenCalled();
  });

  it('a resident MARCH with no army snapshot has its garrison synthesized from its troop count', async () => {
    const h = encounterCore({ defMarch: march({ _id: 'dm1', ownerId: DEF, troops: 300, army: undefined }) });
    const result = await h.svc.resolveFieldEncounter(
      march({ troops: 10_000, army: undefined }), pw(), occ({ kind: 'march', id: 'dm1' }), TILE, T,
    );

    const mult = moraleCombatMultiplier(MARCH_MORALE_MAX);
    const attackerHp = sumArmyHp(scaleArmyByRatio(synthesizeArmy(10_000, 'attacker'), mult));
    const expected = resolveSiege(attackerHp, sumArmyHp(toDefenderFormation(synthesizeArmy(300, 'defender'))));
    expect(expected.outcome).toBe('attacker_win');

    expect(result.marcherTroops).toBe(Math.round(10_000 * (expected.attackerSurvivors / expected.attackerDeployed)));
    expect(h.marchesFindOneAndDelete).toHaveBeenCalledWith({ _id: 'dm1', status: 'marching' });
    expect(h.clearOccupancy).toHaveBeenCalledWith(W, TILE, 'dm1');
  });
});

describe('EncounterService.resolveFieldEncounter — defender holds', () => {
  it('a flat stationed defender WITH an army is rewritten with both scaled troops and a scaled formation', async () => {
    const defArmy = [flat(400)];
    const h = encounterCore({ stationed: stationedDoc({ troops: 500, army: defArmy }) });
    engineStub.submit = async () => ({
      outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: 250,
      attackerDeployed: 100, defenderDeployed: 500,
    });

    const result = await h.svc.resolveFieldEncounter(march({ troops: 100, army: [flat(100)] }), pw(), occ(), TILE, T);

    const dRatio = 250 / 500;
    expect(result).toEqual({ fought: true, marcherContinues: false, marcherTroops: 0 });
    expect(h.stationedUpdateOne).toHaveBeenCalledWith(
      { _id: TILE },
      { $set: { troops: Math.round(500 * dRatio), army: scaleArmyByRatio(defArmy as never, dRatio) } },
    );
    expect(h.stationedDeleteOne).not.toHaveBeenCalled();
    expect(h.clearOccupancy).not.toHaveBeenCalled(); // the defender keeps the cell
  });

  it('a flat resident MARCH defender is rewritten in place (troops + army + rev bump), not deleted', async () => {
    const defArmy = [flat(400)];
    const h = encounterCore({ defMarch: march({ _id: 'dm1', ownerId: DEF, troops: 500, army: defArmy }) });
    engineStub.submit = async () => ({
      outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: 200,
      attackerDeployed: 100, defenderDeployed: 500,
    });

    await h.svc.resolveFieldEncounter(march({ troops: 100, army: [flat(100)] }), pw(), occ({ kind: 'march', id: 'dm1' }), TILE, T);

    const dRatio = 200 / 500;
    expect(h.marchesUpdateOne).toHaveBeenCalledWith(
      { _id: 'dm1', status: 'marching' },
      { $set: { troops: Math.round(500 * dRatio), army: scaleArmyByRatio(defArmy as never, dRatio) }, $inc: { rev: 1 } },
    );
    expect(h.marchesFindOneAndDelete).not.toHaveBeenCalled();
  });

  it('a defender with no army snapshot gets a troops-only rewrite, and flat attacker survivors become a return leg', async () => {
    const h = encounterCore({ stationed: stationedDoc({ troops: 500, army: undefined }) });
    engineStub.submit = async () => ({
      outcome: 'defender_win', attackerSurvivors: 40, defenderSurvivors: 300,
      attackerDeployed: 100, defenderDeployed: 500,
    });

    const result = await h.svc.resolveFieldEncounter(march({ troops: 100, army: [] }), pw(), occ(), TILE, T);

    // No `army` key at all — there was no formation to scale, so the snapshot is left alone.
    expect(h.stationedUpdateOne).toHaveBeenCalledWith({ _id: TILE }, { $set: { troops: Math.round(500 * (300 / 500)) } });
    expect(result).toEqual({ fought: true, marcherContinues: false, marcherTroops: 0, returnTroops: 40 });
  });

  it('the engine crashing falls back to the cheap linear formula instead of stalling the march', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const defArmy = [flat(5_000)];
    const h = encounterCore({ stationed: stationedDoc({ troops: 5_000, army: defArmy }) });
    engineStub.submit = async () => { throw new Error('worker died'); };

    await h.svc.resolveFieldEncounter(march({ troops: 100, army: [flat(100)] }), pw(), occ(), TILE, T);

    const mult = moraleCombatMultiplier(MARCH_MORALE_MAX);
    const attackerHp = sumArmyHp(scaleArmyByRatio([flat(100)] as never, mult));
    const defenderHp = sumArmyHp(toDefenderFormation(defArmy as never));
    const expected = resolveSiege(attackerHp, defenderHp);
    expect(expected.outcome).toBe('defender_win');
    const dRatio = expected.defenderSurvivors / expected.defenderDeployed;

    expect(errSpy).toHaveBeenCalledWith(
      '[worldsvc] field encounter engine failed — fallback to cheap resolve',
      expect.objectContaining({ tile: TILE, err: 'worker died' }),
    );
    expect(h.stationedUpdateOne).toHaveBeenCalledWith(
      { _id: TILE },
      { $set: { troops: Math.round(5_000 * dRatio), army: scaleArmyByRatio(defArmy as never, dRatio) } },
    );
    expect(h.recordSiege).toHaveBeenCalledWith(expect.anything(), DEF, 'defender_win', T, expect.anything());
    errSpy.mockRestore();
  });
});

describe('EncounterService.resolveFieldEncounter — card marcher ledger (writeFieldCardState)', () => {
  it('a card marcher with no cardState at all: nothing is persisted, the doc gains an empty ledger, defeat returns 0 troops home', async () => {
    const h = encounterCore({ stationed: stationedDoc({ troops: 0, army: undefined }), attackerSave: 'reject' });
    const p = pw({ cardState: undefined });
    // Both sides resolve to zero HP → the engine path is taken (shouldUseCheapSiege bails at attackerTroops<=0).
    engineStub.submit = async () => ({
      outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: 0,
      attackerDeployed: 0, defenderDeployed: 0,
    });

    const result = await h.svc.resolveFieldEncounter(march({ troops: 1, army: [card('c1')] }), p, occ(), TILE, T);

    // computeCardStateUpdates short-circuits on 0 nominal troops, so there is no pipeline to write …
    expect(h.playerWorldUpdateOne).not.toHaveBeenCalled();
    // … but the in-memory ledger is still normalized for a possible second encounter this step batch.
    expect(p.cardState).toEqual({});
    // A card army always qualifies for a return leg, carrying 0 flat troops (its strength lives in cardState).
    expect(result).toEqual({ fought: true, marcherContinues: false, marcherTroops: 0, returnTroops: 0 });
  });

  it('a card in the army but absent from cardState is materialized at 0 while its team-mate takes the real loss', async () => {
    const h = encounterCore({ stationed: stationedDoc({ troops: 100, army: undefined }), attackerSave: {} });
    const p = pw({ cardState: { c1: { currentTroops: 1_000 } } as never });
    const army = [card('c1'), card('c2', 3)];
    engineStub.submit = async () => ({
      outcome: 'attacker_win', attackerSurvivors: 600, defenderSurvivors: 0,
      attackerDeployed: 1_000, defenderDeployed: 100,
    });

    const m = march({ troops: 2, army });
    const result = await h.svc.resolveFieldEncounter(m, p, occ(), TILE, T);

    const updates = computeCardStateUpdates(army, { c1: { currentTroops: 1_000 } } as never, 600, T, 1_000);
    expect(updates.c1!.losses).toBe(400); // 60% survival off 1000 deployed
    expect(updates.c2!.losses).toBe(0);   // never had troops to lose
    expect(h.playerWorldUpdateOne).toHaveBeenCalledWith({ _id: p._id }, cardStateDeltaPipeline(updates));
    // The mirrored in-memory ledger now holds an entry for the previously-absent card too.
    expect(p.cardState).toEqual({ c1: { currentTroops: 600 }, c2: { currentTroops: 0 } });
    // A winning card army keeps its MarchDoc troops/army untouched — strength lives in cardState.
    expect(result.marcherTroops).toBe(m.troops);
    expect(result.marcherArmy).toBe(m.army);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// encounter.ts — applyTowerDamage (the card half; the flat half lives in
// combatSiege-occupation-encounter-gaps.test.ts)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('EncounterService.applyTowerDamage — card armies and army snapshots', () => {
  const tower = { kind: 'tower', sourceTile: `${W}:6:6`, ownerId: DEF } as CoverEntry;

  it('a card marcher whose owner has no cardState at all is a no-op (nothing to chip)', async () => {
    const h = encounterCore();
    const m = march({ troops: 7, army: [card('c1')] });
    const result = await h.svc.applyTowerDamage(m, pw({ cardState: undefined }), tower, T);
    expect(result).toEqual({ applied: false, marcherDestroyed: false, marcherTroops: 7, marcherArmy: m.army });
    expect(h.playerWorldUpdateOne).not.toHaveBeenCalled();
  });

  it('a card total small enough that the chip rounds to zero damage is a no-op', async () => {
    const h = encounterCore();
    const total = 4;
    expect(Math.round(total * ARROW_TOWER_DMG_RATIO)).toBe(0); // sanity against the real ratio
    const m = march({ troops: 0, army: [card('c1')] });
    const result = await h.svc.applyTowerDamage(m, pw({ cardState: { c1: { currentTroops: total } } as never }), tower, T);
    expect(result.applied).toBe(false);
    expect(h.playerWorldUpdateOne).not.toHaveBeenCalled();
  });

  it('a multi-card army loses the chip proportionally and reports the re-summed post-write total', async () => {
    const h = encounterCore();
    const before = { c1: { currentTroops: 600 }, c2: { currentTroops: 400 } };
    const p = pw({ cardState: structuredClone(before) as never });
    const army = [card('c1'), card('c2', 3)];
    const m = march({ troops: 0, army });

    const result = await h.svc.applyTowerDamage(m, p, tower, T);

    const total = 1_000;
    const dmg = Math.min(Math.round(total * ARROW_TOWER_DMG_RATIO), ARROW_TOWER_DMG_CAP);
    const survivors = Math.max(1, total - dmg);
    const updates = computeCardStateUpdates(army, before as never, survivors, T);
    expect(h.playerWorldUpdateOne).toHaveBeenCalledWith({ _id: p._id }, cardStateDeltaPipeline(updates));
    expect(result.applied).toBe(true);
    expect(result.marcherDestroyed).toBe(false); // a tower only weakens a card army, never wipes it
    expect(result.marcherTroops).toBe(
      (600 - updates.c1!.losses) + (400 - updates.c2!.losses),
    );
    expect(result.marcherTroops).toBe(survivors);
    // The card army keeps its own entries (strength is in cardState, not the snapshot).
    expect(result.marcherArmy).toBe(m.army);
  });

  it('a flat marcher WITH an army snapshot gets that snapshot scaled down by the survival ratio', async () => {
    const h = encounterCore();
    const army = [flat(600), flat(400, 3)];
    const troops = 1_000;
    const result = await h.svc.applyTowerDamage(march({ troops, army }), pw(), tower, T);

    const dmg = Math.min(Math.round(troops * ARROW_TOWER_DMG_RATIO), ARROW_TOWER_DMG_CAP);
    const survivors = troops - dmg;
    expect(result.applied).toBe(true);
    expect(result.marcherTroops).toBe(survivors);
    expect(result.marcherArmy).toEqual(scaleArmyByRatio(army as never, survivors / troops));
    expect(result.marcherArmy).not.toBe(army); // a fresh scaled snapshot, not the original
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// arrival.ts — ArrivalService.applySiege (dispatch + guard ladder)
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface ArrivalOpts {
  tiles?: Record<string, TileDoc | null>;
  connected?: boolean;
  city?: unknown;
  inOwnSectProvince?: boolean;
  defender?: PlayerWorldDoc | null;
  world?: { engineVersion?: unknown } | null;
  /** `'reject'` makes meta.getSaveFields throw (applySiege swallows it via .catch(() => null)). */
  attackerSave?: unknown;
  defenderSave?: unknown;
}

function arrivalCore(opts: ArrivalOpts = {}) {
  const tiles = opts.tiles ?? {};
  const tilesFindOne = vi.fn(async (q: unknown) => tiles[(q as { _id: string })._id] ?? null);
  const playerWorldFindOne = vi.fn(async (..._args: unknown[]) => opts.defender ?? null);
  const playerWorldUpdateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
  const worldsFindOne = vi.fn(async (..._args: unknown[]) => (opts.world === undefined ? { engineVersion: ENGINE_VERSION } : opts.world));
  const stationedUpdateOne = vi.fn(async (..._args: unknown[]) => ({}));
  const getSaveFields = vi.fn(async (accountId: string, ..._rest: unknown[]) => {
    const v = accountId === ATK ? opts.attackerSave : opts.defenderSave;
    if (v === 'reject') throw new Error('meta unreachable');
    return (v ?? null) as never;
  });
  const isConnectedToSectTerritory = vi.fn(async (..._args: unknown[]) => opts.connected ?? true);
  const cityAt = vi.fn(async (..._args: unknown[]) => (opts.city ?? null) as never);
  const inOwnSectProvince = vi.fn(async (..._args: unknown[]) => opts.inOwnSectProvince ?? false);
  const targetFootprintCells = vi.fn((_t: unknown, x: number, y: number) => [{ x, y }]);
  const pushMarch = vi.fn(async (..._args: unknown[]) => {});
  const setOccupancy = vi.fn(async (..._args: unknown[]) => {});

  const core = {
    deps: {
      now: () => T,
      cols: {
        tiles: { findOne: tilesFindOne },
        playerWorld: { findOne: playerWorldFindOne, updateOne: playerWorldUpdateOne },
        worlds: { findOne: worldsFindOne },
        stationed: { updateOne: stationedUpdateOne },
      },
    },
    meta: { getSaveFields },
    coordX: (tid: string) => Number(tid.split(':')[1]),
    coordY: (tid: string) => Number(tid.split(':')[2]),
    cityAt, inOwnSectProvince, targetFootprintCells, isConnectedToSectTerritory,
    pushMarch, setOccupancy,
    settle: (doc: PlayerWorldDoc) => ({ ...doc.resources }),
    marchView: (m: MarchDoc) => m as unknown as never,
  } as unknown as WorldCore;

  const helpers = new SiegeHelpersService(core);
  const occupation = {
    writeContestedHold: vi.fn(async (..._args: unknown[]) => {}),
    startOccupationHold: vi.fn(async (..._args: unknown[]) => {}),
    applyOccupationExpulsion: vi.fn(async (..._args: unknown[]) => {}),
  } as unknown as OccupationService;

  return {
    svc: new ArrivalService(core, helpers, occupation), core, helpers, occupation,
    tilesFindOne, playerWorldFindOne, playerWorldUpdateOne, worldsFindOne, stationedUpdateOne,
    getSaveFields, isConnectedToSectTerritory, cityAt, inOwnSectProvince, targetFootprintCells,
    pushMarch, setOccupancy,
    applyOccupationExpulsion: occupation.applyOccupationExpulsion as unknown as ReturnType<typeof vi.fn>,
  };
}

/** The args `landSiege` was last invoked with (see arrival.ts's call: core, ctx, m, pw, target, defenderId, defender, res, t, replay). */
function lastLandSiege() {
  const call = landing.landSiege.mock.calls.at(-1)!;
  return {
    target: call[4] as TileDoc,
    defenderId: call[5] as string,
    res: call[7] as SiegeResolution,
    replay: call[9] as { seed: number; attackerArmy: unknown[]; defenderConfig: Record<string, unknown>; tileLevel: number } & Record<string, unknown>,
  };
}

describe('ArrivalService.applySiege — connectivity re-validation on arrival', () => {
  it('a stranded teamless march refunds its troops to the pool and reports itself recalled', async () => {
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF }) }, connected: false });
    const p = pw({ troops: 10 });
    await h.svc.applySiege(march({ troops: 100 }), p, T);

    expect(h.playerWorldUpdateOne).toHaveBeenCalledWith(
      { _id: p._id, rev: 0 },
      { $set: { resources: emptyResources(), troops: 110, lastTickAt: T }, $inc: { rev: 1 } },
    );
    expect(h.pushMarch).toHaveBeenCalledWith(ATK, expect.objectContaining({ status: 'recalled' }));
    expect(landing.landSiege).not.toHaveBeenCalled();
  });

  it('a stranded TEAM march parks in place instead (no pool refund — the team keeps the troops)', async () => {
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF }) }, connected: false });
    await h.svc.applySiege(march({ troops: 100, teamId: 't1' }), pw(), T);

    expect(h.stationedUpdateOne).toHaveBeenCalledWith(
      { _id: TILE }, { $set: expect.objectContaining({ tile: TILE, troops: 100, mode: 'idle' }) }, { upsert: true },
    );
    expect(h.playerWorldUpdateOne).not.toHaveBeenCalled();
    expect(landing.landSiege).not.toHaveBeenCalled();
  });

  it('a connected march proceeds past the guard into the settlement path', async () => {
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, garrison: 10 }) }, connected: true });
    await h.svc.applySiege(march({ troops: 100_000 }), pw(), T);
    expect(landing.landSiege).toHaveBeenCalledTimes(1);
  });
});

describe('ArrivalService.applySiege — ownerless-target dispatch ladder', () => {
  it('city ground with a live city doc goes to applyCitySiege, and connectivity is checked against the WHOLE plot', async () => {
    const city = { x: 0, y: 470, footprint: 5, level: 6 };
    const h = arrivalCore({ tiles: {}, city });
    await h.svc.applySiege(march({ toTile: CITY_TILE }), pw(), T);

    expect(landing.applyCitySiege).toHaveBeenCalledTimes(1);
    expect(landing.applyCitySiege.mock.calls[0]![4]).toBe(city);
    // A 5×5 plot: all 25 cells are offered to the connectivity check, not just the landed one …
    const cells = h.isConnectedToSectTerritory.mock.calls[0]![2] as { x: number; y: number }[];
    expect(cells).toHaveLength(25);
    expect(cells).toContainEqual({ x: 0 - 2, y: 470 - 2 });
    expect(cells).toContainEqual({ x: 0 + 2, y: 470 + 2 });
    // … and the generic tile-footprint helper is bypassed entirely for a city.
    expect(h.targetFootprintCells).not.toHaveBeenCalled();
    expect(landing.landSiege).not.toHaveBeenCalled();
  });

  it('city ground with NO city doc (pre-P1 world) falls through to the miss/refund branch, not an invented target', async () => {
    const h = arrivalCore({ tiles: {}, city: null });
    const p = pw({ troops: 5 });
    await h.svc.applySiege(march({ toTile: CITY_TILE, troops: 50 }), p, T);

    expect(landing.applyCitySiege).not.toHaveBeenCalled();
    expect(h.targetFootprintCells).toHaveBeenCalled(); // the generic single-cell footprint was used
    expect(h.playerWorldUpdateOne).toHaveBeenCalledWith(
      { _id: p._id, rev: 0 },
      { $set: { resources: emptyResources(), troops: 55, lastTickAt: T }, $inc: { rev: 1 } },
    );
  });

  it('an ownerless tile still inside its occupation hold is expelled by this attack, not treated as a miss', async () => {
    const target = tile({ ownerId: undefined, contestedBy: 'other-1', contestedUntil: T + 60_000 } as never);
    const h = arrivalCore({ tiles: { [TILE]: target } });
    const m = march();
    const p = pw();
    await h.svc.applySiege(m, p, T);

    expect(h.applyOccupationExpulsion).toHaveBeenCalledWith(m, p, target, T);
    expect(landing.landSiege).not.toHaveBeenCalled();
    expect(h.playerWorldUpdateOne).not.toHaveBeenCalled(); // no refund — a real fight was started
  });

  it('a contestedBy marker with no deadline at all is treated as expired → miss/refund, no expulsion', async () => {
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: undefined, contestedBy: 'other-1', contestedUntil: undefined } as never) } });
    const p = pw({ troops: 5 });
    await h.svc.applySiege(march({ troops: 50 }), p, T);

    expect(h.applyOccupationExpulsion).not.toHaveBeenCalled();
    expect(h.playerWorldUpdateOne).toHaveBeenCalledWith(
      { _id: p._id, rev: 0 },
      { $set: { resources: emptyResources(), troops: 55, lastTickAt: T }, $inc: { rev: 1 } },
    );
  });
});

describe('ArrivalService.applySiege — miss/refund guard', () => {
  it('a target that gained a protection shield during transit is a miss; a TEAM march parks rather than teleporting home', async () => {
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, protectedUntil: T + 1_000 }) } });
    await h.svc.applySiege(march({ troops: 100, teamId: 't2' }), pw(), T);

    expect(landing.landSiege).not.toHaveBeenCalled();
    expect(h.stationedUpdateOne).toHaveBeenCalledWith(
      { _id: TILE }, { $set: expect.objectContaining({ teamId: 't2', troops: 100 }) }, { upsert: true },
    );
    expect(h.setOccupancy).toHaveBeenCalled();
  });

  it('an EXPIRED protection shield is not a miss — the siege proceeds', async () => {
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, protectedUntil: T - 1, garrison: 10 }) } });
    await h.svc.applySiege(march({ troops: 100_000 }), pw(), T);
    expect(landing.landSiege).toHaveBeenCalledTimes(1);
  });
});

describe('ArrivalService.applySiege — base-ring anchor resolution (ADR-025)', () => {
  it('a ring cell resolves garrison + level against the ANCHOR that holds them', async () => {
    const anchor = tile({ _id: `${W}:9:9`, x: 9, y: 9, ownerId: DEF, level: 7, garrison: 70, type: 'territory' });
    const h = arrivalCore({
      tiles: { [TILE]: tile({ ownerId: DEF, baseRing: true, baseAnchor: `${W}:9:9`, level: 1, garrison: 1 } as never), [`${W}:9:9`]: anchor },
    });
    await h.svc.applySiege(march({ troops: 100_000 }), pw(), T);

    const { res, replay, target } = lastLandSiege();
    expect(replay.tileLevel).toBe(7);                                    // from the anchor, not the landed cell
    expect(replay.defenderConfig.defenderBaseHp).toBe(npcBaseHp(7));
    expect(res).toEqual(resolveSiege(100_000, nationDefenseStrength(70, false)));
    expect(target._id).toBe(TILE);                                       // the march still landed where it landed
  });

  it('a ring cell whose anchor document has vanished falls back to the landed tile', async () => {
    const h = arrivalCore({
      tiles: { [TILE]: tile({ ownerId: DEF, baseRing: true, baseAnchor: `${W}:9:9`, level: 5, garrison: 40 } as never) },
    });
    await h.svc.applySiege(march({ troops: 100_000 }), pw(), T);

    const { res, replay } = lastLandSiege();
    expect(replay.tileLevel).toBe(5);
    expect(replay.defenderConfig.defenderBaseHp).toBe(npcBaseHp(5));
    expect(res).toEqual(resolveSiege(100_000, nationDefenseStrength(40, false)));
  });
});

describe('ArrivalService.applySiege — garrison / level / formation defaults', () => {
  it('a tile with no garrison field and no level defaults to 0 garrison and level 1, and the province bonus is consulted', async () => {
    // A tile freshly stripped to nothing: no `garrison` field, and a checkpoint at the current instant so
    // the baseline heal has not started yet (see the `tile()` fixture note). This is what "empty garrison"
    // now means in production — a tile that is EMPTY, not merely un-stamped.
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, garrison: undefined, level: undefined } as never) }, inOwnSectProvince: true });
    await h.svc.applySiege(march({ troops: 5_000 }), pw(), T);

    expect(h.inOwnSectProvince).toHaveBeenCalledWith(W, DEF, 5, 5);
    const { res, replay } = lastLandSiege();
    expect(nationDefenseStrength(0, true)).toBe(0); // sanity: the bonus cannot conjure a garrison
    expect(replay.tileLevel).toBe(1);
    expect(replay.defenderConfig).toBeNull();       // buildDefenderConfig returns null for an empty garrison
    const mult = moraleCombatMultiplier(MARCH_MORALE_MAX);
    expect(res).toEqual(resolveSiege(Math.round(sumArmyHp(synthesizeArmy(5_000, 'attacker')) * mult), 0));
  });

  it('a tile with NO garrisonRegenAt fights at its level baseline, not at its stored garrison (2026-09-04)', async () => {
    // The absent-checkpoint read, and the whole point of the feature: a territory stripped by an earlier
    // siege (or written before the field existed) is not a free capture for the next march. Level 6 puts
    // the floor at tileGarrisonBaseline(6) = 720 even though the document says 5 troops are left.
    const h = arrivalCore({
      tiles: { [TILE]: tile({ ownerId: DEF, level: 6, garrison: 5, garrisonRegenAt: undefined } as never) },
    });
    await h.svc.applySiege(march({ troops: 100_000 }), pw(), T);

    const { res } = lastLandSiege();
    expect(res).toEqual(resolveSiege(100_000, nationDefenseStrength(tileGarrisonBaseline(6), false)));
    // And not what the stored field alone would have given, which is what used to happen.
    expect(res).not.toEqual(resolveSiege(100_000, nationDefenseStrength(5, false)));
  });

  it('a flat march with no army snapshot synthesizes its attacker formation from the troop count', async () => {
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, garrison: 100 }) } });
    await h.svc.applySiege(march({ troops: 20_000, army: undefined }), pw(), T);

    const mult = moraleCombatMultiplier(MARCH_MORALE_MAX);
    const { replay, res } = lastLandSiege();
    expect(replay.attackerArmy).toEqual(scaleArmyByRatio(synthesizeArmy(20_000, 'attacker'), mult));
    expect(res).toEqual(resolveSiege(Math.round(sumArmyHp(synthesizeArmy(20_000, 'attacker')) * mult), 100));
  });

  it('a custom defender formation (not a synthesized one) keeps an overwhelming garrison OFF the cheap path', async () => {
    const garrison = SIEGE_SYNTH_ARMY_MAX_TROOPS + 1_000;
    const custom = [flat(50)];
    const stubbed: SiegeResolution = {
      outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: 7, attackerDeployed: 100, defenderDeployed: 500,
    };
    engineStub.submit = async () => stubbed;
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, garrison, defense: { garrison: custom } } as never) } });
    await h.svc.applySiege(march({ troops: 100, army: [flat(100)] }), pw(), T);

    const { res, replay } = lastLandSiege();
    // The board-overflow shortcut only fires for a SYNTHESIZED defender, so this one really ran the engine.
    expect(res).toEqual(stubbed);
    expect(replay.defenderConfig.garrison).toEqual(custom);
  });

  it('… whereas the same overwhelming garrison WITHOUT a custom formation short-circuits to the cheap formula', async () => {
    const garrison = SIEGE_SYNTH_ARMY_MAX_TROOPS + 1_000;
    engineStub.submit = async () => { throw new Error('the engine must not be reached here'); };
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, garrison }) } });
    await h.svc.applySiege(march({ troops: 100, army: [flat(100)] }), pw(), T);

    const mult = moraleCombatMultiplier(MARCH_MORALE_MAX);
    const { res } = lastLandSiege();
    expect(res).toEqual(resolveSiege(Math.round(sumArmyHp([flat(100)] as never) * mult), garrison));
  });
});

describe('ArrivalService.applySiege — card-army and academy replay inputs', () => {
  it('a card army with no cardState and an unreachable meta service resolves to an empty formation, with no blueprint injection', async () => {
    const stubbed: SiegeResolution = {
      outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: 90, attackerDeployed: 0, defenderDeployed: 100,
    };
    engineStub.submit = async () => stubbed;
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, garrison: 100 }) }, attackerSave: 'reject' });
    await h.svc.applySiege(march({ troops: 3, army: [card('c1')] }), pw({ cardState: undefined }), T);

    const { res, replay } = lastLandSiege();
    expect(replay.attackerArmy).toEqual([]);          // no cardInv, no cardState → nothing to deploy
    expect(replay.cardInstances).toBeUndefined();     // no save → no blueprint injection to record
    expect(replay.equipmentInv).toBeUndefined();
    expect(res).toEqual(stubbed);
    // A card march never touches the troop pool, even on a total loss.
    expect(h.playerWorldUpdateOne).not.toHaveBeenCalled();
  });

  it('a save snapshot with neither cardInv nor equipmentInv still records (empty) blueprint inputs on the replay', async () => {
    engineStub.submit = async () => ({
      outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: 90, attackerDeployed: 0, defenderDeployed: 100,
    });
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, garrison: 100 }) }, attackerSave: {} });
    await h.svc.applySiege(march({ troops: 3, army: [card('c1')] }), pw({ cardState: undefined }), T);

    const { replay } = lastLandSiege();
    expect(replay.cardInstances).toEqual([]);
    expect(replay.equipmentInv).toEqual({});
  });

  it('an academy owner rides its seasonal buff along on the replay inputs; a player with no academy sends none', async () => {
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, garrison: 10 }) } });
    await h.svc.applySiege(march({ troops: 100_000 }), pw({ buildings: { academy: 3 } as never }), T);
    const withAcademy = lastLandSiege().replay;
    expect(withAcademy.siegeAcademy).toEqual(academyBuff({ academy: 3 } as never));
    expect((withAcademy.siegeAcademy as { hp: number }).hp).toBeGreaterThan(0);

    const h2 = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, garrison: 10 }) } });
    await h2.svc.applySiege(march({ troops: 100_000 }), pw({ buildings: undefined }), T);
    expect(lastLandSiege().replay.siegeAcademy).toBeUndefined();
  });
});

describe('ArrivalService.applySiege — base target dispatch', () => {
  it('a base target goes to applyBaseSiege with empty inventories when the meta snapshot is unavailable', async () => {
    const h = arrivalCore({
      tiles: { [TILE]: tile({ ownerId: DEF, type: 'base', garrison: 50 }) },
      attackerSave: 'reject', defenderSave: 'reject', inOwnSectProvince: true,
    });
    await h.svc.applySiege(march({ troops: 1_000, army: undefined }), pw(), T);

    expect(landing.landSiege).not.toHaveBeenCalled();
    expect(landing.applyBaseSiege).toHaveBeenCalledTimes(1);
    const args = landing.applyBaseSiege.mock.calls[0]!;
    expect(args[5]).toBe(DEF);                       // defenderId
    expect(args[7]).toBe(true);                      // inOwnNation (the province bonus was resolved)
    expect(args[9]).toBeUndefined();                 // no cardInstances without a save
    expect(args[12]).toEqual({});                    // attacker cardInv falls back to {}
    expect(args[13]).toEqual({});                    // attacker equipmentInv falls back to {}
    expect(args[14]).toBe(true);                     // attackerSynthesized (flat march, no army snapshot)
    expect(args[16]).toBeNull();                     // defender save fetch failed → null, not a throw
  });

  it('a save snapshot carrying neither inventory still reaches applyBaseSiege as empty tables, not undefined', async () => {
    const defender = pw({ accountId: DEF });
    const h = arrivalCore({
      tiles: { [TILE]: tile({ ownerId: DEF, type: 'base', garrison: 50 }) },
      attackerSave: {}, defenderSave: {}, defender,
    });
    await h.svc.applySiege(march({ troops: 1_000, army: [flat(1_000)] }), pw(), T);

    const args = landing.applyBaseSiege.mock.calls[0]!;
    expect(args[6]).toBe(defender);                  // the defender's world doc was fetched and forwarded
    expect(args[12]).toEqual({});                    // cardInv missing from the snapshot → {}
    expect(args[13]).toEqual({});                    // equipmentInv missing from the snapshot → {}
    expect(args[14]).toBe(false);                    // a real army snapshot marched, so nothing was synthesized
    expect(args[16]).toEqual({});                    // the defender's (empty) snapshot rode along
  });
});

describe('ArrivalService.applySiege — engine-version drift warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  async function run(world: { engineVersion?: unknown } | null) {
    const h = arrivalCore({ tiles: { [TILE]: tile({ ownerId: DEF, garrison: 10 }) }, world });
    await h.svc.applySiege(march({ troops: 100_000 }), pw(), T);
  }

  it('warns when the shard is pinned to a different engine version than the running one', async () => {
    await run({ engineVersion: 'pinned-old-version' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('engineVersion drift'),
      expect.objectContaining({ worldId: W, pinned: 'pinned-old-version', runtime: ENGINE_VERSION }),
    );
    expect(landing.landSiege).toHaveBeenCalledTimes(1); // and the siege still settles
  });

  it('stays silent when the world document is missing entirely', async () => {
    await run(null);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(landing.landSiege).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the world has never pinned an engine version', async () => {
    await run({ engineVersion: undefined });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(landing.landSiege).toHaveBeenCalledTimes(1);
  });
});
