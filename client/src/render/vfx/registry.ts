/**
 * vfx/registry.ts — merge per-effect JSON files into an id → EffectDef map.
 *
 * Per-effect files (design §7, decision: per-effect file + build merge) live
 * in client/src/effects/ (the vfx-editor exports JSON there; manual drop-in).
 * Add a new effect = drop a JSON in that dir and register it here.
 */
import { EffectDef } from './types';
import { parseEffectDef } from './parseEffectDef';

import hit from '../../effects/hit.json';
import death_unit from '../../effects/death_unit.json';
import death_building from '../../effects/death_building.json';
import spawn from '../../effects/spawn.json';
// P3 spell/Trait effects (design §5). One-shots: meteor/rockslide/bridge_collapse/summon;
// looping (caller stops via handle): haste/aura_heal/slow/shield.
import meteor from '../../effects/meteor.json';
import rockslide from '../../effects/rockslide.json';
import bridge_collapse from '../../effects/bridge_collapse.json';
import haste from '../../effects/haste.json';
import aura_heal from '../../effects/aura_heal.json';
import slow from '../../effects/slow.json';
import summon from '../../effects/summon.json';
import shield from '../../effects/shield.json';

// parseEffectDef validates shape (unknown primitives, malformed tracks, dup ids)
// and narrows the JSON-inferred `ease: string` to the Ease union.
const ALL: EffectDef[] = [
  parseEffectDef(hit, 'hit.json'),
  parseEffectDef(death_unit, 'death_unit.json'),
  parseEffectDef(death_building, 'death_building.json'),
  parseEffectDef(spawn, 'spawn.json'),
  parseEffectDef(meteor, 'meteor.json'),
  parseEffectDef(rockslide, 'rockslide.json'),
  parseEffectDef(bridge_collapse, 'bridge_collapse.json'),
  parseEffectDef(haste, 'haste.json'),
  parseEffectDef(aura_heal, 'aura_heal.json'),
  parseEffectDef(slow, 'slow.json'),
  parseEffectDef(summon, 'summon.json'),
  parseEffectDef(shield, 'shield.json'),
];

export const EFFECTS: Readonly<Record<string, EffectDef>> = Object.freeze(
  ALL.reduce<Record<string, EffectDef>>((acc, def) => {
    acc[def.id] = def;
    return acc;
  }, {}),
);
