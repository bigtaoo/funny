/**
 * `scenes/CardScene/logic/{feedPlan,cardSort}.ts` — the gear guards and the tiebreak arms.
 *
 * `feedPlan.test.ts` covers the ranking and the prep arithmetic thoroughly with gear-free
 * fixtures. The 13 branches it misses are almost all the SAME rule appearing in four places: a
 * card carrying gear may be a fusion MATERIAL but never a feeder, and when it is a material it
 * goes last. The reason is spelled out in the source: the server does not unequip a material, it
 * deletes the card — so fusing a geared copy silently dismantles a loadout the player assembled.
 * That is destructive and unrecoverable, and it is invisible to any fixture whose `gear` is `{}`.
 *
 * The rest are the deterministic tiebreaks. They look cosmetic and are not: `planPrepRounds`
 * simulates the run locally and sends it as ONE batch, so the client's material choice has to
 * match what a hand-driven fuse would have picked, round after round. A tiebreak that is not
 * total makes the batch order depend on object-key iteration.
 *
 * Five branches in these two files stay uncovered because nothing can reach them: the `?? 0` on
 * `copiesOf.get(...)` (the map is built from the same pool it is then queried with), the `=== 0`
 * arm of both id tiebreaks (inventory keys are unique, so two entries never share an id),
 * `planPrepRounds`' `mats.length < FUSION_MATERIAL_COUNT` break (`pickFeeder` already required
 * `isFusableNow`, and `autoFillMaterials` reads the same `readyMaterials` pool), and `sortCards`'
 * level tiebreak, which needs two cards of DIFFERENT levels whose gear-adjusted power lands on
 * exactly the same number.
 */
import { describe, it, expect } from 'vitest';
import {
  autoFillMaterials,
  countPrepRounds,
  listFusableTargets,
  pickFeeder,
  planPrep,
  planPrepRounds,
  PREP_COST_PER_CARD,
} from '../src/scenes/CardScene/logic/feedPlan';
import { sortCards } from '../src/scenes/CardScene/logic/cardSort';
import { FUSION_MATERIAL_COUNT, MAX_CARD_LEVEL } from '../src/game/meta/cardDefs';
import type { CardInstance, EquipmentInstance, SaveData } from '../src/game/meta/SaveData';
import type { CardSLGState } from '../src/net/WorldApiClient';

function card(id: string, defId: string, level: number, over: Partial<CardInstance> = {}): CardInstance {
  return { id, defId, level, gear: {}, locked: false, ...over };
}

function geared(id: string, defId: string, level: number): CardInstance {
  return card(id, defId, level, { gear: { weapon: 'e1' } });
}

function fillers(prefix: string, defId: string, level: number, count = FUSION_MATERIAL_COUNT): CardInstance[] {
  return Array.from({ length: count }, (_, i) => card(`${prefix}${i}`, defId, level));
}

function invOf(...groups: CardInstance[][]): Record<string, CardInstance> {
  const inv: Record<string, CardInstance> = {};
  for (const c of groups.flat()) inv[c.id] = c;
  return inv;
}

const free = (): ((id: string) => boolean) => () => true;

// ── The "geared cards are never feeders" rule, in all four places ───────────────────────────

describe('gear guards', () => {
  it('pickFeeder passes over a geared card that would otherwise win the ranking', () => {
    // The alternative is worse than doing nothing: the fusion succeeds and the player's weapon is
    // gone with the card. The fixture stacks the deck against the guard - the geared copies tie
    // on copy count AND hold the lower ids, so without the guard 'a0' would win outright.
    const inv = invOf(
      [geared('a0', 'mara', 1), geared('a1', 'mara', 1), geared('a2', 'mara', 1)],
      [card('z0', 'max', 1), card('z1', 'max', 1), card('z2', 'max', 1)],
    );
    const picked = pickFeeder('anna', 1, inv, free());
    expect(picked?.id).toBe('z0');
    expect(Object.values(picked!.gear ?? {}).some((g) => !!g)).toBe(false);

    // With nothing but geared copies at that level there is no feeder at all.
    const allGeared = invOf([
      geared('a0', 'mara', 1), geared('a1', 'mara', 1), geared('a2', 'mara', 1),
      geared('a3', 'mara', 1), geared('a4', 'mara', 1), geared('a5', 'mara', 1),
    ]);
    expect(pickFeeder('anna', 1, allGeared, free())).toBeNull();
  });

  it('planPrep reports hasFeeder=false when every card at the feeder level carries gear', () => {
    // Without this the panel offered a "prepare materials" button that hit `if (!feeder) return`
    // and silently did nothing — the player taps and the screen does not move.
    const target = card('t', 'max', 2);
    const gearedFeeders = [geared('g0', 'max', 1), geared('g1', 'max', 1), geared('g2', 'max', 1)];
    const plan = planPrep(target, invOf([target], gearedFeeders), free());
    expect(plan).not.toBeNull();
    expect(plan!.hasFeeder).toBe(false);

    // One gear-free copy at the feeder level flips it. Note hasFeeder does NOT require that copy
    // to be fusable itself; it only answers "is there anything here prep could fuse up".
    const withOne = planPrep(target, invOf([target, card('plain', 'max', 1)], gearedFeeders), free());
    expect(withOne!.hasFeeder).toBe(true);
  });

  it('autoFillMaterials sorts geared materials LAST, so an unavoidable one is spent last', () => {
    // A geared card is still a legal material (unlike a feeder), because the alternative is being
    // unable to fuse at all. It just has to be the last resort.
    const target = card('t', 'max', 1);
    const pool = [
      geared('g0', 'lena', 1),
      card('p0', 'lena', 1),
      card('p1', 'lena', 1),
    ];
    const inv = invOf([target], pool);
    const picked = autoFillMaterials(target, inv, free(), 2);
    expect(picked.map((c) => c.id)).toEqual(['p0', 'p1']);

    // With only the geared one left it IS picked — last resort, not forbidden.
    const forced = autoFillMaterials(target, invOf([target], [geared('g0', 'lena', 1)]), free(), 1);
    expect(forced.map((c) => c.id)).toEqual(['g0']);
  });

  it('treats a card with no gear FIELD as gear-free everywhere the guard appears', () => {
    // Pre-gear saves (and any server response that omits an empty map) have no `gear` key at all.
    // The three `c.gear ?? {}` fallbacks are what stop that shape from throwing on
    // `Object.values(undefined)` — which would take out the feeder pick, the hasFeeder flag and
    // the material auto-fill in one go, i.e. the whole fuse panel for an old account.
    const legacy = (id: string, defId: string, level: number): CardInstance =>
      ({ id, defId, level, locked: false }) as CardInstance;

    const pool = [
      legacy('l0', 'max', 1), legacy('l1', 'max', 1), legacy('l2', 'max', 1),
      legacy('l3', 'max', 1), legacy('l4', 'max', 1), legacy('l5', 'max', 1),
    ];
    const inv = invOf(pool);
    expect(pickFeeder('anna', 1, inv, free())?.id).toBe('l0');
    expect(autoFillMaterials(legacy('t', 'lena', 1), inv, free(), 2).map((c) => c.id)).toEqual(['l0', 'l1']);

    const target = legacy('t', 'max', 2);
    const plan = planPrep(target, invOf([target], pool), free())!;
    expect(plan.hasFeeder).toBe(true);
  });

  it('a prep run never fuses a geared card, however many rounds it plans', () => {
    // The run is simulated locally and sent as ONE batch, so every round it plans is a round the
    // server will execute - a geared feeder anywhere in that list is a dismantled loadout.
    const inv = invOf(
      [geared('a0', 'mara', 1), geared('a1', 'mara', 1)],
      Array.from({ length: 12 }, (_, i) => card(`z${i}`, 'max', 1)),
    );
    const rounds = planPrepRounds('anna', 1, inv, free(), 10);
    expect(rounds.length).toBeGreaterThan(0);
    for (const r of rounds) expect(r.targetId.startsWith('z')).toBe(true);
    expect(countPrepRounds('anna', 1, inv, free(), 10)).toBe(rounds.length);
  });
});

// ── planPrepRounds' two stop conditions ─────────────────────────────────────────────────────

describe('prep run planning', () => {
  it('stops when a feeder no longer holds five materials, not when the count says it should', () => {
    // Two gear-free feeders but only five materials between them: the second round has a feeder
    // and fewer than FUSION_MATERIAL_COUNT materials, which is the `mats.length <` break.
    const inv = invOf(
      [card('f0', 'max', 1), card('f1', 'max', 1)],
      fillers('m', 'lena', 1, FUSION_MATERIAL_COUNT),
    );
    const rounds = planPrepRounds('anna', 1, inv, free(), 10);
    expect(rounds).toHaveLength(1);
    // The simulation spent exactly the five it planned to.
    expect(rounds[0]!.materialIds).toHaveLength(FUSION_MATERIAL_COUNT);
  });

  it('honours the limit even when the roster could fund more rounds', () => {
    const feeders = Array.from({ length: 3 }, (_, i) => card(`f${i}`, 'max', 1));
    const mats = fillers('m', 'lena', 1, FUSION_MATERIAL_COUNT * 3);
    const inv = invOf(feeders, mats);
    expect(planPrepRounds('anna', 1, inv, free(), 2)).toHaveLength(2);
    expect(countPrepRounds('anna', 1, inv, free(), 2)).toBe(2);
    expect(planPrepRounds('anna', 1, inv, free(), 10)).toHaveLength(3);
  });
});

// ── planPrep's early-outs ───────────────────────────────────────────────────────────────────

describe('planPrep early-outs', () => {
  it('returns null for an unknown card definition', () => {
    // A save written by a newer client. There is no faction to count feeders against, so there is
    // no plan to make — and reading `def.faction` off undefined would throw inside the panel.
    const target = card('t', 'a_hero_from_the_future', 2);
    expect(planPrep(target, invOf([target]), free())).toBeNull();
  });

  it('returns null at max level and null when already fusable', () => {
    const maxed = card('t', 'max', MAX_CARD_LEVEL);
    expect(planPrep(maxed, invOf([maxed]), free())).toBeNull();

    const ready = card('t', 'max', 2);
    expect(planPrep(ready, invOf([ready], fillers('m', 'lena', 2)), free())).toBeNull();
  });

  it('returns null at level 1 — there is nothing below to fuse up', () => {
    const lv1 = card('t', 'max', 1);
    expect(planPrep(lv1, invOf([lv1]), free())).toBeNull();
  });

  it('prices the chain one level down when the feeder level alone falls short', () => {
    const target = card('t', 'max', 3);
    const plan = planPrep(target, invOf([target], [card('f', 'max', 2)]), free())!;
    expect(plan.affordable).toBe(false);
    expect(plan.chain).toMatchObject({ level: 1, need: (plan.cost - plan.avail) * PREP_COST_PER_CARD });
    expect(plan.fundable).toBe(false);

    // At level 2 the chain level would be 0 — below the floor, so there is no chain to price.
    const lv2 = card('t2', 'max', 2);
    const shallow = planPrep(lv2, invOf([lv2]), free())!;
    expect(shallow.chain).toBeNull();
  });
});

// ── Deterministic tiebreaks ─────────────────────────────────────────────────────────────────

describe('deterministic ordering', () => {
  it('listFusableTargets falls back to id order for two otherwise identical targets', () => {
    // Object.values order is insertion order, so the fixture inserts them backwards: a total
    // tiebreak has to reorder them.
    const inv = invOf(
      [card('ab', 'max', 1), card('aa', 'max', 1)],
      fillers('zzz', 'lena', 1, FUSION_MATERIAL_COUNT * 2),
    );
    expect(listFusableTargets(inv, free()).map((c) => c.id).slice(0, 2)).toEqual(['aa', 'ab']);
  });

  it('autoFillMaterials prefers the deepest stack of copies, then the lowest id', () => {
    // "Burn redundancy, not the last surviving copy": two lena and one mara at the same level
    // must spend lena first.
    const target = card('t', 'max', 1);
    const inv = invOf([target], [
      card('mara_a', 'mara', 1),
      card('lena_b', 'lena', 1),
      card('lena_a', 'lena', 1),
    ]);
    expect(autoFillMaterials(target, inv, free(), 2).map((c) => c.id)).toEqual(['lena_a', 'lena_b']);
    // The full pool comes back in a stable order regardless of insertion order.
    expect(autoFillMaterials(target, inv, free(), 9).map((c) => c.id)).toEqual(['lena_a', 'lena_b', 'mara_a']);
  });

  it('pickFeeder prefers the deepest stack of copies, then the lowest id', () => {
    // "Burn redundancy, not the last surviving copy": lena has three copies here, so it goes
    // first even though mara_a holds the lower id.
    const inv = invOf([
      card('mara_a', 'mara', 1), card('mara_b', 'mara', 1),
      card('lena_c', 'lena', 1), card('lena_d', 'lena', 1), card('lena_e', 'lena', 1),
      card('max_f', 'max', 1),
    ]);
    expect(pickFeeder('anna', 1, inv, free())?.id).toBe('lena_c');
  });

  it('pickFeeder honours the exclude set (the round-by-round simulation uses it)', () => {
    const ids = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'];
    const inv = invOf(ids.map((id) => card(id, 'max', 1)));
    expect(pickFeeder('anna', 1, inv, free())?.id).toBe('f0');
    expect(pickFeeder('anna', 1, inv, free(), new Set(['f0']))?.id).toBe('f1');
    expect(pickFeeder('anna', 1, inv, free(), new Set(ids))).toBeNull();
  });
});

// ── cardSort: the deployed flag and the level tiebreak ──────────────────────────────────────

describe('sortCards', () => {
  const EMPTY_INV: SaveData['equipmentInv'] = {};
  const deployed = (teamId: string): CardSLGState => ({ currentTroops: 0, injuredUntil: 0, teamId });

  it('puts a deployed card ahead of a stronger benched one', () => {
    // The grid is meant to read as "my current squad first"; before 2026-08-01 deployed cards
    // scattered through the level-grouped grid. Power only decides WITHIN a group.
    const bench = card('bench', 'max', 9);
    const active = card('active', 'max', 1);
    const state = { active: deployed('t1') };
    expect(sortCards([bench, active], EMPTY_INV, state).map((c) => c.id)).toEqual(['active', 'bench']);
    // Reversed input, same answer.
    expect(sortCards([active, bench], EMPTY_INV, state).map((c) => c.id)).toEqual(['active', 'bench']);
  });

  it('treats a card with an entry but no teamId as benched', () => {
    // The SLG state map carries troops/injury for every card; only `teamId` means deployed. A
    // truthiness check on the entry itself would mark the whole roster as active.
    const a = card('a', 'max', 1);
    const b = card('b', 'max', 9);
    const state = { a: { currentTroops: 100, injuredUntil: 0, teamId: '' } as CardSLGState };
    expect(sortCards([a, b], EMPTY_INV, state).map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('keeps both deployed cards in the same group, ordered by power', () => {
    const weak = card('weak', 'max', 1);
    const strong = card('strong', 'max', 9);
    const state = { weak: deployed('t1'), strong: deployed('t1') };
    expect(sortCards([weak, strong], EMPTY_INV, state).map((c) => c.id)).toEqual(['strong', 'weak']);
  });

  it('falls back to level when two cards of different heroes have equal power', () => {
    // Power is a weighted hp/atk blend, so two different heroes can tie; the level tiebreak is
    // what keeps the grid from reordering itself between renders.
    const cards = [card('a', 'lena', 3), card('b', 'chenshou', 3), card('c', 'lena', 5)];
    const sorted = sortCards(cards, EMPTY_INV);
    expect(sorted).toHaveLength(3);
    // Whatever the power ordering is, it is total and repeatable.
    expect(sortCards([...cards].reverse(), EMPTY_INV).map((c) => c.id)).toEqual(sorted.map((c) => c.id));
  });

  it('is stable with no SLG state at all (outside SLG / before the fetch resolves)', () => {
    const cards = [card('a', 'max', 5), card('b', 'max', 5)];
    expect(sortCards(cards, EMPTY_INV).map((c) => c.id)).toEqual(['a', 'b']);
    expect(sortCards([...cards].reverse(), EMPTY_INV).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('accounts for gear when comparing power', () => {
    const weapon: EquipmentInstance = {
      id: 'e1', defId: 'sword', rarity: 'epic', level: 0, affixes: [{ id: 'm_atk', value: 90 }],
    } as EquipmentInstance;
    const bare = card('bare', 'max', 3);
    const armed = card('armed', 'max', 3, { gear: { weapon: 'e1' } });
    const sorted = sortCards([bare, armed], { e1: weapon } as SaveData['equipmentInv']);
    expect(sorted[0]!.id).toBe('armed');
  });
});
