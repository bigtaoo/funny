// What UnitView.sync / BuildingView.sync actually read — the narrowest structural input each view
// accepts. The live battle feeds the engine `Board` (whose Maps of `Unit` / `Building` satisfy these
// as-is); the dumb state player (REPLAY_SHARE_DESIGN §4.2) feeds plain objects mapped from the state
// stream, with no engine running. Both must type-check without a cast.
//
// Field lists are `Pick`ed from the engine classes, never restated: a hand-written copy once said
// `hp` / `maxHp` where the views read `hp_fp` / `maxHp_fp`, an `as unknown as` cast hid it, and every
// replay HP bar came out NaN. With these types, a view that starts reading a new field fails to
// compile until it is added here, and then every producer that does not provide it fails too.
import type { Unit } from '@nw/engine/Unit';
import type { Building } from '@nw/engine/Building';

/** The unit fields UnitView (and its build/gear helpers) read. Fixed-point HP, exact grid coords. */
export type UnitViewUnit = Pick<Unit,
  'id' | 'unitType' | 'side' | 'colExact' | 'rowExact' | 'hp_fp' | 'maxHp_fp' | 'state' | 'effectiveAttackIntervalTicks'>;

/** UnitView.sync's board: only the live unit map. Engine `Board` satisfies it structurally. */
export interface UnitViewBoard {
  readonly units: ReadonlyMap<number, UnitViewUnit>;
}

/** The building fields BuildingView reads (`side` picks the faction ink). Fixed-point HP. */
export type BuildingViewBuilding = Pick<Building, 'id' | 'buildingType' | 'side' | 'col' | 'row' | 'hp_fp' | 'maxHp_fp'>;

/** BuildingView.sync's board: only the live building map. Engine `Board` satisfies it structurally. */
export interface BuildingViewBoard {
  readonly buildings: ReadonlyMap<number, BuildingViewBuilding>;
}
