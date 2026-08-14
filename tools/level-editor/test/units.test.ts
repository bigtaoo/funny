// Editor-side unit display metadata (src/units.ts) — pure lookup, no PIXI/DOM dependency.
// The valid unit-type set is owned by the game (@nw/engine); this only pins the editor's own
// fallback behavior for types that haven't been given a label/color entry yet.
import { describe, it, expect } from 'vitest';
import { UnitType } from '@nw/engine/types';
import { unitMeta, ALL_UNITS } from '../src/units';

describe('unitMeta', () => {
  it('returns the curated label/color for a unit type with an entry', () => {
    expect(unitMeta(UnitType.Infantry)).toEqual({ type: UnitType.Infantry, label: 'Infantry', color: '#89b4fa' });
    expect(unitMeta(UnitType.Archer)).toEqual({ type: UnitType.Archer, label: 'Archer', color: '#a6e3a1' });
  });

  it('falls back to a neutral color and the raw enum value as the label for an uncurated type', () => {
    // Max/Lena/Mara (Anna-side PvP units) have no entry in units.ts's META table.
    const meta = unitMeta(UnitType.Max);
    expect(meta).toEqual({ type: UnitType.Max, label: 'max', color: '#bac2de' });
  });

  it('always echoes back the requested type, curated or not', () => {
    for (const t of Object.values(UnitType)) {
      expect(unitMeta(t).type).toBe(t);
    }
  });
});

describe('ALL_UNITS', () => {
  it('covers every UnitType enum value exactly once, in declaration order', () => {
    const allTypes = Object.values(UnitType);
    expect(ALL_UNITS.map((m) => m.type)).toEqual(allTypes);
  });

  it('every entry has a non-empty color (curated or fallback)', () => {
    for (const m of ALL_UNITS) expect(m.color.length).toBeGreaterThan(0);
  });
});
