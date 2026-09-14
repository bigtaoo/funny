// settleCityDamage (combatSiege/cityDamage.ts) — the three exits of its rev-CAS loop, plus the
// continue-the-siege decision the 2026-09-12 user call put on the "wall still stands" branch.
//
// Why a unit file rather than more cases in city-siege.e2e.test.ts: that suite has forty cases and covers
// the ladder, the hit, the capture, the announcements and every staleness rule, but every one of them
// drives a real Mongo where the CAS always wins on the first attempt. The loop's other three ways out —
// the wall survives, the write loses the race five times, the city document disappears between attempts —
// are unreachable from there and were at 0 executions on 2026-09-14 (cityDamage.ts branch 73.68%, the
// lowest in worldsvc's siege tree). Same hand-built-WorldCore style as
// combatSiege-damage-helpers-gaps.test.ts; real @nw/shared formulas, no Mongo.
//
// What is at stake in each: the continue branch is the difference between a siege that grinds a city down
// over rounds and one that quietly ends after the first hit (the pre-2026-09-12 behaviour, which still
// looks entirely normal from the outside). The two loss branches are the difference between the besieging
// force walking home and it disappearing — the hold document is already claimed and deleted by the caller,
// so anything that returns without dispatching a march has silently eaten the team.
import { describe, expect, it, vi } from 'vitest';
import { cityDurabilityMax, SLG_TEAM_STAMINA_MAX } from '@nw/shared';
import { settleCityDamage } from '../src/combatSiege/cityDamage';
import type { WorldCore } from '../src/core';
import type { CityDoc, MarchDoc, PlayerWorldDoc, SiegeDamageDoc } from '../src/db';

const W = 'w1';
const ATK = 'atk-1';
const SECT = 'sect-a';
const CITY_ID = `city:${W}:garrison-1`;
const TILE = `${W}:40:41`;
const T = 5_000_000;

function city(over: Partial<CityDoc> = {}): CityDoc {
  const level = 1;
  const kind = 'garrison';
  return {
    _id: CITY_ID, worldId: W, nodeId: 'garrison-1', kind, x: 40, y: 41, level, footprint: 3,
    durability: cityDurabilityMax(level, kind), durabilityMax: cityDurabilityMax(level, kind),
    durabilityRegenAt: T, regenPerHour: 0, rev: 7,
    ...over,
  } as unknown as CityDoc;
}

/** The attacker's world state. No `mainBaseTile`, so a walk-home lands on startReturnMarch's own
 *  documented instant-refund fallback — which keeps these cases off the pathfinder. */
function pw(over: Partial<PlayerWorldDoc> = {}): PlayerWorldDoc {
  return {
    _id: `${W}:${ATK}`, worldId: W, accountId: ATK, troops: 100, troopCap: 500,
    resources: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
    yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
    lastTickAt: 0, rev: 1, sectId: SECT,
    teamState: { t1: { stamina: SLG_TEAM_STAMINA_MAX, staminaAt: 0 } },
    ...over,
  } as unknown as PlayerWorldDoc;
}

function dmg(over: Partial<SiegeDamageDoc> = {}): SiegeDamageDoc & { cityId: string } {
  return {
    _id: 'siege-1', worldId: W, attackerId: ATK, tile: TILE, isBase: false,
    cityId: CITY_ID, attackerSectId: SECT, damage: 50, attackerSurvivors: 60,
    dueAt: T, teamId: 't1',
    ...over,
  } as unknown as SiegeDamageDoc & { cityId: string };
}

function fakeCore(opts: {
  cities: { findOne: ReturnType<typeof vi.fn>; updateOne: ReturnType<typeof vi.fn> };
  pw?: PlayerWorldDoc | null;
}) {
  const marchInsert = vi.fn(async (..._args: unknown[]) => ({ insertedId: 'm1' }));
  const pwUpdate = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
  const core = {
    marchSeq: 0,
    coordX: (tile: string) => Number(tile.split(':')[1]),
    coordY: (tile: string) => Number(tile.split(':')[2]),
    settle: vi.fn(() => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 })),
    recomputeSectPayoff: vi.fn(async () => {}),
    pushOrderEnded: vi.fn(),
    pushMarch: vi.fn(),
    marchView: vi.fn(),
    deps: {
      cols: {
        cities: opts.cities,
        marches: { insertOne: marchInsert },
        playerWorld: { findOne: vi.fn(async () => (opts.pw === undefined ? pw() : opts.pw)), updateOne: pwUpdate },
        sects: { findOne: vi.fn(async () => ({ _id: SECT, name: 'A' })) },
      },
    },
  } as unknown as WorldCore;
  return { core, marchInsert, pwUpdate };
}

/** The march documents this settlement inserted, by kind. */
const inserted = (m: ReturnType<typeof vi.fn>): MarchDoc[] => m.mock.calls.map((c) => c[0] as MarchDoc);

describe('settleCityDamage — the wall survives the hit', () => {
  it('opens the next round on the city instead of walking the besiegers home', async () => {
    // 2026-09-12 user decision, the city half of it: "a city ladder that survives one hit has not been
    // taken". Before that this branch called returnSurvivors, and the difference is invisible in any
    // assertion about the city document — the durability write is identical either way.
    const updateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
    const { core, marchInsert } = fakeCore({
      cities: { findOne: vi.fn(async () => city()), updateOne },
    });
    await settleCityDamage(core, dmg(), T);

    const marches = inserted(marchInsert);
    expect(marches).toHaveLength(1);
    // A round is a zero-length attack leg that is already due — it re-enters the whole arrival pipeline
    // rather than hand-rolling a second durability hit. A 'return' here would be the old behaviour.
    expect(marches[0]).toMatchObject({
      kind: 'attack', fromTile: TILE, toTile: TILE, arriveAt: T, departAt: T, teamId: 't1',
    });
    // ...and the durability write really did land first, so the round is opened against a damaged wall.
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it('ends the siege when the team has no stamina left for another round', async () => {
    // The stop condition the player plans around. It lives in startNextSiegeRound, but this is the call
    // site that decides whether that function is consulted at all, so the city path has to show it too.
    const { core, marchInsert } = fakeCore({
      cities: { findOne: vi.fn(async () => city()), updateOne: vi.fn(async () => ({ matchedCount: 1 })) },
      pw: pw({ teamState: { t1: { stamina: 0, staminaAt: T } } } as never),
    });
    await settleCityDamage(core, dmg(), T);
    // No mainBaseTile on the fixture → the walk home degrades to the instant refund, so what is asserted
    // is the negative: no further attack round was dispatched.
    expect(inserted(marchInsert).filter((m) => m.kind === 'attack')).toHaveLength(0);
  });
});

describe('settleCityDamage — the durability write loses the rev race', () => {
  it('gives up after MAX_ATTEMPTS(5) and still sends the besiegers home', async () => {
    // The adversarial fake: every CAS misses and every refetch hands back the same rev, so all five
    // attempts lose. Without the give-up tail this would spin or, worse, return having neither written
    // the damage nor dispatched the force that is standing on the city with its hold already deleted.
    const updateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 0 }));
    const findOne = vi.fn(async () => city());
    const { core, marchInsert, pwUpdate } = fakeCore({ cities: { findOne, updateOne } });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(settleCityDamage(core, dmg(), T)).resolves.toBeUndefined();
      expect(updateOne).toHaveBeenCalledTimes(5);
      expect(errSpy).toHaveBeenCalledWith(
        '[worldsvc] settleCityDamage: durability write lost the rev race every attempt',
        expect.objectContaining({ city: CITY_ID }),
      );
      // Home, not another round: a siege whose hit never landed has nothing to continue against.
      expect(inserted(marchInsert).filter((m) => m.kind === 'attack')).toHaveLength(0);
      // The 60 survivors are credited back rather than lost with the deleted hold.
      const set = pwUpdate.mock.calls.at(-1)![1] as { $set?: { troops?: number } };
      expect(set.$set?.troops).toBe(160);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('bails out at once when the city document vanishes between attempts', async () => {
    // World reset, or a season re-init, under a pending hit. The refetch is the only place that notices.
    const updateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 0 }));
    const findOne = vi.fn()
      .mockResolvedValueOnce(city())   // the initial read
      .mockResolvedValueOnce(null);    // the refetch after the first lost race
    const { core, marchInsert, pwUpdate } = fakeCore({ cities: { findOne, updateOne } });
    await settleCityDamage(core, dmg(), T);
    // One attempt, then out — not five against a city that no longer exists.
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(inserted(marchInsert).filter((m) => m.kind === 'attack')).toHaveLength(0);
    expect(pwUpdate).toHaveBeenCalled(); // the force still came home
  });
});
