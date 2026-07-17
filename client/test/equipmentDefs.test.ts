// Guards craftableDefs() ordering: the forge grid (EquipmentScene/craft.ts) renders items in
// array order with no sort of its own, so a regression here silently re-breaks the grid's
// rarity grouping (commons/fines/rares mixed across rows) without any UI-level signal.
import { describe, it, expect } from 'vitest';
import { craftableDefs } from '../src/game/meta/equipmentDefs';

describe('craftableDefs()', () => {
  it('groups items by rarity (common → fine → rare → epic), not raw catalog order', () => {
    const rarities = craftableDefs().map((d) => d.rarity);
    const order = { common: 0, fine: 1, rare: 2, epic: 3 } as const;
    const weights = rarities.map((r) => order[r]);
    expect(weights).toEqual([...weights].sort((a, b) => a - b));
  });

  it('only includes defs with a craftCost', () => {
    for (const def of craftableDefs()) {
      expect(def.craftCost).toBeDefined();
    }
  });
});
