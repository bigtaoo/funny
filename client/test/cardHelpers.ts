// Shared card-instance builders for the CC-1 blueprint tests.
//
// CC-1 (CHARACTER_CARDS_DESIGN §9) replaced the old blueprint-builder signatures
// `(upgradeLevels, equip, unitLevels)` with `(cardInstances, equipmentInv)`: unit level
// now comes from the best card per unit type, and gear is a per-card slot map (no more
// global/byUnit loadout). These helpers construct the card instances the builders expect,
// mirroring server/engine/src/__tests__/pvp_hardwall.test.ts's `makeCards`.
import { UnitType } from '../src/game/types';
import { PROGRESSABLE_UNITS } from '../src/game/balance/progression';
import type { EngineCardInstance, EngineSlotMap } from '../src/game/balance/equipment';

/** One card instance for a unit type at a given level, with an optional gear slot map. */
export function card(
  unitType: UnitType,
  level = 1,
  gear: EngineSlotMap = {},
): EngineCardInstance {
  return { id: `c_${unitType}`, defId: unitType, unitType, level, gear };
}

/** Card instances for every progressable player unit at the same level (the old `maxedLevels()` analog). */
export function cardsAtLevel(level: number): EngineCardInstance[] {
  return PROGRESSABLE_UNITS.map((ut) => card(ut, level));
}
