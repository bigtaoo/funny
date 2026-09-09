/**
 * equipmentFormulaParity.test.ts — the client's equipment catalogue/economy mirror
 * (`src/game/meta/equipmentDefs.ts`) must agree, value for value, with the server-authoritative
 * `server/shared/src/equipment.ts`.
 *
 * Why this file exists: the client keeps a HAND-COPIED duplicate of that module's pure half, and
 * every function in it says so in its own doc comment ("same formula as server/shared enhanceX",
 * "keep in sync with server/shared/src/equipment.ts"). Until now nothing checked the claim, and
 * measured on 2026-09-09 the client copy was at 63.1% with SEVEN of its nine functions never
 * called by any test in the repo (`getEquipDef`, `isSalvageable`, `enhanceSuccessRate`,
 * `enhanceDemoteChance`, `enhanceCost`, `salvageRefund`, `reforgeCoinCost`) — while the server side
 * is thoroughly covered (server/shared/test/equipment.test.ts plus two metaserver unit suites and
 * an e2e). So the tested half and the untested half were free to drift apart.
 *
 * Drift here is invisible in the way that matters: the server stays authoritative (it charges and
 * it rolls the dice), so nothing errors and nothing crashes — the UI just tells the player
 * something that is not true. A stale client rate shows "+7 → 30%" while the server rolls 20%; a
 * stale craft cost makes the salvage preview promise 3 scrap where the server pays 2; a stale coin
 * fee greys out (or lights up) the reforge button against the wrong balance. All three read as bad
 * luck or a server bug, and none of them is visible to whoever edits one file and not the other.
 * The `+4 binding` threshold in `enhanceCost` is the concrete precedent: it moved from +6 to +4 on
 * 2026-08-02, in two files, by hand.
 *
 * What this test does NOT claim, on purpose:
 *   - It does not pin balance VALUES. Changing a rate or a cost on both sides is a legitimate
 *     designer action and stays green here; the numbers themselves are the server suite's subject
 *     (and ECONOMY_NUMBERS's). This file only answers "do the two sources still say the same thing".
 *   - It does not make the client authoritative. The mirror exists for previews and button gating;
 *     `rollEnhanceSuccess`/`rollEnhanceDemote` are server-only and are deliberately not mirrored.
 *
 * Not every export is a parity subject: `craftableDefs()` (forge-grid ordering) and `affixKind()`
 * are client-side presentation with no server twin, and are covered by test/equipmentDefs.test.ts.
 *
 * Imported by relative path rather than through a `@nw/shared/equipment` alias (the shape
 * `@nw/shared/cards` has): five client suites already reach into `../../server` this way, and an
 * alias would advertise an import path to `src/**` that nobody has cleared for the browser bundle.
 * FOLLOW-UP worth its own task: `equipment.ts` turns out to have ZERO imports — the mirror's header
 * says `@nw/shared` "pulls in mongodb/jsonwebtoken", which is true of the barrel but not of this
 * file, so the duplication itself may be removable the way `cards.ts` was.
 */
import { describe, it, expect } from 'vitest';
import * as client from '../src/game/meta/equipmentDefs';
import * as server from '../../server/shared/src/equipment';

/** Every rarity, including the two with no reforge/salvage entry at all. */
const RARITIES = ['common', 'fine', 'rare', 'epic'] as const;
/** Enhancement domain plus both out-of-range shoulders — the clamp is mirrored code too. */
const LEVELS = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

describe('equipment catalogue parity (client mirror ↔ server/shared)', () => {
  it('has exactly the same defIds', () => {
    expect(Object.keys(client.EQUIPMENT_DEFS).sort()).toEqual(Object.keys(server.EQUIPMENT_DEFS).sort());
    expect(Object.keys(server.EQUIPMENT_DEFS).length).toBeGreaterThan(0); // not a pair of empty tables
  });

  it('describes every def identically (slot, rarity, media, craftCost)', () => {
    for (const [defId, def] of Object.entries(server.EQUIPMENT_DEFS)) {
      // toEqual, not a field-by-field walk: a field ADDED on one side only must fail too.
      expect(client.EQUIPMENT_DEFS[defId], `def ${defId}`).toEqual(def);
    }
  });

  it('resolves defIds the same way, present or absent', () => {
    for (const defId of Object.keys(server.EQUIPMENT_DEFS)) {
      expect(client.getEquipDef(defId), `getEquipDef(${defId})`).toEqual(server.getEquipDef(defId));
    }
    expect(client.getEquipDef('nope_not_a_def')).toBeUndefined();
    expect(server.getEquipDef('nope_not_a_def')).toBeUndefined();
  });

  it('agrees on the shared constants', () => {
    expect(client.EQUIP_MAX_LEVEL).toBe(server.EQUIP_MAX_LEVEL);
    expect(client.EQUIPMENT_INV_CAP).toBe(server.EQUIPMENT_INV_CAP);
    expect(client.SALVAGE_REFUND_RATIO).toBe(server.SALVAGE_REFUND_RATIO);
    expect(client.SALVAGE_MAX_LEVEL).toBe(server.SALVAGE_MAX_LEVEL);
    expect(client.PROTECT_ENHANCE_ITEM_ID).toBe(server.PROTECT_ENHANCE_ITEM_ID);
    expect(client.REFORGE_MATERIAL_RARITY).toEqual(server.REFORGE_MATERIAL_RARITY);
    expect(client.REFORGE_COIN_COST).toEqual(server.REFORGE_COIN_COST);
  });
});

describe('equipment economy parity (client mirror ↔ server/shared)', () => {
  it('computes the same enhancement success rate at every level, including out of range', () => {
    for (const lv of LEVELS) {
      expect(client.enhanceSuccessRate(lv), `enhanceSuccessRate(${lv})`).toBe(server.enhanceSuccessRate(lv));
    }
    // Non-vacuity: the loop must be exercising a real curve, not two functions that both return 0
    // for everything (which is what an off-by-one in the range guard would produce).
    const rates = new Set(LEVELS.map((lv) => server.enhanceSuccessRate(lv)));
    expect(rates.size).toBeGreaterThan(2);
  });

  it('computes the same demote chance at every level', () => {
    for (const lv of LEVELS) {
      expect(client.enhanceDemoteChance(lv), `enhanceDemoteChance(${lv})`).toBe(server.enhanceDemoteChance(lv));
    }
    // Non-vacuity: only +7/+8 demote, so a table of all zeroes means the risk warning is gone.
    expect(LEVELS.some((lv) => server.enhanceDemoteChance(lv) > 0)).toBe(true);
  });

  it('computes the same enhancement cost at every level, materials and coins', () => {
    for (const lv of LEVELS) {
      expect(client.enhanceCost(lv), `enhanceCost(${lv})`).toEqual(server.enhanceCost(lv));
    }
    // Non-vacuity: the material MIX changes with level (scrap → +lead → +binding), and each
    // threshold is a hand-copied `lv >= n` on both sides — the exact shape that drifted before.
    const mixes = new Set(LEVELS.map((lv) => Object.keys(server.enhanceCost(lv).materials).sort().join('+')));
    expect(mixes.size).toBeGreaterThan(2); // scrap / scrap+lead / scrap+lead+binding at least
  });

  it('refunds the same materials for every def, and nothing for an unknown id', () => {
    for (const defId of Object.keys(server.EQUIPMENT_DEFS)) {
      expect(client.salvageRefund(defId), `salvageRefund(${defId})`).toEqual(server.salvageRefund(defId));
    }
    expect(client.salvageRefund('nope_not_a_def')).toEqual({});
    // Non-vacuity: at least one def must actually refund something, or this compares {} to {}.
    expect(Object.keys(server.EQUIPMENT_DEFS).some((d) => Object.keys(server.salvageRefund(d)).length > 0)).toBe(true);
  });

  it('agrees on what may be salvaged, across every rarity × level', () => {
    for (const rarity of RARITIES) {
      for (let lv = 0; lv <= 9; lv += 1) {
        expect(client.isSalvageable(rarity, lv), `isSalvageable(${rarity}, ${lv})`).toBe(server.isSalvageable(rarity, lv));
      }
    }
    // Non-vacuity: both directions must appear, otherwise a function stuck on one answer passes.
    expect(client.isSalvageable('common', 0)).toBe(true);
    expect(client.isSalvageable('epic', 0)).toBe(false);   // ADR-050: epic never salvages
    expect(client.isSalvageable('common', 9)).toBe(false); // above SALVAGE_MAX_LEVEL
  });

  it('charges the same reforge fee for every rarity', () => {
    for (const rarity of RARITIES) {
      expect(client.reforgeCoinCost(rarity), `reforgeCoinCost(${rarity})`).toBe(server.reforgeCoinCost(rarity));
    }
    // Non-vacuity: common is not reforgeable (0) while the others are — a table of zeroes would
    // silently turn the reforge affordability gate off.
    expect(client.reforgeCoinCost('common')).toBe(0);
    expect(RARITIES.filter((r) => client.reforgeCoinCost(r) > 0).length).toBeGreaterThan(1);
  });
});
