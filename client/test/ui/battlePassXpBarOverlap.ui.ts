// Regression for the 2026-08-10 bug report (screenshot): in portrait, the XP progress bar's left
// label ("Lv.{n}") and right label ("{xp} XP · {n} XP to next level") are positioned at fixed
// `barW` fractions, but both labels' *font sizes* are derived from `barH` — the bar's height, not
// its width. Portrait's designWidth is pinned at 1080 while designHeight (and thus barH) grows
// with the screen's aspect ratio, so a tall/narrow phone blows up both fonts while the horizontal
// room stays the same — the long right-hand status text out-measured the gap left of it by the
// level badge and rendered directly on top of it (garbled overlapping digits in the screenshot).
//
// Fix (BattlePassScene, right after xpLbl is positioned): measure the actual room left of the
// measured levelLbl and shrink xpLbl via `.scale.set` if it overflows — same idiom as every other
// label-vs-available-width clamp in this codebase (CardCodexScene/AuctionScene/TitlesScene/...).
//
// Discriminating this in the headless harness needs a hack: `pixiHeadless.ts`'s `measureText` stub
// returns `text.length * 7`, independent of font size (see its own file header), so no *realistic*
// xp/level combination can ever produce a wide enough string to overflow the bar in this harness —
// the real bug only manifests because a real canvas scales glyph width with font size, which the
// stub doesn't model (confirmed manually against a real browser before this fix landed — see
// design/game/UI_DESIGN.md §30). To still get a test that fails without the fix and passes with it,
// this file mocks `t()` to return an implausibly long string for the one translation key
// (`battlepass.xpStatus`) that becomes the right-hand label — mirrors
// `dailySceneTasksClaimButtonWidth.ui.ts`'s `retentionWithHugeReward()` trick (long string is the
// only lever this harness has), just applied at the translation layer instead of the data layer
// since `xp`/`xpToNextLevel(xp)` are both clamped to small digit counts by real battle-pass data.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';

/** Long enough that even headless's flat `length * 7` measurement dwarfs any realistic bar width. */
const HUGE_XP_STATUS = 'X'.repeat(200);

vi.mock('../../src/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/i18n')>();
  return {
    ...actual,
    t: (key: string, params?: Record<string, string | number>) =>
      key === 'battlepass.xpStatus' ? HUGE_XP_STATUS : actual.t(key as never, params),
  };
});

import { initI18n } from '../../src/i18n';
import { BattlePassScene } from '../../src/scenes/BattlePassScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** levelLbl/xpLbl are added straight to `container` (not the scroll body), so this is unambiguous. */
function directTexts(scene: BattlePassScene): PIXI.Text[] {
  return (scene.container.children as PIXI.DisplayObject[]).filter((c): c is PIXI.Text => c instanceof PIXI.Text);
}

function buildScene(layout: ReturnType<typeof createLayout>): BattlePassScene {
  return new BattlePassScene(layout, new InputManager(), {
    onBack() {},
    getCoins: () => 0,
    // Level 17, xp === (17-1)*600: the exact values from the bug report screenshot. Immaterial to
    // the fix itself (only the mocked xpStatus string's *length* matters here), kept for parity
    // with the manual browser repro recorded in UI_DESIGN.md §30.
    getBattlePass: () => ({ seasonNo: 1, xp: 9600, level: 17, hasPass: false, claimedFree: [], claimedPaid: [] }),
  });
}

describe('BattlePassScene — XP bar level/status labels never overlap (2026-08-10 portrait overlap fix)', () => {
  it('portrait: an implausibly long XP-status string still leaves the level badge unobstructed', () => {
    const scene = buildScene(createLayout(390, 844));
    const texts = directTexts(scene);
    const levelLbl = texts.find((t) => t.text === 'Lv.17');
    const xpLbl = texts.find((t) => t.text === HUGE_XP_STATUS);
    expect(levelLbl).toBeDefined();
    expect(xpLbl).toBeDefined();
    // Sanity: this string is indeed long enough to matter in this harness (mirrors
    // dailySceneTasksClaimButtonWidth.ui.ts's equivalent sanity check).
    expect(xpLbl!.width).toBeGreaterThan(500);
    // The fix actually engaged (proves the invariant below isn't holding by accident) — and only
    // on the right-hand label; the level badge itself is never touched.
    expect(xpLbl!.scale.x).toBeLessThan(1);
    expect(levelLbl!.scale.x).toBe(1);
    const levelRight = levelLbl!.x + levelLbl!.width;
    const xpLeft = xpLbl!.x - xpLbl!.width; // anchor.x === 1, so .x is the right edge
    expect(xpLeft).toBeGreaterThanOrEqual(levelRight);
    scene.destroy();
  });

  it('landscape: same invariant holds (fix is orientation-agnostic, not a portrait-only patch)', () => {
    const scene = buildScene(createLayout(1280, 800));
    const texts = directTexts(scene);
    const levelLbl = texts.find((t) => t.text === 'Lv.17');
    const xpLbl = texts.find((t) => t.text === HUGE_XP_STATUS);
    expect(levelLbl).toBeDefined();
    expect(xpLbl).toBeDefined();
    const levelRight = levelLbl!.x + levelLbl!.width;
    const xpLeft = xpLbl!.x - xpLbl!.width;
    expect(xpLeft).toBeGreaterThanOrEqual(levelRight);
    scene.destroy();
  });
});
