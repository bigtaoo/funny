// The four engine-blueprint READERS in `game/meta/cardDefs.ts` — `cardHp`, `cardAttack`,
// `cardSiegeValue` and `cardSiegeValueEffective` — which back the roster list cells
// (`CardScene/rosterCell.ts`) and the card-detail modal (`CardScene/detail.ts`).
//
// Why they need a suite of their own (2026-09-10, found by the FN/FNDA sweep in
// claudedocs/client-testing.md): all four sit inside `coverage.include` via `src/game/**`, and
// all four were called by **no coverage-reporting test in the repo**. The one suite that touched
// them, `test/ui/cardDetailSiegeValue.ui.ts`, lives in test/ui (no coverage reported) AND spells
// its expectations as `` `Siege: 0 (${cardSiegeValue(LENA)} per 60 troops)` `` — i.e. it pins the
// panel's TEXT against the function's own output, so it stays green for any value the function
// returns. The numbers these three lines show a player were therefore gated by nothing at all.
//
// What this file gates is not the values (those belong to ECONOMY_NUMBERS §6 and the engine's own
// balance suites) but the three seams that fail SILENTLY:
//
//   1. `def.unitType as UnitType` is an UNCHECKED cast, and the lookup behind it ends in `?? 0`.
//      A card whose `unitType` is not an engine `UnitType` key does not throw — the roster simply
//      renders "HP 0 / ATK 0 / Siege 0" for that hero, which reads as a data problem, not a bug.
//      Adding a card or renaming a UnitType is exactly how you get there.
//   2. `fromFp()` is the ADR-065 choke point. Drop it and every number goes up by FP_SCALE
//      (=1000): HP 60 becomes 60000. Loud to a human, invisible to CI.
//   3. `cardSiegeValueEffective` claims in its doc comment to mirror the engine `Unit`
//      constructor's ADR-069 scaling. Nothing checked that claim; the engine does it in fp and
//      the client in floats, so they are two implementations of one formula.
//
// Plus the three-way source agreement in the last describe — the engine blueprint's `siegeValue`
// and the shared catalogue's `siegeValueBase` are held together today by the words "mirrors
// CARD_DEFS" in a comment.
import { describe, it, expect } from 'vitest';
import {
  CARD_DEFS,
  cardHp,
  cardAttack,
  cardSiegeValue,
  cardSiegeValueEffective,
  type CardDef,
} from '../src/game/meta/cardDefs';
import { UnitType, FP_SCALE, fromFp } from '@nw/engine';
import { UNIT_BLUEPRINTS, SIEGE_TROOPS_PER_UNIT } from '@nw/engine/config';
import { toFp, mulFp, divFp } from '@nw/engine/math/fixed';
import { CARD_DEFS as SHARED_DEFS, MAX_CARD_LEVEL, cardSiegeValue as sharedCardSiegeValue } from '@nw/shared/cards';
import type { CardInstance } from '../src/game/meta/SaveData';

const CARD_IDS = Object.keys(CARD_DEFS);

function card(defId: string, level = 1): CardInstance {
  return { id: 'c1', defId, level, xp: 0, gear: {}, locked: false } as CardInstance;
}

/** The same card in the SHARED catalogue's instance shape (its own `CardInstance`, no `xp`). */
function sharedCard(defId: string, level: number): Parameters<typeof sharedCardSiegeValue>[0] {
  return { id: 'c1', defId, level, gear: {}, locked: false };
}

/** The engine's own ADR-069 arrival damage for a bottom-side unit carrying `troops`, in real units. */
function engineArrivalDamage(unitType: string, troops: number): number {
  const bp = UNIT_BLUEPRINTS[unitType as UnitType];
  return fromFp(mulFp(bp.siegeValue_fp, divFp(toFp(troops), toFp(SIEGE_TROOPS_PER_UNIT))));
}

describe('every CARD_DEFS unitType resolves to a real engine blueprint', () => {
  // Non-vacuity for the whole file: every loop below is over CARD_IDS, so an empty catalogue
  // would turn this suite into a no-op that still reports green.
  it('the catalogue is populated (guards every per-card loop in this file)', () => {
    expect(CARD_IDS.length).toBeGreaterThanOrEqual(6);
    expect(CARD_IDS).toEqual(Object.keys(SHARED_DEFS));
  });

  it('all four readers return a positive number for every card — the `?? 0` arm is never taken', () => {
    for (const id of CARD_IDS) {
      const c = card(id);
      expect(cardHp(c), `${id} hp`).toBeGreaterThan(0);
      expect(cardAttack(c), `${id} atk`).toBeGreaterThan(0);
      expect(cardSiegeValue(c), `${id} siege`).toBeGreaterThan(0);
      expect(cardSiegeValueEffective(c, SIEGE_TROOPS_PER_UNIT), `${id} siege eff`).toBeGreaterThan(0);
    }
  });

  it('an unknown defId reads 0 everywhere (forward-compat: a save from a newer build)', () => {
    const ghost = card('not_a_card');
    expect(cardHp(ghost)).toBe(0);
    expect(cardAttack(ghost)).toBe(0);
    expect(cardSiegeValue(ghost)).toBe(0);
    expect(cardSiegeValueEffective(ghost, 300)).toBe(0);
  });

  it('a unitType the engine does not know reads 0 too — this is what the guard above is guarding', () => {
    // The failure mode spelled out: `as UnitType` cannot catch this at compile time, and nothing
    // downstream throws, so the roster would show a hero with three zeroes and no error anywhere.
    const bogus: CardDef = { ...CARD_DEFS[CARD_IDS[0]!]!, id: 'bogus', unitType: 'catapult' };
    CARD_DEFS['bogus'] = bogus;
    try {
      const c = card('bogus');
      expect(cardHp(c)).toBe(0);
      expect(cardAttack(c)).toBe(0);
      expect(cardSiegeValue(c)).toBe(0);
      expect(cardSiegeValueEffective(c, 300)).toBe(0);
    } finally {
      delete CARD_DEFS['bogus'];
    }
    expect(Object.keys(CARD_DEFS)).toEqual(CARD_IDS);
  });
});

describe('ADR-065 fp choke point: the readers convert to real units', () => {
  it('each reader equals fromFp() of its blueprint field, per card', () => {
    for (const id of CARD_IDS) {
      const bp = UNIT_BLUEPRINTS[CARD_DEFS[id]!.unitType as UnitType];
      expect(cardHp(card(id)), `${id} hp`).toBe(fromFp(bp.hp_fp));
      expect(cardAttack(card(id)), `${id} atk`).toBe(fromFp(bp.attack_fp));
      expect(cardSiegeValue(card(id)), `${id} siege`).toBe(fromFp(bp.siegeValue_fp));
    }
  });

  it('the conversion is not the identity, so dropping fromFp() would fail the case above', () => {
    // Without this, "equals fromFp(bp.hp_fp)" would also hold for a FP_SCALE of 1 — i.e. the
    // assertion would survive the exact regression it exists to catch.
    expect(FP_SCALE).toBeGreaterThan(1);
    for (const id of CARD_IDS) {
      const bp = UNIT_BLUEPRINTS[CARD_DEFS[id]!.unitType as UnitType];
      expect(cardHp(card(id)), `${id} raw fp leaked`).not.toBe(bp.hp_fp);
    }
  });

  it('level does not enter any of the three blueprint readers (they are per-unit-type baselines)', () => {
    // rosterCell/detail label these lines with no level qualifier, and DefenseEditorScene's grid
    // comment leans on "same basis as cardHp()" for its troop-allocation baseline.
    for (const id of CARD_IDS) {
      for (const level of [1, 5, MAX_CARD_LEVEL]) {
        expect(cardHp(card(id, level)), `${id} @${level}`).toBe(cardHp(card(id)));
        expect(cardAttack(card(id, level)), `${id} @${level}`).toBe(cardAttack(card(id)));
        expect(cardSiegeValue(card(id, level)), `${id} @${level}`).toBe(cardSiegeValue(card(id)));
      }
    }
  });
});

describe('cardSiegeValueEffective mirrors the engine Unit constructor (ADR-069)', () => {
  const TROOP_COUNTS = [1, 25, SIEGE_TROOPS_PER_UNIT, 100, 300, 1000];

  it('matches the engine fp computation (rounded) for every card at every troop count', () => {
    for (const id of CARD_IDS) {
      const unitType = CARD_DEFS[id]!.unitType;
      for (const troops of TROOP_COUNTS) {
        expect(cardSiegeValueEffective(card(id), troops), `${id} @ ${troops} troops`)
          .toBe(Math.round(engineArrivalDamage(unitType, troops)));
      }
    }
  });

  it('troops actually move the number — the panel would be lying if they did not', () => {
    // Non-vacuity for the case above: if every card's scaling collapsed to the flat rating (the
    // pre-ADR-069 behaviour) the per-troop-count loop would still pass on the rating alone.
    const varied = CARD_IDS.filter((id) => {
      const rating = cardSiegeValue(card(id));
      return TROOP_COUNTS.some((t) => cardSiegeValueEffective(card(id), t) !== rating);
    });
    expect(varied).toEqual(CARD_IDS);
  });

  it('a card at exactly SIEGE_TROOPS_PER_UNIT troops deals its unscaled rating', () => {
    for (const id of CARD_IDS) {
      expect(cardSiegeValueEffective(card(id), SIEGE_TROOPS_PER_UNIT), id).toBe(cardSiegeValue(card(id)));
    }
  });

  it('scales linearly upward with no cap, and clamps a negative troop count to 0', () => {
    for (const id of CARD_IDS) {
      const rating = cardSiegeValue(card(id));
      expect(cardSiegeValueEffective(card(id), SIEGE_TROOPS_PER_UNIT * 10), id).toBe(rating * 10);
      expect(cardSiegeValueEffective(card(id), 0), id).toBe(0);
      expect(cardSiegeValueEffective(card(id), -5), id).toBe(0);
    }
  });
});

describe('the two siege sources agree on the base, and the two cardSiegeValue()s deliberately do not', () => {
  it('engine blueprint siegeValue equals the shared catalogue siegeValueBase for every card', () => {
    // blueprintDefs.ts annotates each of these with "(mirrors CARD_DEFS)"; that comment is the
    // only thing that has ever held the two tables together. Drift is silent and asymmetric: the
    // roster panel reads the ENGINE number, while SLG city siege (shared/slg/siege.ts
    // teamSiegeValue) resolves the SHARED one — so a rebalance applied to one table shows the
    // player a siege rating the world map does not use.
    for (const id of CARD_IDS) {
      const engineBase = fromFp(UNIT_BLUEPRINTS[CARD_DEFS[id]!.unitType as UnitType].siegeValue_fp);
      expect(engineBase, `${id}: engine blueprint vs shared siegeValueBase`)
        .toBe(SHARED_DEFS[id]!.siegeValueBase);
    }
  });

  it('client cardSiegeValue() is level-invariant and shared cardSiegeValue() is not — same name, two formulas', () => {
    // Pinned so nobody "unifies" them: the client's is a lane-battle blueprint rating scaled by
    // TROOPS (ADR-069), the shared one is an SLG city-siege value scaled by card LEVEL and gear.
    // They coincide only at level 1 with no gear, which is why the divergence is easy to miss.
    let levelSensitiveOnShared = 0;
    for (const id of CARD_IDS) {
      expect(cardSiegeValue(card(id, 1)), id).toBe(sharedCardSiegeValue(sharedCard(id, 1)));
      for (const level of [5, MAX_CARD_LEVEL]) {
        expect(cardSiegeValue(card(id, level)), `${id} client @${level}`).toBe(cardSiegeValue(card(id, 1)));
        if (sharedCardSiegeValue(sharedCard(id, level)) !== sharedCardSiegeValue(sharedCard(id, 1))) {
          levelSensitiveOnShared++;
        }
      }
    }
    expect(levelSensitiveOnShared).toBe(CARD_IDS.length * 2);
  });
});
