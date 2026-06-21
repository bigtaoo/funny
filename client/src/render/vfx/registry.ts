/**
 * vfx/registry.ts — merge per-effect JSON files into an id → EffectDef map.
 *
 * Per-effect files (design §7, decision: per-effect file + build merge) live
 * in effects/. Add a new effect = drop a JSON in effects/ and register it here.
 */
import { EffectDef } from './types';

import hit from './effects/hit.json';
import death_unit from './effects/death_unit.json';
import death_building from './effects/death_building.json';
import spawn from './effects/spawn.json';

// Cast via unknown: the JSON-inferred type widens `ease` to string, which is
// not directly assignable to the Ease union (validated at runtime instead).
const ALL: EffectDef[] = [
  hit as unknown as EffectDef,
  death_unit as unknown as EffectDef,
  death_building as unknown as EffectDef,
  spawn as unknown as EffectDef,
];

export const EFFECTS: Readonly<Record<string, EffectDef>> = Object.freeze(
  ALL.reduce<Record<string, EffectDef>>((acc, def) => {
    acc[def.id] = def;
    return acc;
  }, {}),
);
