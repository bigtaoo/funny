// Guards craftableDefs() ordering: the forge grid (EquipmentScene/craft.ts) renders items in
// array order with no sort of its own, so a regression here silently re-breaks the grid's
// rarity grouping (commons/fines/rares mixed across rows) without any UI-level signal.
//
// `craftableDefs` is one of the two functions left in equipmentDefs.ts with no server twin (the
// other is `affixKind`) — it is presentation order, not economy — which is why it is tested here
// on its own terms. Everything else that file exports is re-exported straight from
// `@nw/shared/equipment` and is covered by server/shared/test/equipment.test.ts; there is no
// longer a second copy for it to drift from.
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
