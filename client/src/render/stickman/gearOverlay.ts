// ── Equipment overlay (EQUIPMENT_DESIGN §20.4) ─────────────────────────────────
//
// Procedural stationery decals drawn over the figure along the skeleton — the
// battle-render half of "drawing equipment onto the character" (§2/§11). Each equipped slot draws the
// same SketchPen glyph used by the UI icons (`equipmentGlyph.ts`), positioned at a
// bone anchor so it rides the animation. Reuses the per-frame FK already computed
// in {@link StickmanRuntime._applyPose} (no extra sampleClip/computeFK on the swarm
// hot path), and shares one tessellated geometry per (slot × rarity) across every
// unit (12 combos total) so a screenful of equipped units costs 12 geometries, not
// 12 × N. PvP never reaches here — equipment is a PvE-only input (A5 hard wall);
// UnitView only calls setGear() for PLAYER_EQUIPPABLE_UNITS in PvE/siege.

import * as PIXI from 'pixi.js-legacy';
import { drawEquipmentGlyph } from '../equipmentGlyph';
import type { EquipSlot, EquipRarity } from '../../game/meta/SaveData';

/** Where a slot's glyph rides on the skeleton, in animator-local px. */
export interface GearPlacement {
  /** Parent bone whose FK drives the glyph. Falls back to spine→root if missing. */
  bone:   string;
  /** 'tip' = bone end (hand / head); 'mid' = bone midpoint (torso). */
  anchor: 'tip' | 'mid';
  /** Offset from the anchor, animator-local px (un-mirrored; container applies flip). */
  ox:     number;
  oy:     number;
  /** Glyph box edge in animator px (container scale shrinks it to ~¼ on screen). */
  size:   number;
  /** Deterministic pen seed so the scrawl is stable across redraws. */
  seed:   number;
}

/**
 * Default slot → skeleton placement. weapon rides the right (attacking) forearm
 * tip = the drawing hand; armor sits mid-spine = the torso; trinket hangs by the
 * head. Glyphs stay axis-aligned (translate-only) — they read as equipped decals
 * and never look "broken" if a pose swings hard, the conservative choice for a
 * path we can't screenshot-verify. Artist-authored `gear_<slot>` attachment points
 * (if present in the .tao) override `bone`/`ox`/`oy` for fine placement (§20.4).
 */
export const GEAR_PLACEMENT: Record<EquipSlot, GearPlacement> = {
  weapon:  { bone: 'r_lower_arm', anchor: 'tip', ox: 0, oy: 0,  size: 42, seed: 7001 },
  armor:   { bone: 'spine',       anchor: 'mid', ox: 0, oy: 2,  size: 52, seed: 7013 },
  trinket: { bone: 'head',        anchor: 'tip', ox: 6, oy: 0,  size: 26, seed: 7027 },
};

/**
 * Shared glyph geometry per `${slot}:${rarity}` (12 combos). The template Graphics
 * is kept alive in the cache so its tessellated geometry survives; per-unit gear
 * sprites are `new PIXI.Graphics(template.geometry)` — geometry is reference-counted,
 * so destroying a unit's gear sprite never disposes the shared template.
 */
const _gearGeomCache = new Map<string, PIXI.Graphics>();

export function gearTemplate(slot: EquipSlot, rarity: EquipRarity, size: number, seed: number): PIXI.Graphics {
  const key = `${slot}:${rarity}`;
  let tpl = _gearGeomCache.get(key);
  if (!tpl) {
    tpl = new PIXI.Graphics();
    drawEquipmentGlyph(tpl, slot, rarity, size, seed);
    _gearGeomCache.set(key, tpl);
  }
  return tpl;
}
