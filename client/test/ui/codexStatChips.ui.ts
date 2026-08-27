// Two guards on the codex tile's stat row (design/game/LOBBY_IA_REDESIGN_LOG.md §28,
// design/product/tab-icon-art-prompts-batch8.md):
//
//   1. `cardStats()` — every stat every card shows has an icon kind. This is the codex half of the
//      gate `equipmentAffixIcons.ui.ts` puts on affixes: the batch-7 sweep replaced every glyph that
//      was already being drawn, which structurally could not notice `range` — a stat that had never
//      had one. A fourth stat added without art fails here instead of shipping as a lone bare word.
//
//   2. `drawStatChips()`'s wrap — spelling the stats out made the row ~1/3 wider than the icon-only
//      version, so portrait now trades width for height: it picks the line count whose fit-scale is
//      largest, bounded by the panel width AND by the space left below the row's top edge. The height
//      bound is the one that matters here — without it the third line spilled out through the bottom
//      of the tile (seen in a real portrait screenshot before the maxH parameter existed), and no
//      other test in the suite would notice, because a container drawing outside its tile still
//      lays out and still passes every "is the text there" assertion.
//
// The headless `measureText` mock is a flat 7px/char, so absolute widths here are not real-browser
// widths — but the wrap decision is a pure function of (chip widths, maxW, maxH, size), which makes
// these invariants exactly as testable in headless as in a browser (see
// claudedocs/client-testing.md on what the mock can and cannot stand in for).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { cardStats, drawStatChips } from '../../src/scenes/CardCodexScene/tile';
import { CARD_DEFINITIONS } from '@nw/engine/config';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const STATS = [
  { icon: 'hp' as const, label: 'Health', value: 240 },
  { icon: 'atk' as const, label: 'Attack', value: 12 },
  { icon: 'range' as const, label: 'Range', value: 2 },
];

/** The single row container `drawStatChips` appends, plus the per-chip containers inside it. */
function draw(maxW: number, maxH: number, size: number): { row: PIXI.Container; chips: PIXI.Container[] } {
  const target = new PIXI.Container();
  drawStatChips(STATS, 0, 0, maxW, maxH, size, target);
  const row = target.children[0] as PIXI.Container;
  return { row, chips: row.children as PIXI.Container[] };
}

/** Distinct chip baselines = how many lines the row wrapped onto. */
function lineCount(chips: PIXI.Container[]): number {
  return new Set(chips.map((c) => c.y)).size;
}

describe('codex stat vocabulary — nothing shows as a bare word', () => {
  it('gives every stat of every card an icon kind', () => {
    const naked: string[] = [];
    for (const card of CARD_DEFINITIONS) {
      for (const s of cardStats(card) ?? []) {
        if (s.icon === null) naked.push(`${card.nameKey}: ${s.label}`);
      }
    }
    expect(naked).toEqual([]);
  });

  it('still returns null for a card type with no stats at all (spells)', () => {
    // Guards the other direction: the "every stat has an icon" loop above would also pass vacuously
    // if cardStats() started returning [] for everything.
    const withStats = CARD_DEFINITIONS.filter((c) => (cardStats(c) ?? []).length > 0);
    expect(withStats.length).toBeGreaterThan(0);
    expect(CARD_DEFINITIONS.some((c) => cardStats(c) === null)).toBe(true);
  });
});

describe('codex stat row — wraps within its height budget instead of shrinking', () => {
  const SIZE = 20;

  it('stays on one line at full size when the panel is wide enough', () => {
    const { row, chips } = draw(2000, 500, SIZE);
    expect(lineCount(chips)).toBe(1);
    expect(row.scale.x).toBe(1);
  });

  it('wraps rather than crushing the text when the panel is narrow', () => {
    const wide = draw(2000, 500, SIZE);
    const narrow = draw(Math.ceil(wide.row.width * 0.55), 500, SIZE);
    expect(lineCount(narrow.chips)).toBeGreaterThan(1);
    // The whole point of wrapping: the glyphs stay near full size. A pure shrink-to-fit would have
    // landed at ~0.55 here.
    expect(narrow.row.scale.x).toBeGreaterThan(0.8);
  });

  it('never draws past the height budget, however little of it there is', () => {
    const natural = draw(2000, 500, SIZE).row.width;
    for (const maxW of [natural, natural * 0.6, natural * 0.35, SIZE * 2]) {
      for (const maxH of [SIZE * 3, SIZE * 2, SIZE * 1.2, SIZE]) {
        const { row } = draw(Math.ceil(maxW), maxH, SIZE);
        // +1 for rounding in the per-chip layout; the failure this guards is a whole line over.
        expect(row.height, `maxW=${Math.round(maxW)} maxH=${maxH}`).toBeLessThanOrEqual(maxH + 1);
        expect(row.width, `maxW=${Math.round(maxW)} maxH=${maxH}`).toBeLessThanOrEqual(Math.ceil(maxW) + 1);
      }
    }
  });
});
