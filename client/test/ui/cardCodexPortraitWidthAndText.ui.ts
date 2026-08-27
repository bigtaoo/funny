// Coverage for the 2026-08-09 Collection (CardCodexScene) portrait fix (design/game/LOBBY_IA_REDESIGN.md
// §24): user feedback on a portrait screenshot flagged three things — ①content didn't fill 90% of the
// screen width, ②character names were clipped mid-word, ③the bottom nav bar had no visible background.
// ③ was already fixed earlier the same day in HubTabs.ts (drawBottomNavTabs's full-width backing strip,
// shared by every portrait Career-hub scene) — this file covers ① and ②, which are CardCodexScene's own:
//   - `renderCards()`'s tileH derived the tile's illustration-square side length from `this.h`, which is
//     the design canvas's *long* edge in portrait (1920) — the same short/long-edge swap sidebarNavW's
//     doc comment explains. That produced an oversized square image box that squeezed the right-hand
//     info panel down to a sliver too narrow for a card name, independent of the overall content width.
//   - the outer content column used flat asymmetric margins (6% left / 3% right ≈ 91% total) instead of
//     a centered 90%-wide column matching LobbyScene's portrait convention (§21).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CardCodexScene, type CardCodexCallbacks } from '../../src/scenes/CardCodexScene';
import { CARD_DEFINITIONS } from '@nw/engine/config';
import { CardType } from '@nw/engine/types';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// Own every unit character so every codex entry (units + buildings/spells) renders unlocked and draws
// its full name + stat row — locked entries still draw a name but this exercises the widest set of tiles.
const ALL_UNIT_TYPES = [...new Set(
  CARD_DEFINITIONS.filter((c) => c.cardType === CardType.Unit && c.unitType !== undefined).map((c) => c.unitType as string),
)];

function baseCb(withSidebar: boolean, owned: string[] = ALL_UNIT_TYPES): CardCodexCallbacks {
  const cb: CardCodexCallbacks = {
    onBack() {},
    getOwnedUnitTypes: () => new Set(owned),
  };
  if (withSidebar) {
    cb.onOpenStats = () => {};
    cb.onOpenTitles = () => {};
    cb.onOpenAchievements = () => {};
  }
  return cb;
}

interface SceneInternals {
  hits: Array<{ rect: { x: number; y: number; w: number; h: number }; scroll?: boolean }>;
  container: PIXI.Container;
}

/** The illustration-tap hit rects (`scroll: true`) — one per unlocked tile, `rect.w === rect.h === tileH`. */
function imageHits(scene: CardCodexScene): Array<{ x: number; y: number; w: number; h: number }> {
  const { hits } = scene as unknown as SceneInternals;
  return hits.filter((h) => h.scroll).map((h) => h.rect);
}

/** Every PIXI.Text node in the scene whose text matches one of the codex's card display names. */
function nameTextNodes(container: PIXI.Container): PIXI.Text[] {
  const names = new Set(CARD_DEFINITIONS.map((c) => t(c.nameKey as never)));
  const out: PIXI.Text[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && names.has(node.text)) out.push(node);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

/**
 * Direct geometric proof that every name's *rendered* right edge stays inside its own tile — independent
 * of the shrink-to-fit escape hatch (a name could pass the `scale.x≈1` check above yet still, if some
 * other constant drifted, spill past the tile boundary the shrink guard was never triggered to catch).
 * Locked entries have no illustration hit rect (drawCardTile only pushes one for unlocked tiles), so this
 * derives each tile's own left edge from the two known column starts (`colXs`) rather than from hits.
 */
function assertNamesFitInsideTiles(scene: CardCodexScene, w: number, avail: number, contentX: number): void {
  const cols = 2;
  const gap = Math.round(avail * 0.045);
  const tileW = Math.round((avail - gap) / cols);
  const colXs = [contentX, contentX + tileW + gap];

  const names = nameTextNodes(scene.container);
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) {
    // Whichever column start is <= the name's x (and closest to it) is this name's own tile.
    const colX = Math.max(...colXs.filter((x) => x <= n.x));
    expect(n.x + n.width).toBeLessThanOrEqual(colX + tileW);
  }
}

describe('CardCodexScene (Collection) portrait — 90%-wide centered column (2026-08-09)', () => {
  it('starts tiles at the centered 90%-width column\'s left edge, not the old 6%/3% asymmetric margins', () => {
    const scene = new CardCodexScene(createLayout(1080, 1920), new InputManager(), baseCb(true));
    const w = 1080;
    const expectedAvail = Math.round(w * 0.9); // 972
    const expectedLeft = Math.round((w - expectedAvail) / 2); // 54

    const rects = imageHits(scene);
    expect(rects.length).toBeGreaterThan(0);
    const xs = [...new Set(rects.map((r) => r.x))].sort((a, b) => a - b);
    // Two columns → exactly two distinct tile-left x positions.
    expect(xs.length).toBe(2);
    expect(xs[0]).toBe(expectedLeft);

    // Column stride (col1.x - col0.x) is tileW + gap, both derived from the same 90%-wide `avail`.
    const gap = Math.round(expectedAvail * 0.045);
    const tileW = Math.round((expectedAvail - gap) / 2);
    expect(xs[1] - xs[0]).toBe(tileW + gap);

    scene.destroy();
  });

  it('sizes the illustration square off the design canvas\'s short edge (w in portrait), not the long edge', () => {
    const scene = new CardCodexScene(createLayout(1080, 1920), new InputManager(), baseCb(true));
    const rects = imageHits(scene);
    expect(rects.length).toBeGreaterThan(0);
    const expectedTileH = Math.round(1080 * 0.19); // short edge — was Math.round(1920 * 0.19) = 365 (bug)
    for (const r of rects) {
      expect(r.h).toBe(expectedTileH);
      expect(r.w).toBe(expectedTileH); // illustration is a square: imgBox === tileH
    }
    scene.destroy();
  });

  it('never has to shrink a card name to fit the info panel (the tileH fix leaves it wide enough)', () => {
    const scene = new CardCodexScene(createLayout(1080, 1920), new InputManager(), baseCb(true));
    const names = nameTextNodes(scene.container);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.scale.x).toBeCloseTo(1, 5);
    scene.destroy();
  });

  it('keeps every name\'s actual rendered right edge inside its own tile (direct bounds check, not just the scale proxy)', () => {
    const w = 1080;
    const avail = Math.round(w * 0.9);
    const contentX = Math.round((w - avail) / 2);
    const scene = new CardCodexScene(createLayout(w, 1920), new InputManager(), baseCb(true));
    assertNamesFitInsideTiles(scene, w, avail, contentX);
    scene.destroy();
  });

  it('still fits every name when nothing is owned — locked entries (dimmed, no illustration hit rect) draw a name too', () => {
    const w = 1080;
    const avail = Math.round(w * 0.9);
    const contentX = Math.round((w - avail) / 2);
    const scene = new CardCodexScene(createLayout(w, 1920), new InputManager(), baseCb(true, []));
    assertNamesFitInsideTiles(scene, w, avail, contentX);
    scene.destroy();
  });

  it('still fits every name under a realistic mixed locked/unlocked roster', () => {
    const w = 1080;
    const avail = Math.round(w * 0.9);
    const contentX = Math.round((w - avail) / 2);
    const scene = new CardCodexScene(createLayout(w, 1920), new InputManager(), baseCb(true, ALL_UNIT_TYPES.slice(0, 2)));
    assertNamesFitInsideTiles(scene, w, avail, contentX);
    scene.destroy();
  });
});

describe('CardCodexScene (Collection) landscape — sidebar-margin layout unchanged (regression guard, 2026-08-09)', () => {
  it('still sizes the illustration square off the short edge (h in landscape) exactly as before the fix', () => {
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb(true));
    const rects = imageHits(scene);
    expect(rects.length).toBeGreaterThan(0);
    const expectedTileH = Math.round(1080 * 0.19); // short edge — landscape's `h`, untouched by the fix
    for (const r of rects) expect(r.h).toBe(expectedTileH);
    scene.destroy();
  });

  it('is not accidentally centered at the portrait 90% formula', () => {
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb(true));
    const rects = imageHits(scene);
    const xs = [...new Set(rects.map((r) => r.x))];
    const w = 1920;
    const portraitLeft = Math.round((w - Math.round(w * 0.9)) / 2);
    expect(Math.min(...xs)).not.toBe(portraitLeft);
    scene.destroy();
  });

  it('never needed the shrink-to-fit guard here either — landscape had plenty of room even before the fix', () => {
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb(true));
    const names = nameTextNodes(scene.container);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.scale.x).toBeCloseTo(1, 5);
    scene.destroy();
  });
});

// ── The info panel's four lines, as geometry (2026-08-27) ──────────────────────────────────────────
//
// The panel went from "name + one plain subtitle + a chip row" to four lines that each carry an icon,
// which moved every y in it: a row of icons is taller than a line of text, so the subtitle's origin
// had to come up by half that difference. This pins the resulting ORDER (name above subtitle above
// the stat/locked line) and that nothing sticks out of its own tile.
//
// It does NOT cover the wrap's height budget: the headless measureText mock is a flat 7px/char, so at
// portrait's tile width these labels fit on one line here and the two-line case real CJK text hits
// never arises. That invariant is pinned directly instead, by calling drawStatChips with exaggerated
// maxW/maxH — see test/ui/codexStatChips.ui.ts, and claudedocs/client-testing.md on why forcing the
// geometry beats trying to reproduce a real-browser width in headless.
//
// `getBounds()` is what makes this checkable at all: the labels now live inside per-row containers
// that carry their own scale, so a local `.x`/`.width` (what assertNamesFitInsideTiles reads for the
// names, which are direct children) would silently measure the wrong frame.
function textNodes(container: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && node.text.length > 0) out.push(node);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

describe('CardCodexScene (Collection) portrait — every info-panel line stays in its lane', () => {
  const W = 1080;

  /** Tile rects come from the illustration hit rects, which are square and share the tile's y band. */
  function tilesOf(scene: CardCodexScene, tileW: number): Array<{ x: number; y: number; w: number; h: number }> {
    return imageHits(scene).map((r) => ({ x: r.x, y: r.y, w: tileW, h: r.h }));
  }

  it('keeps every line of every tile inside that tile, name → subtitle → stats, in that order', () => {
    const avail = Math.round(W * 0.9);
    const contentX = Math.round((W - avail) / 2);
    const gap = Math.round(avail * 0.045);
    const tileW = Math.round((avail - gap) / 2);
    const scene = new CardCodexScene(createLayout(W, 1920), new InputManager(), baseCb(true, ALL_UNIT_TYPES.slice(0, 2)));

    const names = new Set(CARD_DEFINITIONS.map((c) => t(c.nameKey as never)));
    const types = new Set([
      t('collection.cardType.unit' as never),
      t('collection.cardType.building' as never),
      t('collection.cardType.spell' as never),
    ]);
    const costPrefix = `${t('collection.stat.cost' as never)} `;
    const thirdLine = new Set([
      t('collection.stat.hp' as never),
      t('collection.stat.atk' as never),
      t('collection.stat.range' as never),
      t('collection.locked' as never),
    ]);

    const tiles = tilesOf(scene, tileW);
    expect(tiles.length).toBeGreaterThan(0);
    const nodes = textNodes(scene.container).map((n) => ({ text: n.text, b: n.getBounds() }));

    let checked = 0;
    for (const tile of tiles) {
      const mine = nodes.filter(({ b }) => {
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        return cx >= tile.x && cx <= tile.x + tile.w && cy >= tile.y && cy <= tile.y + tile.h;
      });
      if (mine.length === 0) continue; // a tile scrolled out of the virtualized window

      // Nothing may spill out of the tile — the failure the height budget exists to prevent.
      for (const { text, b } of mine) {
        expect(b.x + b.width, `"${text}" right edge`).toBeLessThanOrEqual(tile.x + tile.w + 1);
        expect(b.y + b.height, `"${text}" bottom edge`).toBeLessThanOrEqual(tile.y + tile.h + 1);
        expect(b.y, `"${text}" top edge`).toBeGreaterThanOrEqual(tile.y - 1);
      }

      const band = (pick: (t: string) => boolean): { top: number; bottom: number } | null => {
        const sel = mine.filter(({ text }) => pick(text));
        if (sel.length === 0) return null;
        return {
          top: Math.min(...sel.map(({ b }) => b.y)),
          bottom: Math.max(...sel.map(({ b }) => b.y + b.height)),
        };
      };
      const nameBand = band((x) => names.has(x));
      const subBand = band((x) => types.has(x) || x.startsWith(costPrefix));
      const lastBand = band((x) => thirdLine.has(x));
      expect(nameBand, 'every tile draws a name').not.toBeNull();
      expect(subBand, 'every tile draws its type and cost').not.toBeNull();
      if (nameBand && subBand) expect(nameBand.bottom).toBeLessThanOrEqual(subBand.top);
      if (subBand && lastBand) expect(subBand.bottom).toBeLessThanOrEqual(lastBand.top);
      checked++;
    }
    expect(checked, 'no tile was actually measured — the filter is wrong, not the layout').toBeGreaterThan(1);
    scene.destroy();
  });
});
