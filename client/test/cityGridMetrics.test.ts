// The home-city building grid's column/height choice (scenes/CityScene/gridMetrics.ts).
//
// Worth a unit test rather than only a UI one because the interesting cases are *numeric*: which
// column count wins on each real viewport, and the two guards (never shorter than the design card,
// never taller than MAX_ASPECT). The numbers below are the real design-space bands — see the
// module header and design/game/SLG_CITY_DESIGN.md §竖屏版面.
import { describe, it, expect } from 'vitest';
import { gridMetrics, CARD_LAYOUT } from '../src/scenes/CityScene/gridMetrics';

/** The scene's own constants, so a retune of one shows up here as a changed expectation. */
const BASE = {
  count: 12,
  gap: 12,
  cardH: 192,
  cardWTarget: 222,
  maxCols: 6,
};

/** Grid band for a portrait phone: 1080-wide design space, `contentX` 9%, the 1699px band. */
const PHONE = { ...BASE, availW: 967, availH: 1699, portrait: true };

describe('city building grid metrics', () => {
  it('leaves landscape exactly as it was', () => {
    // 1920x1080 design space: the wide band fits six columns of the target width, and the card
    // height is the fixed design value regardless of how much room is left under the grid.
    const m = gridMetrics({ ...BASE, availW: 1730, availH: 620, portrait: false });
    expect(m.cols).toBe(6);
    expect(m.cardH).toBe(192);
    expect(m.topPad).toBe(0);
  });

  it('fills a portrait phone band with the squarest card it can', () => {
    const m = gridMetrics(PHONE);
    expect(m.cols).toBe(3);
    expect(m.cellW).toBe(314);
    // 4 rows: floor((1699 - 3*12) / 4) = 415, inside the aspect cap (314 * 1.45 = 455).
    expect(m.cardH).toBe(415);
    // The whole band is consumed — that is the defect this exists for. What the floor leaves
    // (3 px of 1699) is split above and below rather than pooling under the last row.
    expect(m.topPad).toBe(2);
    expect(4 * m.cardH + 3 * BASE.gap).toBe(1696);
  });

  it('fills a portrait tablet band, which lands almost square', () => {
    const m = gridMetrics({ ...BASE, availW: 967, availH: 1340, portrait: true });
    expect(m.cols).toBe(3);
    expect(m.cardH).toBe(326);
    expect(m.cardH / m.cellW).toBeGreaterThan(0.95);
    expect(m.cardH / m.cellW).toBeLessThan(1.1);
  });

  it('centres the block instead of stretching past the aspect cap', () => {
    // Unreachable with 12 tiles — a taller band just wins with FEWER columns and more rows (2
    // columns of 6 nearly-square cards at availH 2836), which is the preference working as
    // intended. The cap is a guard for a grid with too few tiles to fill a tall band at any
    // column count, so this states it with one tile.
    const m = gridMetrics({ ...PHONE, count: 1 });
    // Which column count wins is rounding noise when every candidate is pinned to the cap (they
    // all score 1.45); what matters is that the winner is capped rather than 1699 tall.
    expect(m.cardH).toBe(Math.round(m.cellW * 1.45));
    // Centred, not top-anchored — the slack is split, which is the whole point.
    expect(m.topPad).toBe(Math.round((PHONE.availH - m.cardH) / 2));
    expect(m.topPad).toBeGreaterThan(0);
  });

  it('falls back to the scrolling card when the band is too small to fill', () => {
    // Half the band: even 6 columns (2 rows) would need a card shorter than the design's own.
    const m = gridMetrics({ ...PHONE, availH: 300 });
    expect(m.cardH).toBe(192);
    expect(m.cols).toBe(4);      // the landscape rule: as many target-width columns as fit
    expect(m.topPad).toBe(0);
  });

  it('keeps the card composition proportional to the design card', () => {
    // Every fraction is defined against the 192-tall card, so multiplying back must return the
    // literal offsets render.ts used before the grid could grow.
    expect(Math.round(192 * CARD_LAYOUT.iconTop)).toBe(18);
    expect(Math.round(192 * CARD_LAYOUT.iconSize)).toBe(60);
    expect(Math.round(192 * CARD_LAYOUT.nameY)).toBe(90);
    expect(Math.round(192 * CARD_LAYOUT.barY)).toBe(118);
    expect(Math.round(192 * CARD_LAYOUT.subFromBottom)).toBe(33);
  });
});
