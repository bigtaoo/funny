// Cross-scene cell geometry: the invariants CardScene/logic/types.ts used to state only in prose.
//
// Why this exists at all. When cardSort/feedPlan/types moved into CardScene/logic/ (ADR-071 4b,
// 2026-08-27) and the directory came under the coverage gate, types.ts read 0% — its only importer,
// core.ts, pulls in PIXI, so nothing in the coverage-reporting suite ever loaded it. Rather than a
// test that imports the module to move a number, the constants turned out to have two real
// cross-file claims worth pinning, one of which was already WRONG:
//
//  * "Taller than EquipmentScene's EQUIP_CELL_H" — false since 2026-07-16. The roster went 177 -> 266
//    on 2026-07-14 and the equipment inventory independently went 177 -> 266 two days later in its own
//    legibility pass. Nobody was watching, because nothing checked.
//  * "Narrower than the equipment cells" — true (300 vs 360), and the reason the roster packs 5 per row.
//
// Both scenes' constants also share the NAME `CELL_GAP` with a 3x difference in value, which is the
// kind of thing an autocomplete picks wrong once and nobody sees until a grid looks off.
import { describe, it, expect } from 'vitest';
import { CELL_GAP, CARD_CELL_H, CARD_CELL_W_TARGET, MODAL_DIM } from '../src/scenes/CardScene/logic/types';
import { CELL_GAP as EQUIP_CELL_GAP, CELL_GAP_X as EQUIP_CELL_GAP_X, EQUIP_CELL_H, EQUIP_CELL_W_TARGET } from '../src/scenes/EquipmentScene/layout';

describe('roster vs equipment cell geometry', () => {
  it('the roster cell is NARROWER than an equipment cell — the surviving deliberate divergence', () => {
    // Load-bearing: ListPanel.renderList clamps to ROSTER_COLS (5) per row via
    // floor((avail + gap) / (CARD_CELL_W_TARGET + gap)). Widen this to the equipment width and a
    // 1920 landscape grid drops to 4 columns.
    expect(CARD_CELL_W_TARGET).toBeLessThan(EQUIP_CELL_W_TARGET);
  });

  it('the two cell HEIGHTS are equal, which is the fact — not the "roster is taller" the comment claimed', () => {
    // Recording reality, not endorsing it: if the roster is ever genuinely made taller than the
    // equipment cell, this line changes deliberately and the comment in logic/types.ts changes with
    // it. What must not happen again is the prose and the numbers drifting apart unwatched.
    expect(CARD_CELL_H).toBe(EQUIP_CELL_H);
  });

  it('`CELL_GAP` means two different things in the two scenes, and neither is derived from the other', () => {
    // If these ever have to agree, one should import the other rather than both landing on the same
    // literal by accident — which is exactly how the heights above ended up equal.
    expect(CELL_GAP).toBe(12);
    expect(EQUIP_CELL_GAP).toBe(36);
    expect(CELL_GAP).not.toBe(EQUIP_CELL_GAP);
    // The equipment grid also widens its HORIZONTAL gap; the roster uses one gap in both axes
    // (ROSTER_GAP in list.ts), so a reader comparing "the gap" across the two scenes is comparing
    // three different numbers.
    expect(EQUIP_CELL_GAP_X).toBe(EQUIP_CELL_GAP * 2);
  });

  it('the modal dim is opaque black, alpha applied by the caller', () => {
    // detail/feed/skins all draw `beginFill(MODAL_DIM, <alpha>)`; a non-zero tint here would tint
    // every modal scrim at once. It is a 24-bit RGB literal, not an RGBA one.
    expect(MODAL_DIM).toBe(0x000000);
  });
});
