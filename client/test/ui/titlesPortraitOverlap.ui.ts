// Coverage for the 2026-08-11 TitlesScene portrait card-overlap fix (design/game/TITLE_DESIGN.md,
// same date entry) — a portrait screenshot showed the title-wall's icon-card grid coming out
// absurdly narrow/tall, with word-wrapped English full names ("Notebook Conqueror", "Ranked
// Veteran") running straight into the "Locked" status badge below them. Root cause #1, covered
// here directly:
//   - drawTitleList()'s `cellH` read off `h` unconditionally, which is the design canvas's *long*
//     edge in portrait (designWidth/designHeight swap meaning between orientations — the same
//     short/long-edge mixup CardCodexScene.tileH was fixed for, see
//     cardCodexPortraitWidthAndText.ui.ts). That blew cards up to ~1:3.3 aspect and their fonts
//     along with it.
//
// Root cause #2 (drawTitleCard()'s status badges sat at a fixed offset from the card's *bottom*,
// blind to how many lines the full-name label above them wrapped to) is covered by
// test/titlesBadgeOverflow.test.ts instead, NOT here: the headless UI-test harness's `measureText`
// stub (test/harness/pixiHeadless.ts) approximates text width as flat `length * 7`, ignoring font
// size — at this scene's real cellW, none of the actual product full-name strings (in any of
// zh/en/de) exceed that stub's wrap threshold, so a full-scene headless render can't reproduce the
// real font-size-driven wrap this fixes. The "no overlap" checks below still hold (trivially, since
// nothing wraps here) and stay as a coarse regression guard, but the actual overflow arithmetic is
// what test/titlesBadgeOverflow.test.ts exercises directly and precisely.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { TitlesScene, type TitlesSceneCallbacks } from '../../src/scenes/TitlesScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
// English has the longest fixed-title full names ("Notebook Conqueror", "Ranked Veteran") of the
// three locales — the closest this harness can get to the reported scenario (see file header).
initI18n('en', memStore, ['zh', 'en', 'de']);

const FULL_KEYS = ['title.event.founder.full', 'title.ach.all_chapters.full', 'title.ach.pvp.veteran.full'] as const;

function baseCb(): TitlesSceneCallbacks {
  return {
    onBack() {},
    titles: ['event.newbie'], // the only owned title — founder/all_chapters/pvp.veteran stay locked
    equippedTitle: 'event.newbie',
    onEquip() {},
    onOpenStats() {},
    onOpenAchievements() {},
    onOpenCodex() {},
    hasClaimableAchievement: false,
  };
}

interface SceneInternals {
  hits: Array<{ rect: { x: number; y: number; w: number; h: number } }>;
  body: PIXI.Container;
}

/**
 * The owned card's grid cell size. `drawTitleCard` only pushes a hit rect for owned titles
 * (`{rect: {x,y,w: cellW, h: cellH}, fn}`, pushed last, after the header back-button and any
 * sidebar tab hits) — with `baseCb()`'s single owned title (`event.newbie`), the final hit in the
 * array is always that card's cell, giving `cellW`/`cellH` without reaching into private fields.
 */
function ownedCardCell(scene: TitlesScene): { w: number; h: number } {
  const { hits } = scene as unknown as SceneInternals;
  expect(hits.length).toBeGreaterThan(0);
  return { w: hits[hits.length - 1]!.rect.w, h: hits[hits.length - 1]!.rect.h };
}

/** Every PIXI.Text in the card-grid layer only (excludes the header/sidebar, whose own unrelated
 *  layout would just be noise for this scene's card-grid regression). */
function gridTextNodes(scene: TitlesScene): PIXI.Text[] {
  const { body } = scene as unknown as SceneInternals;
  const out: PIXI.Text[] = [];
  const walk = (n: PIXI.Container): void => {
    if (n instanceof PIXI.Text) out.push(n);
    for (const c of n.children) walk(c as PIXI.Container);
  };
  walk(body);
  return out;
}

function findText(nodes: PIXI.Text[], label: string): PIXI.Text[] {
  return nodes.filter((n) => n.text === label);
}

/** Anchor-aware top/bottom edge — the full-name label is top-anchored (`anchor.set(0.5, 0)`) but
 *  the status badges are bottom-anchored (`anchor.set(0.5, 1)`), so `.y` alone isn't an edge for both. */
function topOf(n: PIXI.Text): number { return n.y - n.anchor.y * n.height; }
function bottomOf(n: PIXI.Text): number { return n.y + (1 - n.anchor.y) * n.height; }

/** For each locked fixed title, its own full-name label and the "Locked" badge in the same column
 *  (matched by shared x-center — every text in a card is centered on the same `x + cellW / 2`). */
function lockedLabelBadgePairs(scene: TitlesScene): Array<{ label: PIXI.Text; badge: PIXI.Text }> {
  const nodes = gridTextNodes(scene);
  const locked = findText(nodes, t('titles.locked' as never));
  expect(locked.length).toBe(3); // founder / all_chapters / pvp.veteran — the 3 fixed titles not in baseCb().titles
  return FULL_KEYS.map((key) => {
    const label = findText(nodes, t(key as never))[0]!;
    expect(label).toBeDefined();
    const badge = locked.find((b) => Math.abs(b.x - label.x) < 1);
    expect(badge).toBeDefined();
    return { label, badge: badge! };
  });
}

describe('TitlesScene portrait — card overlap fix (2026-08-11)', () => {
  it('sizes cellH off the design canvas\'s short edge (w in portrait), not the long edge', () => {
    const scene = new TitlesScene(createLayout(1080, 1920), new InputManager(), baseCb());
    const { h } = ownedCardCell(scene);
    expect(h).toBe(Math.round(1080 * 0.32)); // short edge — was Math.round(1920 * 0.32) = 614 (bug)
    scene.destroy();
  });

  it('keeps every locked card\'s full-name label clear of its own "Locked" badge (coarse guard; see titlesBadgeOverflow.test.ts for the precise overflow-arithmetic coverage)', () => {
    const scene = new TitlesScene(createLayout(1080, 1920), new InputManager(), baseCb());
    for (const { label, badge } of lockedLabelBadgePairs(scene)) {
      expect(bottomOf(label)).toBeLessThanOrEqual(topOf(badge));
    }
    scene.destroy();
  });
});

describe('TitlesScene landscape — unaffected by the portrait fix (regression guard, 2026-08-11)', () => {
  it('still sizes cellH off the short edge (h in landscape) exactly as before the fix', () => {
    const scene = new TitlesScene(createLayout(1920, 1080), new InputManager(), baseCb());
    const { h } = ownedCardCell(scene);
    expect(h).toBe(Math.round(1080 * 0.32)); // short edge — landscape's `h`, untouched by the fix
    scene.destroy();
  });

  it('keeps every locked card\'s full-name label clear of its own "Locked" badge here too', () => {
    const scene = new TitlesScene(createLayout(1920, 1080), new InputManager(), baseCb());
    for (const { label, badge } of lockedLabelBadgePairs(scene)) {
      expect(bottomOf(label)).toBeLessThanOrEqual(topOf(badge));
    }
    scene.destroy();
  });
});
