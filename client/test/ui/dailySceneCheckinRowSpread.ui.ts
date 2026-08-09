// Regression for the 2026-08-09 portrait row-spread fix (user report): renderCheckin's per-row
// vertical gap used to be a fixed `h*0.006` in both orientations, which — combined with cellH
// being capped by the cellW*0.8 aspect ratio once portrait's narrower content column shrinks
// cellW below what the tab's actual height could support — bunched all 5 rows into the top third
// of the tab with a large blank void below (screenshot in the report). The fix spreads the gap
// across whatever vertical space is left, but ONLY in portrait — landscape (already correct per
// the report) must keep the exact original fixed-gap formula untouched.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { DailyScene, type DailyCallbacks } from '../../src/scenes/DailyScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { RetentionView } from '../../src/net/ApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function findText(container: PIXI.Container, predicate: (s: string) => boolean): PIXI.Text | null {
  let found: PIXI.Text | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && predicate(node.text)) { found = node; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function emptyRetention(): RetentionView {
  return {
    checkin: null,
    daily: null,
    weekly: null,
    defs: { rewards: [], tasks: [], pointsThreshold: 3, dailyCoinsReward: 5, weeklyChestTiers: [] },
    claimable: { checkin: false, daily: false, weeklyTiers: [] },
    ads: { watchedToday: 0, cap: 5, rewardCoins: 10, cooldownMs: 0, nextAvailableAt: 0 },
  };
}

async function buildCheckinTab(w: number, h: number): Promise<DailyScene> {
  const cb: DailyCallbacks = {
    onBack() {},
    getSave: () => makeNewSave(),
    getRetention: () => Promise.resolve(emptyRetention()),
  };
  const scene = new DailyScene(createLayout(w, h), new InputManager(), cb);
  await flush();
  const s = scene as unknown as { activeTab: string; render(): void };
  s.activeTab = 'checkin';
  s.render();
  return scene;
}

/** Day-1/7/13/19/25 are the col-0 cell of each of the 6-col/5-row grid's 5 rows — their number
 *  text's `.y` gives one sample point per row, in render order (top to bottom). */
function rowYs(container: PIXI.Container): number[] {
  return [1, 7, 13, 19, 25].map((day) => {
    const txt = findText(container, (s) => s === String(day));
    expect(txt).not.toBeNull();
    return txt!.y;
  });
}

function gapsOf(ys: number[]): number[] {
  return ys.slice(1).map((y, i) => y - ys[i]!);
}

describe('DailyScene checkin grid — row spacing (2026-08-09 portrait spread fix)', () => {
  it('portrait: the 5 rows are evenly spaced (no lopsided bunching)', async () => {
    const scene = await buildCheckinTab(800, 2160);
    const gaps = gapsOf(rowYs(scene.container));
    for (const g of gaps.slice(1)) expect(Math.abs(g - gaps[0]!)).toBeLessThan(1);
    scene.destroy();
  });

  // PortraitLayout.designWidth is a fixed constant (1080) regardless of the screen width passed
  // in, so cellW/cellH — both derived from the tab's content width only — are identical between
  // these two renders; any change in the row gap can only come from the extra vertical room.
  // Old fixed-gap code: gap = cellH + h*0.006 → doubling the design height only grows the gap by
  // (h2-h1)*0.006, a few px. Fixed spread-to-fill code: the leftover vertical space (and so the
  // gap) grows roughly with the extra height itself — hundreds of px, not a handful.
  it('portrait: the row gap grows with the available height instead of staying pinned to a few px (proves the spread is live, not the old fixed h*0.006)', async () => {
    const shortScene = await buildCheckinTab(800, 2160);
    const shortGap = gapsOf(rowYs(shortScene.container))[0]!;
    shortScene.destroy();

    const tallScene = await buildCheckinTab(800, 4320); // double the design height (see PortraitLayout's aspect-driven designHeight)
    const tallGap = gapsOf(rowYs(tallScene.container))[0]!;
    tallScene.destroy();

    // Old code's growth for this height delta: (4320-2160)*0.006 ≈ 13px. Comfortably clear that
    // bar (without hard-coding the fix's own formula) confirms the gap is actually being spread
    // across the extra room, not just picking up the old formula's tiny height-proportional term.
    expect(tallGap - shortGap).toBeGreaterThan(50);
    expect(tallGap).toBeGreaterThan(shortGap);
  });

  it('landscape: row gap is a pure function of aspect ratio, unaffected by absolute screen size (must not regress — landscape was already correct per the report)', async () => {
    // LandscapeLayout.designHeight is a fixed constant (1080) regardless of input, and these two
    // configs share the same aspect ratio (1.6), so designWidth resolves identically too — every
    // geometry input renderCheckin reads is exactly the same between them. Old and new code alike
    // must therefore produce byte-for-byte identical row gaps; any divergence would mean the
    // portrait-only branch leaked into (or altered) the landscape path.
    const smallScene = await buildCheckinTab(1280, 800);
    const smallYs = rowYs(smallScene.container);
    smallScene.destroy();

    const bigScene = await buildCheckinTab(2560, 1600);
    const bigYs = rowYs(bigScene.container);
    bigScene.destroy();

    expect(gapsOf(smallYs)).toEqual(gapsOf(bigYs));
  });
});
