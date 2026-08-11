// Coverage for the 2026-08-11 TitlesScene portrait card-overlap fix (design/game/TITLE_DESIGN.md,
// same date entry): `badgeYBelowContent()` is the arithmetic that keeps a card's bottom-anchored
// status badge ("Locked" / "Equipped" + "(tap to remove)") from overlapping a full-name label that
// word-wrapped to extra lines (e.g. English "Notebook Conqueror" on a narrow portrait card).
//
// This is a plain pure-function unit test, not a `.ui.ts` PIXI smoke test, because the wrap this
// fixes only actually happens under a *real* canvas font renderer — the headless UI-test harness's
// `measureText` stub (test/harness/pixiHeadless.ts) approximates text width as a flat
// `length * 7`, ignoring font size entirely, so it never reproduces the multi-line wrap a real
// (much larger) font size triggers at the same card width. Testing the clamp arithmetic directly
// is what actually proves the fix; see titlesPortraitOverlap.ui.ts for the complementary
// short/long-edge `cellH` regression, which *is* reliably observable headless.
import { describe, it, expect } from 'vitest';
import { badgeYBelowContent } from '../src/scenes/TitlesScene';

describe('badgeYBelowContent (TitlesScene portrait overlap fix, 2026-08-11)', () => {
  it('uses the preferred (fixed-bottom) position when the content above ends well clear of it', () => {
    // Typical case: a single-line label, plenty of room before the card's own bottom margin.
    expect(badgeYBelowContent(/* preferredY */ 300, /* contentBottom */ 200, /* gap */ 10)).toBe(300);
  });

  it('yields downward past the content when the preferred position would overlap it', () => {
    // contentBottom (295) + gap (10) = 305 > preferredY (300) — the wrapped label nearly reaches
    // the fixed offset, so the badge must move down to 305, not sit at 300 and overlap it.
    expect(badgeYBelowContent(300, 295, 10)).toBe(305);
  });

  it('reproduces the exact reported bug\'s shape: a 2-line-wrapped label whose bottom would have collided with a fixed-offset badge', () => {
    // Mirrors the numbers a portrait card with a wrapped English full name produces: the fixed
    // "bottom of card" offset (300) sits well *above* where the second wrapped line actually
    // ends (330) — pre-fix this was the unconditional badge.y and it overlapped the label.
    const preferredY = 300;
    const contentBottom = 330;
    const gap = 8;
    const y = badgeYBelowContent(preferredY, contentBottom, gap);
    expect(y).toBe(338);
    expect(y).toBeGreaterThan(contentBottom); // badge's top-of-bounds still needs its own height of
    // clearance above this, but at minimum its anchor must never land above the content it follows.
  });

  it('treats "exactly touching" (contentBottom + gap === preferredY) as no overlap — boundary is inclusive', () => {
    expect(badgeYBelowContent(310, 300, 10)).toBe(310);
  });

  it('is monotonic in contentBottom — a taller (more-wrapped) label never pulls the badge upward', () => {
    const oneLine = badgeYBelowContent(300, 220, 10);
    const twoLines = badgeYBelowContent(300, 260, 10);
    const threeLines = badgeYBelowContent(300, 300, 10);
    expect(twoLines).toBeGreaterThanOrEqual(oneLine);
    expect(threeLines).toBeGreaterThanOrEqual(twoLines);
  });
});
