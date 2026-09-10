// Unit coverage for `equipGridColumns` (EquipmentScene/layout.ts) — pure column-sizing math split out
// of InventoryMixin.renderInventory (2026-08-09 UX fix) so both the real-world portrait case and the
// centering fallback it exists for can be pinned down without spinning up a full EquipmentScene.
// The fallback path is never actually hit in-game today (portrait's fixed 1080 design width always
// divides evenly into 3 columns — see the .ui.ts integration test), so this is the only place it's
// exercised at all.
import { describe, it, expect } from 'vitest';
import { equipGridColumns, matIconKind, CELL_GAP_X, EQUIP_CELL_W_MIN, EQUIP_CELL_W_TARGET } from '../src/scenes/EquipmentScene/layout';
import { EQUIPMENT_DEFS } from '../src/game/meta/equipmentDefs';
import { INK_ICON_ART } from '../src/render/icons';

describe('equipGridColumns', () => {
  it('portrait: packs 3 exact-fit columns at the real game\'s avail (~1008), no leftover / no offset', () => {
    const avail = 1008; // PortraitLayout's fixed DESIGN_W (1080) minus two CELL_GAP margins
    const { cols, cellW, offset } = equipGridColumns(avail, false);
    expect(cols).toBe(3);
    expect(cellW).toBeGreaterThanOrEqual(EQUIP_CELL_W_MIN);
    expect(cellW).toBeLessThanOrEqual(EQUIP_CELL_W_TARGET);
    expect(cols * cellW + CELL_GAP_X * (cols - 1)).toBeCloseTo(avail, 6);
    expect(offset).toBe(0);
  });

  it('landscape: keeps the stricter target-width floor and never centers, even with a wide leftover', () => {
    const avail = 1008; // same avail as the portrait case above, landscape=true this time
    const { cols, cellW, offset } = equipGridColumns(avail, true);
    expect(cols).toBe(2); // EQUIP_CELL_W_TARGET floor doesn't clear a 3rd column here
    expect(cellW).toBe(EQUIP_CELL_W_TARGET); // capped, not stretched
    const rowW = cols * cellW + CELL_GAP_X * (cols - 1);
    expect(rowW).toBeLessThan(avail); // leftover exists...
    expect(offset).toBe(0); // ...but landscape's own margin convention is left untouched
  });

  it('portrait: narrower avail that still only fits 2 columns centers the row instead of hugging left', () => {
    // Picked so the even-split cellW ((850-72)/2=389) exceeds EQUIP_CELL_W_TARGET and gets capped,
    // which is what actually produces leftover to center against (see the cellW cap in the impl).
    const avail = 850;
    const { cols, cellW, offset } = equipGridColumns(avail, false);
    expect(cols).toBe(2);
    expect(cellW).toBe(EQUIP_CELL_W_TARGET);
    const rowW = cols * cellW + CELL_GAP_X * (cols - 1);
    expect(rowW).toBeLessThan(avail);
    expect(offset).toBeCloseTo((avail - rowW) / 2, 6);
    expect(offset).toBeGreaterThan(0);
  });

  it('never returns fewer than 1 column even for a degenerate (near-zero) avail', () => {
    const { cols, cellW } = equipGridColumns(10, false);
    expect(cols).toBe(1);
    expect(cellW).toBeGreaterThan(0);
  });
});

// `matIconKind` — the material-id → icon-kind lookup from the same module (2026-09-10 FNDA sweep
// found it at zero hits). Three lines, but they sit between two tables that are maintained
// separately: the material ids the server puts in `craftCost` / `salvageRefund`, and the icon
// kinds `buildIcon` can actually draw. A miss returns null and the cost row silently falls back to
// a bare number with no glyph — legible, so nobody files it, but the forge/salvage rows stop being
// scannable at a glance, which is the entire reason they are icons.
describe('matIconKind', () => {
  it('maps every material the equipment catalogue actually charges', () => {
    // Sourced from the catalogue rather than hand-listed, so a new material added server-side
    // fails here instead of quietly rendering as text.
    const ids = new Set<string>();
    for (const def of Object.values(EQUIPMENT_DEFS)) {
      for (const id of Object.keys(def.craftCost ?? {})) ids.add(id);
    }
    expect(ids.size).toBeGreaterThan(1); // non-vacuity: the catalogue really does charge materials
    for (const id of ids) {
      expect(matIconKind(id), id).not.toBeNull();
    }
  });

  it('returns kinds the icon table can actually draw', () => {
    // The failure this catches is a rename on the icon side: matIconKind would keep returning
    // 'lead', buildIcon would find no art for it, and the row would draw an empty box.
    for (const id of ['scrap', 'lead', 'binding'] as const) {
      const kind = matIconKind(id)!;
      expect(Object.keys(INK_ICON_ART), id).toContain(kind);
    }
  });

  it('accepts both spellings of the coin pseudo-material', () => {
    // Reward payloads say 'coins', the equipment cost rows say 'coin'; both reach this function.
    expect(matIconKind('coins')).toBe('coin');
    expect(matIconKind('coin')).toBe('coin');
  });

  it('returns null (text fallback) for anything else, rather than a bogus kind', () => {
    expect(matIconKind('unobtainium')).toBeNull();
    expect(matIconKind('')).toBeNull();
    expect(matIconKind('toString')).toBeNull(); // prototype keys are not materials either
  });
});
