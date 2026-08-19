// Unit tests (fake WorldCore, no Mongo) for occupationBattle.ts — pinning the shared NPC-garrison
// battle-resolution contract split out of occupation.ts (2026-08-10) and reused verbatim by
// applyOccupy/applyOccupationExpulsion (occupation.ts) AND applyStrongholdSiege/applyCrossingSiege
// (combatSiege/arrival/{strongholdSiege,crossingSiege}.ts) — 4 call sites across 2 files now share
// this one function, so a regression here would silently affect all four combat paths at once. The
// existing e2e suites (occupy-march/stronghold/passage/siege-hold-expulsion) exercise this indirectly
// through full march/siege flows; this file pins the function's own contract in isolation (deterministic
// cheap-path formula, morale scaling, defenderBaseHp wiring, seed) with fast, no-Mongo unit tests, the
// same style as get-teams-card-lookup.test.ts / siege-cheap-fallback.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { resolveSiege, npcBaseHp, siegeSeedFromId, moraleCombatMultiplier, MARCH_MORALE_MAX, SIEGE_CHEAP_RATIO } from '@nw/shared';
import { synthesizeArmy, sumArmyHp, computeCardStateUpdates } from '../src/siegeEngine';
import { resolveOccupationBattle, writeOccupyCardState } from '../src/combatSiege/occupationBattle';
import type { WorldCore } from '../src/core';
import type { MarchDoc, PlayerWorldDoc } from '../src/db';

const W = 's1';
const ACC = 'acc-1';

/** Garrison well below board capacity, ratio-overwhelming by a wide enough margin that even the lowest
 *  possible morale multiplier (MARCH_MORALE_COMBAT_FLOOR, 0.7 at morale=0) keeps the ratio >= SIEGE_CHEAP_RATIO
 *  — so shouldUseCheapSiege always routes to the deterministic resolveSiege formula, no real engine
 *  invocation, in every test below (including the reduced-morale one). */
const GARRISON = 10;
const TROOPS = GARRISON * SIEGE_CHEAP_RATIO * 3;

function march(overrides: Partial<MarchDoc> = {}): MarchDoc {
  return {
    _id: 'm1', worldId: W, ownerId: ACC, fromTile: `${W}:0:0`, toTile: `${W}:5:5`,
    kind: 'occupy', troops: TROOPS, morale: MARCH_MORALE_MAX, departAt: 0, arriveAt: 0,
    path: [], stepIndex: 0, nextStepAt: 0, status: 'marching', rev: 0,
    ...overrides,
  } as unknown as MarchDoc;
}

function playerWorld(overrides: Partial<PlayerWorldDoc> = {}): PlayerWorldDoc {
  return { _id: `${W}:${ACC}`, worldId: W, accountId: ACC, cardState: {}, ...overrides } as unknown as PlayerWorldDoc;
}

function fakeCore(getSaveFields = vi.fn(async (..._args: unknown[]): Promise<unknown> => null), updateOne = vi.fn(async (..._args: unknown[]) => ({}))): WorldCore {
  return {
    meta: { getSaveFields },
    deps: { cols: { playerWorld: { updateOne } } },
  } as unknown as WorldCore;
}

describe('resolveOccupationBattle', () => {
  it('flat (no army) march: matches resolveSiege(round(troops * moraleMult), garrison) exactly — the cheap-path contract', async () => {
    const core = fakeCore();
    const m = march();
    const pw = playerWorld();
    const { res } = await resolveOccupationBattle(core, m, pw, GARRISON, /* tileLevel */ 1);
    const expectedAttackerHp = Math.round(sumArmyHp(synthesizeArmy(TROOPS, 'attacker')) * moraleCombatMultiplier(MARCH_MORALE_MAX));
    expect(expectedAttackerHp).toBe(TROOPS); // sanity: full morale + flat army, HP sum == troop count
    expect(res).toEqual(resolveSiege(expectedAttackerHp, GARRISON));
    expect(res.outcome).toBe('attacker_win'); // TROOPS was chosen to overwhelm GARRISON
  });

  it('morale scaling: reduced morale shrinks the effective attacker HP fed into resolveSiege, not the raw troop count', async () => {
    const core = fakeCore();
    const halfMorale = MARCH_MORALE_MAX / 2;
    const m = march({ morale: halfMorale });
    const pw = playerWorld();
    const { res } = await resolveOccupationBattle(core, m, pw, GARRISON, 1);
    const expectedAttackerHp = Math.round(sumArmyHp(synthesizeArmy(TROOPS, 'attacker')) * moraleCombatMultiplier(halfMorale));
    expect(expectedAttackerHp).toBeLessThan(TROOPS); // morale actually reduced the effective strength
    expect(res).toEqual(resolveSiege(expectedAttackerHp, GARRISON));
  });

  it('replay.defenderConfig.defenderBaseHp is wired from npcBaseHp(tileLevel), not a flat constant', async () => {
    const core = fakeCore();
    const m = march();
    const pw = playerWorld();
    const { replay: replayL1 } = await resolveOccupationBattle(core, m, pw, GARRISON, 1);
    const { replay: replayL5 } = await resolveOccupationBattle(core, m, pw, GARRISON, 5);
    expect((replayL1.defenderConfig as { defenderBaseHp: number }).defenderBaseHp).toBe(npcBaseHp(1));
    expect((replayL5.defenderConfig as { defenderBaseHp: number }).defenderBaseHp).toBe(npcBaseHp(5));
    expect(npcBaseHp(5)).toBeGreaterThan(npcBaseHp(1)); // sanity: higher level really is a harder base
  });

  it('replay.seed is deterministic from the march id (siegeSeedFromId), not re-rolled per call', async () => {
    const core = fakeCore();
    const m = march({ _id: 'fixed-march-id' });
    const pw = playerWorld();
    const { replay: first } = await resolveOccupationBattle(core, m, pw, GARRISON, 1);
    const { replay: second } = await resolveOccupationBattle(core, m, pw, GARRISON, 1);
    expect(first.seed).toBe(siegeSeedFromId('fixed-march-id'));
    expect(second.seed).toBe(first.seed);
  });

  it('a card army resolves via meta.getSaveFields(ownerId) exactly once, not the flat-troop synthesized path', async () => {
    const getSaveFields = vi.fn(async (..._args: unknown[]) => ({ cardInv: {}, equipmentInv: {} }));
    const core = fakeCore(getSaveFields);
    const m = march({ army: [{ cardInstanceId: 'card-1', col: 0, row: 0 }] as never });
    const pw = playerWorld({ cardState: { 'card-1': { currentTroops: 50 } } as never });
    await resolveOccupationBattle(core, m, pw, GARRISON, 1);
    expect(getSaveFields).toHaveBeenCalledTimes(1);
    expect(getSaveFields.mock.calls[0]![0]).toBe(ACC);
  });

  it('no card army → meta.getSaveFields is never called (flat/legacy path skips the round-trip)', async () => {
    const getSaveFields = vi.fn(async (..._args: unknown[]) => null);
    const core = fakeCore(getSaveFields);
    const m = march();
    const pw = playerWorld();
    await resolveOccupationBattle(core, m, pw, GARRISON, 1);
    expect(getSaveFields).not.toHaveBeenCalled();
  });
});

describe('writeOccupyCardState', () => {
  const cardArmy = [{ cardInstanceId: 'c1', col: 0, row: 0 }, { cardInstanceId: 'c2', col: 1, row: 0 }] as never;

  it('writes exactly the $set computeCardStateUpdates produces for a card army with deployed troops', async () => {
    const updateOne = vi.fn(async (..._args: unknown[]) => ({}));
    const core = fakeCore(undefined, updateOne);
    const m = march({ army: cardArmy });
    const pw = playerWorld({ cardState: { c1: { currentTroops: 40 }, c2: { currentTroops: 60 } } as never });
    const survivors = 50;
    const nowMs = 1_700_000_000_000;
    await writeOccupyCardState(core, m, pw, survivors, nowMs);

    const expectedUpdates = computeCardStateUpdates(cardArmy, pw.cardState ?? {}, survivors, nowMs);
    const expectedSet: Record<string, unknown> = {};
    for (const [id, u] of Object.entries(expectedUpdates)) {
      expectedSet[`cardState.${id}.currentTroops`] = u.currentTroops;
      expectedSet[`cardState.${id}.injuredUntil`] = u.injuredUntil ?? null;
    }
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: pw._id },
      { $set: expectedSet, $inc: { rev: 1 } },
    );
  });

  it('a flat (non-card) army never writes cardState — computeCardStateUpdates returns empty, no-op', async () => {
    const updateOne = vi.fn(async (..._args: unknown[]) => ({}));
    const core = fakeCore(undefined, updateOne);
    const m = march(); // no army entries at all
    const pw = playerWorld();
    await writeOccupyCardState(core, m, pw, 50, Date.now());
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('a card army with zero deployed troops on every card is also a no-op (nothing to update)', async () => {
    const updateOne = vi.fn(async (..._args: unknown[]) => ({}));
    const core = fakeCore(undefined, updateOne);
    const m = march({ army: cardArmy });
    const pw = playerWorld({ cardState: { c1: { currentTroops: 0 }, c2: { currentTroops: 0 } } as never });
    await writeOccupyCardState(core, m, pw, 50, Date.now());
    expect(updateOne).not.toHaveBeenCalled();
  });
});
