// Regression for the 09.08.2026 "victory screen info all crammed together in portrait" bug
// (design/game/RESULT_SCREEN... n/a — pure layout fix, see ResultScene.ts comment at the fix site):
//
// The secondary-badge row (the small icon medallions below the hero badge's detail sentence) was
// positioned as `heroDetail.y + heroDetail.height - h * 0.041` — a small upward tuck tuned against
// landscape's fixed designHeight=1080. Portrait's design space swaps which axis is long: h there is
// PortraitLayout's designHeight (>=1920, see layout/PortraitLayout.ts), so the same `h`-scaled
// pull-up became large enough to drag the badge row up into the hero detail text — screenshotted as
// badge icons overlapping "took 0 damage". Landscape (short h=1080) never had the problem, so the
// fix only branches for portrait; this file locks that in both directions:
//   1. portrait: the secondary badge row's top no longer overlaps heroDetail's bottom edge.
//   2. landscape: the original tuck-up formula is untouched (regression guard).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { ResultScene } from '../../src/scenes/ResultScene';
import { initI18n } from '../../src/i18n';
import type { PlayerStats } from '@nw/engine/types';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// PortraitLayout/LandscapeLayout's real design-space output (layout/PortraitLayout.ts,
// layout/LandscapeLayout.ts): the short edge is pegged to 1080, the long edge to >=1920 — this is
// exactly what app.ts's showResult() passes in as ResultScene's (w, h) via layout.designWidth/
// designHeight, so these are the real dimensions the bug reproduced at (not just "any h > w").
const PORTRAIT_DESIGN: [number, number] = [1080, 1920];
const LANDSCAPE_DESIGN: [number, number] = [1920, 1080];

// Stats calibrated (same REF_* constants as ResultScene.ts) so computeBadges() returns exactly a
// hero badge (IRON_WALL, score 1.0 — took 0 of the REF_DAMAGE=150 reference damage) plus two
// secondary badges (TOP_DMG, EFFICIENT) — the exact 3-badge layout from the reported screenshot.
function badgeStats(owner: 0 | 1): PlayerStats {
  return {
    owner,
    damageDealtToBase: 102,
    damageTakenByBase: 0,
    unitsSent: 12,
    unitsKilled: 8,
    spellHits: 0,
    killsByType: {},
    castsByType: {},
    buildingSurvivalTicks: 0,
    goldSpent: 100,
  };
}

function buildScene(w: number, h: number): ResultScene {
  return new ResultScene(
    w, h, 0,
    [badgeStats(0), badgeStats(1)],
    { onPlayAgain() {}, onBack() {} },
  );
}

function findByName(scene: ResultScene, name: string): PIXI.Container[] {
  return scene.container.children.filter((c) => c.name === name) as PIXI.Container[];
}

describe('ResultScene — portrait secondary-badge row no longer overlaps hero detail (2026-08-09)', () => {
  it('portrait: every secondary badge medallion starts at or below heroDetail\'s bottom edge', () => {
    const [w, h] = PORTRAIT_DESIGN;
    const scene = buildScene(w, h);

    const heroDetail = findByName(scene, 'resultHeroDetail')[0];
    if (!heroDetail) throw new Error('resultHeroDetail text not found — expected a hero badge to render');
    const badges = findByName(scene, 'resultSecondaryBadge');
    expect(badges.length).toBeGreaterThan(0); // sanity: the calibrated stats do yield secondary badges

    const heroBottom = heroDetail.y + heroDetail.height;
    for (const badge of badges) {
      expect(badge.y).toBeGreaterThanOrEqual(heroBottom);
    }

    scene.destroy();
  });

  it('landscape: the original tuck-up formula is unchanged (regression guard)', () => {
    const [w, h] = LANDSCAPE_DESIGN;
    const scene = buildScene(w, h);

    const heroDetail = findByName(scene, 'resultHeroDetail')[0];
    if (!heroDetail) throw new Error('resultHeroDetail text not found — expected a hero badge to render');
    const badges = findByName(scene, 'resultSecondaryBadge');
    expect(badges.length).toBeGreaterThan(0);

    const expectedY = heroDetail.y + heroDetail.height - h * 0.041;
    for (const badge of badges) {
      expect(badge.y).toBeCloseTo(expectedY, 5);
    }

    scene.destroy();
  });
});
