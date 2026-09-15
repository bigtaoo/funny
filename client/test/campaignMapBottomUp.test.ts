import { describe, it, expect } from 'vitest';
import { CHAPTER_MAPS, CHAPTER_ORDER } from '../src/game/campaign/maps';
import type { ChapterMap } from '../src/game/campaign/maps/ChapterMap';
import { clearStampX } from '../src/scenes/CampaignMapScene/drawing';

/**
 * Authoring rules for the bottom-up chapter maps (CAMPAIGN_DESIGN §12.3, 2026-09-14).
 *
 * `mapSchema.test.ts` next door guards the *shape* of a chapter map (parses, node ids
 * resolve). This file guards its *layout intent*, which the schema cannot see: a chapter
 * climbs the page, and the two markers sit clear of the furniture the renderer hangs off
 * a node. Both rules are here because breaking them is invisible in a diff — the numbers
 * still parse, still sit in 0..1, and the damage only shows up as overlapping ink on a
 * phone, in a state (every level three-starred) a fresh account never reaches.
 *
 * Deliberately expressed in the normalized space the author edits, not in design px, so
 * these assertions stay true for any resolution and either orientation. The one test that
 * does need pixels (the cleared stamp) computes them from the same constants the scene uses.
 */

const map = (ch: number): ChapterMap => CHAPTER_MAPS[ch]!;
const marker = (m: ChapterMap, kind: string): { x: number; y: number } | undefined =>
  m.decor?.find((d) => d.kind === kind);

describe('chapter maps run bottom-up', () => {
  it('numbers every chapter from the foot of the page upwards', () => {
    // Deliberately a TREND, not step-by-step monotonicity: the trails are hand-drawn and
    // wander, and two of them switch back by as much as 0.12 (ch3/ch4 around level 6). But
    // five levels on you are always meaningfully higher up the page — the shallowest climb
    // in the shipped maps is 0.15, so 0.10 leaves the authoring room while still failing
    // loudly for a map that runs top-down or has been shuffled.
    const SPAN = 5, MIN_CLIMB = 0.10;
    for (const ch of CHAPTER_ORDER) {
      const nodes = map(ch).nodes; // smaller y = higher on screen
      for (let i = 0; i + SPAN < nodes.length; i++) {
        expect(
          nodes[i]!.y - nodes[i + SPAN]!.y,
          `ch${ch} climbs from level ${i + 1} to level ${i + 1 + SPAN}`,
        ).toBeGreaterThan(MIN_CLIMB);
      }
    }
  });

  it('puts level 1 within thumb reach at the foot and level 10 at the head', () => {
    for (const ch of CHAPTER_ORDER) {
      const nodes = map(ch).nodes;
      // The whole point of the flip: portrait players are phone players, and the levels a
      // new player taps most must not sit in the corner furthest from their thumb.
      expect(nodes[0]!.y, `ch${ch} level 1 in the bottom third`).toBeGreaterThan(0.66);
      expect(nodes[nodes.length - 1]!.y, `ch${ch} level 10 in the top third`).toBeLessThan(0.34);
    }
  });
});

describe('chapter map markers clear the furniture the renderer hangs off a node', () => {
  it('keeps the START flag above level 1, out of its star row', () => {
    for (const ch of CHAPTER_ORDER) {
      const m = map(ch);
      const start = marker(m, 'start');
      expect(start, `ch${ch} has a start marker`).toBeDefined();
      const lv1 = m.nodes[0]!;
      // drawNode always hangs a cleared node's three stars BELOW it, so a start marker
      // placed under level 1 lands in that row and the two sets of ink collide. It cannot
      // go beside it either: at 1080x1920 the star row is 130px wide and the flag with its
      // label ~150px, while level 1 sits around x=0.16 — there is no room to its left.
      const gap = lv1.y - start!.y;
      expect(gap, `ch${ch} start marker sits above level 1`).toBeGreaterThan(0);
      expect(gap, `ch${ch} start marker stays attached to level 1`).toBeLessThanOrEqual(0.12);
    }
  });

  it('keeps the BOSS flag above level 10', () => {
    for (const ch of CHAPTER_ORDER) {
      const m = map(ch);
      const boss = marker(m, 'boss');
      expect(boss, `ch${ch} has a boss marker`).toBeDefined();
      const last = m.nodes[m.nodes.length - 1]!;
      expect(boss!.y, `ch${ch} boss marker caps the climb`).toBeLessThan(last.y);
    }
  });
});

describe('clearStampX keeps the cleared stamp off the BOSS marker', () => {
  // Design sizes from ILayout (portrait 1080x1920, landscape 1920x1080) and the content
  // rect / decor size that CampaignMapScene.buildChapter and drawDecor derive from them.
  const CASES = [
    { name: 'portrait', w: 1080, h: 1920 },
    { name: 'landscape', w: 1920, h: 1080 },
  ];
  /**
   * Half the stamp's own width, as a fraction of design width, plus a margin.
   *
   * Measured in a real browser at 1080x1920: the box around "Chapter 5 · CLEARED" is
   * ~330px wide, i.e. a half-width of 0.153w; German ("Kapitel 5 · GESCHAFFT", the
   * longest of the three locales) pushes that to ~0.17w. 0.20w is that worst case with
   * room to spare — anything closer and the box can reach the flag.
   */
  const MIN_CLEARANCE = 0.20;

  for (const { name, w, h } of CASES) {
    it(`leaves every chapter's stamp clear of its boss flag (${name})`, () => {
      const cx0 = Math.round(w * 0.14);
      const cw = w - cx0 - Math.round(w * 0.06);
      const s = Math.round(h * 0.03); // drawDecor's marker size
      for (const ch of CHAPTER_ORDER) {
        const m = map(ch);
        const boss = marker(m, 'boss')!;
        // The pole, plus the flag that flies to its right (drawDecor 'boss': x + s * 1.4).
        const poleX = cx0 + boss.x * cw;
        const flagRightX = poleX + s * 1.4;
        const stampX = clearStampX(m, w);

        // Opposite halves of the page, judged from the marker's whole span rather than
        // clearStampX's own `boss.x >= 0.5` test — a boss authored near the middle would
        // satisfy the rule while its flag still leaned into the stamp's corner.
        const markerMid = (poleX + flagRightX) / 2;
        expect(
          Math.sign(markerMid - w / 2),
          `ch${ch} stamp and boss marker on opposite halves (${name})`,
        ).toBe(-Math.sign(stampX - w / 2));

        const gap = stampX < markerMid ? poleX - stampX : stampX - flagRightX;
        expect(gap / w, `ch${ch} stamp-to-flag clearance (${name})`).toBeGreaterThan(MIN_CLEARANCE);
      }
    });
  }
});
