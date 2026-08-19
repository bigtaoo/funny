// ADR-069 follow-up (2026-08-19): the defense/attack editor's per-card troop bar is drawn in TWO tones —
// the part of the allotment that becomes real battle HP, and the surplus beyond the unit's HP cap that can
// only ever buy base damage (`siegeValue × troops / 60`).
//
// Why it matters: the engine clamps `hp = min(troops, blueprint.hp)`, and card troop caps are far above
// those blueprint values for some unit types (a level-1 lichuang holds 200 troops but fights as a 60-HP
// infantry unit) and below them for others (a level-1 chenshou holds 100 against a 240-HP shieldbearer
// blueprint). A single flat bar showed both as the same "how full is this card" fill, so the two very
// different consequences of adding troops were indistinguishable exactly where the player allocates them.
//
// The bar is a PIXI.Graphics draw with no text to assert, so these tests read the recorded fill geometry
// (`geometry.graphicsData`) and check the segment colours/widths directly.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { drawUnit } from '../../src/scenes/DefenseEditorScene/grid';
import type { DefenseEditorSceneCore } from '../../src/scenes/DefenseEditorScene/core';
import { UNIT_BLUEPRINTS } from '@nw/engine/config';
import { fromFp } from '@nw/engine';
import { UnitType } from '@nw/engine/types';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const CELL = 40;
const SIZE = Math.min(CELL, CELL) * 0.72; // drawUnit's own portrait size → the bar's full width
const SIEGE_ONLY_COLOR = 0x8a6cd4;
const HP_COLORS = [0x4caf50, 0xe0a020, 0xcc3b3b];

function fakeCore(mode: 'attack' | 'defense'): DefenseEditorSceneCore {
  return {
    mode,
    bodyLayer: new PIXI.Container(),
    cb: { getSave: () => ({ equipped: {} }) },
    // drawUnit draws the portrait before the bar; in the headless adapter the texture is never valid, so
    // it takes the "hook a load listener once" path and needs this set to exist.
    artHooked: new Set<string>(),
    render: () => {},
  } as unknown as DefenseEditorSceneCore;
}

/** Every filled rectangle this draw recorded, as {color, x, width}. */
function fills(g: PIXI.Graphics): { color: number; x: number; width: number }[] {
  const out: { color: number; x: number; width: number }[] = [];
  for (const d of (g.geometry as unknown as { graphicsData: {
    fillStyle: { visible: boolean; color: number };
    shape: { x?: number; width?: number };
  }[] }).graphicsData) {
    if (!d.fillStyle?.visible) continue;
    if (d.shape?.width === undefined) continue; // circles / polygons: not bar segments
    out.push({ color: d.fillStyle.color, x: d.shape.x ?? 0, width: d.shape.width });
  }
  return out;
}

function drawBar(type: UnitType, troops: number, cap: number, mode: 'attack' | 'defense' = 'attack'): PIXI.Graphics {
  const g = new PIXI.Graphics();
  drawUnit(fakeCore(mode), g, 0, 0, CELL, CELL, type, troops, cap);
  return g;
}

const infantryHp = fromFp(UNIT_BLUEPRINTS[UnitType.Infantry].hp_fp);       // 60
const shieldHp = fromFp(UNIT_BLUEPRINTS[UnitType.ShieldBearer].hp_fp);     // 240

describe('DefenseEditorScene troop bar — HP vs siege-only split (ADR-069)', () => {
  it('an over-filled card shows a siege-only segment sized by the troops past its HP cap', () => {
    // Level-1 lichuang: 200 troops in a 60-HP infantry body → 30% of the bar is HP, 70% siege-only.
    const cap = 200;
    const g = drawBar(UnitType.Infantry, cap, cap);
    const segments = fills(g);
    const hpSeg = segments.find((f) => HP_COLORS.includes(f.color));
    const siegeSeg = segments.find((f) => f.color === SIEGE_ONLY_COLOR);
    expect(hpSeg, 'no HP-coloured segment').toBeDefined();
    expect(siegeSeg, 'no siege-only segment on an over-filled card').toBeDefined();
    expect(hpSeg!.width).toBeCloseTo(SIZE * (infantryHp / cap), 4);
    expect(siegeSeg!.width).toBeCloseTo(SIZE * (1 - infantryHp / cap), 4);
    // The surplus starts exactly where the HP part ends (x is absolute board coords, not bar-relative),
    // so together they fill the bar exactly once with no gap or double-paint.
    expect(siegeSeg!.x).toBeCloseTo(hpSeg!.x + hpSeg!.width, 4);
    expect(hpSeg!.width + siegeSeg!.width).toBeCloseTo(SIZE, 4);
  });

  it('a card whose whole allotment fits under its HP cap has NO siege-only segment', () => {
    // Level-1 chenshou: 100 troops, 240-HP shieldbearer body → every troop is HP, nothing siege-only.
    const cap = 100;
    expect(cap).toBeLessThan(shieldHp); // sanity: this is the "cap below blueprint HP" case
    const g = drawBar(UnitType.ShieldBearer, cap, cap);
    expect(fills(g).some((f) => f.color === SIEGE_ONLY_COLOR)).toBe(false);
  });

  it('a partially filled over-cap card splits at the HP cap, not at the fill ratio', () => {
    // 120 of 200 troops on a 60-HP body: 60 HP + 60 siege-only, i.e. half the drawn fill each.
    const g = drawBar(UnitType.Infantry, 120, 200);
    const segments = fills(g);
    const hpSeg = segments.find((f) => HP_COLORS.includes(f.color))!;
    const siegeSeg = segments.find((f) => f.color === SIEGE_ONLY_COLOR)!;
    expect(hpSeg.width).toBeCloseTo(SIZE * (60 / 200), 4);
    expect(siegeSeg.width).toBeCloseTo(SIZE * (60 / 200), 4);
  });

  it('an under-filled card below its HP cap draws only the HP tone, and shorter than the bar', () => {
    const g = drawBar(UnitType.Infantry, 30, 200); // 30 troops < 60 HP cap
    const segments = fills(g);
    expect(segments.some((f) => f.color === SIEGE_ONLY_COLOR)).toBe(false);
    const hpSeg = segments.find((f) => HP_COLORS.includes(f.color))!;
    expect(hpSeg.width).toBeCloseTo(SIZE * (30 / 200), 4);
  });

  it('defense mode draws no troop bar at all (unchanged — the bar is an attack-formation affordance)', () => {
    const g = drawBar(UnitType.Infantry, 200, 200, 'defense');
    const segments = fills(g);
    expect(segments.some((f) => f.color === SIEGE_ONLY_COLOR)).toBe(false);
    expect(segments.some((f) => HP_COLORS.includes(f.color))).toBe(false);
  });
});
