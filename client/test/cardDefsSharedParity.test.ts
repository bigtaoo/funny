// The client keeps its OWN CardDef catalogue (`client/src/game/meta/cardDefs.ts`) as a deliberate mirror
// of `server/shared/src/cards.ts` — see that file's header for why (no @nw/shared barrel import). A mirror
// is fine while both halves only ever DISPLAY the numbers. It stops being fine the moment the server
// starts ENFORCING one of them, which is what happened on 2026-08-19: `distributeTroops` now rejects an
// allocation past `cardTroopCap(card)` computed from the SHARED table, while the fill/stepper UI computes
// the number it sends from the CLIENT table. Any drift between the two turns into "the button offers 350
// troops and the server refuses them" — a dead end the player cannot diagnose.
//
// So the troop-cap inputs are pinned here, per card, against the shared table. This is a parity test, not
// a value test: it deliberately does not assert what the numbers ARE (that belongs to ECONOMY_NUMBERS §6
// and cardDefs.test.ts), only that both catalogues agree on them, and that neither side has a card the
// other lacks.
import { describe, it, expect } from 'vitest';
import { CARD_DEFS as CLIENT_DEFS, troopCap } from '../src/game/meta/cardDefs';
import { CARD_DEFS as SHARED_DEFS, cardTroopCap, MAX_CARD_LEVEL } from '@nw/shared/cards';
import type { CardInstance } from '../src/game/meta/SaveData';

describe('client CardDef mirror vs @nw/shared/cards', () => {
  it('has exactly the same set of card ids', () => {
    expect(Object.keys(CLIENT_DEFS).sort()).toEqual(Object.keys(SHARED_DEFS).sort());
  });

  it('agrees on troopCapBase / troopCapGrowth for every card — the server enforces these', () => {
    for (const [id, clientDef] of Object.entries(CLIENT_DEFS)) {
      const sharedDef = SHARED_DEFS[id];
      expect(sharedDef, `shared catalogue is missing '${id}'`).toBeDefined();
      expect({ id, base: clientDef.troopCapBase, growth: clientDef.troopCapGrowth }).toEqual({
        id,
        base: sharedDef!.troopCapBase,
        growth: sharedDef!.troopCapGrowth,
      });
    }
  });

  it('client troopCap() and shared cardTroopCap() return the same number at every level', () => {
    for (const id of Object.keys(CLIENT_DEFS)) {
      for (let level = 1; level <= MAX_CARD_LEVEL; level++) {
        const card = { id: 'c1', defId: id, level, xp: 0, gear: {}, locked: false } as CardInstance;
        expect(troopCap(card), `${id} @ level ${level}`).toBe(cardTroopCap({ defId: id, level }));
      }
    }
  });

  it('both clamp an out-of-range level the same way (the UI can hold a level-0 / over-max instance)', () => {
    for (const level of [0, -3, MAX_CARD_LEVEL + 5, 1.7]) {
      const card = { id: 'c1', defId: 'lichuang', level, xp: 0, gear: {}, locked: false } as CardInstance;
      expect(troopCap(card), `level ${level}`).toBe(cardTroopCap({ defId: 'lichuang', level }));
    }
  });

  it('agrees on unitType per card — the blueprint the engine bakes comes from whichever table is read', () => {
    for (const [id, clientDef] of Object.entries(CLIENT_DEFS)) {
      expect(clientDef.unitType, id).toBe(SHARED_DEFS[id]!.unitType);
    }
  });
});
