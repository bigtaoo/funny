/**
 * unitSize.test.ts — the board-unit size factor (render/unitSize.ts, ADR-105 amendment 2026-10-08).
 *
 * Unit tier heights are literal design px while the board cell is `floor(70·k)` (landscape) /
 * `floor(84·k)` (portrait). Since landscape's 0.62 target scale (2026-10-07) short canvases get
 * small cells under full-size units: at the CrazyGames preview tile (722×406, cell 42) a Medium unit
 * was 1.29 cells tall and spilled into the next lane. Every tier is now multiplied by
 * `min(1, cell / 54)`; the reviewer canvas (1100×574, cell 60) and everything larger is unchanged.
 *
 * Cell sizes come from the real `createLayout`, so a layout constant change that moves a canvas
 * across the threshold fails here instead of silently resizing units.
 */
import { describe, it, expect } from 'vitest';
import { UnitType } from '@nw/engine/types';
import { createLayout } from '../../src/layout/ScalingManager';
import {
  SizeTier, TARGET_SCREEN_PX, UNIT_SIZE_FULL_CELL, UNIT_SIZE_TIER,
  boardUnitHeight, targetScreenHeight, unitSizeScale,
} from '../../src/render/unitSize';

const cellAt = (w: number, h: number): number => createLayout(w, h).cellSize;
const TIERS = [SizeTier.Small, SizeTier.Medium, SizeTier.Large, SizeTier.Giant];

describe('unitSizeScale — 1 on the reviewer canvas and larger', () => {
  it.each([
    ['1100×574 (CrazyGames reviewer canvas)', 1100, 574, 60],
    ['1280×720', 1280, 720, 70],
    ['1366×768', 1366, 768, 70],
    ['1920×1080', 1920, 1080, 70],
  ])('%s', (_name, w, h, cell) => {
    expect(cellAt(w, h)).toBe(cell);
    expect(cellAt(w, h)).toBeGreaterThanOrEqual(UNIT_SIZE_FULL_CELL);
    expect(unitSizeScale(cellAt(w, h))).toBe(1);
    for (const tier of TIERS) {
      // Byte-for-byte the old value: no multiplication at all, not a ×1.0000001.
      const type = (Object.keys(UNIT_SIZE_TIER) as UnitType[]).find((t) => UNIT_SIZE_TIER[t] === tier)!;
      expect(boardUnitHeight(type, cellAt(w, h))).toBe(TARGET_SCREEN_PX[tier]);
    }
  });

  it.each([
    ['390×844 phone', 390, 844, 60],
    ['360×640 phone', 360, 640, 56],
    ['430×932 phone', 430, 932, 66],
    ['800×1280 tablet', 800, 1280, 84],
  ])('portrait %s: unchanged', (_name, w, h, cell) => {
    expect(createLayout(w, h).orientation).toBe('portrait');
    expect(cellAt(w, h)).toBe(cell);
    expect(unitSizeScale(cell)).toBe(1);
  });

  it('a missing or non-positive cell size (headless stubs) means full size', () => {
    expect(unitSizeScale(undefined)).toBe(1);
    expect(unitSizeScale(0)).toBe(1);
    expect(unitSizeScale(Number.NaN)).toBe(1);
  });
});

describe('unitSizeScale — shrinks on small landscape cells', () => {
  it('722×406 (CrazyGames preview tile): cell 42 → ×0.78, Medium exactly one cell', () => {
    const cell = cellAt(722, 406);
    expect(cell).toBe(42);
    expect(unitSizeScale(cell)).toBeLessThan(1);
    expect(unitSizeScale(cell)).toBeCloseTo(42 / 54, 6);
    const medium = boardUnitHeight(UnitType.Infantry, cell);
    expect(medium / cell).toBeLessThanOrEqual(1.0 + 1e-9);
    // Was 54 / 42 = 1.29 cells before the factor.
    expect(targetScreenHeight(UnitType.Infantry) / cell).toBeGreaterThan(1.25);
  });

  it('keeps the S/M/L/XL proportions on a shrunk board', () => {
    const cell = cellAt(722, 406);
    const m = boardUnitHeight(UnitType.Infantry, cell);
    expect(boardUnitHeight(UnitType.Archer, cell) / m).toBeCloseTo(46 / 54, 9);
    expect(boardUnitHeight(UnitType.ShieldBearer, cell) / m).toBeCloseTo(64 / 54, 9);
    expect(boardUnitHeight(UnitType.Ironclad, cell) / m).toBeCloseTo(81 / 54, 9);
  });

  it('no landscape canvas from 360 to 1080 tall puts a Medium unit over one cell', () => {
    for (let h = 360; h <= 1080; h += 2) {
      const cell = cellAt(Math.round(h * 1.78), h);
      expect(boardUnitHeight(UnitType.Infantry, cell) / cell).toBeLessThanOrEqual(1.0 + 1e-9);
    }
  });

  it('is continuous at the threshold and linear below it', () => {
    expect(unitSizeScale(UNIT_SIZE_FULL_CELL)).toBe(1);
    expect(unitSizeScale(UNIT_SIZE_FULL_CELL - 1)).toBeCloseTo(53 / 54, 9);
    expect(unitSizeScale(27)).toBeCloseTo(0.5, 9);
  });
});
