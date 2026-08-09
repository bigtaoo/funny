// Regression for the 2026-08-09 portrait row-spread fix (user report): renderCheckin's per-row
// vertical gap used to be a fixed `h*0.006` in both orientations, which — combined with cellH
// being capped by the cellW*0.8 aspect ratio once portrait's narrower content column shrinks
// cellW below what the tab's actual height could support — bunched all rows into the top third
// of the tab with a large blank void below (screenshot in the report). The fix spreads the gap
// across whatever vertical space is left, but ONLY in portrait — landscape (already correct per
// the report) must keep the exact original fixed-gap formula untouched.
//
// Follow-up (2026-08-09, second report): even with the spread fix, portrait's gaps still read as
// too large because 6 narrow columns capped cellW (and so cellH) small. Portrait now uses 5
// columns/6 rows instead of landscape's 6/5 — wider, taller cells that eat more of the available
// height and leave less to spread as gaps. Landscape is untouched (still 6 cols/5 rows).
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

/** Day-1/7/13/19/25 are the col-0 cell of each of the landscape 6-col/5-row grid's 5 rows — their
 *  number text's `.y` gives one sample point per row, in render order (top to bottom). */
function rowYsLandscape(container: PIXI.Container): number[] {
  return [1, 7, 13, 19, 25].map((day) => {
    const txt = findText(container, (s) => s === String(day));
    expect(txt).not.toBeNull();
    return txt!.y;
  });
}

/** Day-1/6/11/16/21/26 are the col-0 cell of each of the portrait 5-col/6-row grid's 6 rows. */
function rowYsPortrait(container: PIXI.Container): number[] {
  return [1, 6, 11, 16, 21, 26].map((day) => {
    const txt = findText(container, (s) => s === String(day));
    expect(txt).not.toBeNull();
    return txt!.y;
  });
}

function gapsOf(ys: number[]): number[] {
  return ys.slice(1).map((y, i) => y - ys[i]!);
}

describe('DailyScene checkin grid — row spacing (2026-08-09 portrait spread fix)', () => {
  it('portrait: the 6 rows are evenly spaced (no lopsided bunching)', async () => {
    const scene = await buildCheckinTab(800, 2160);
    const gaps = gapsOf(rowYsPortrait(scene.container));
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
    const shortGap = gapsOf(rowYsPortrait(shortScene.container))[0]!;
    shortScene.destroy();

    const tallScene = await buildCheckinTab(800, 4320); // double the design height (see PortraitLayout's aspect-driven designHeight)
    const tallGap = gapsOf(rowYsPortrait(tallScene.container))[0]!;
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
    const smallYs = rowYsLandscape(smallScene.container);
    smallScene.destroy();

    const bigScene = await buildCheckinTab(2560, 1600);
    const bigYs = rowYsLandscape(bigScene.container);
    bigScene.destroy();

    expect(gapsOf(smallYs)).toEqual(gapsOf(bigYs));
  });
});

/** Number text's `.x` for days 1..n, in day order — one sample per column of the first row. */
function colXs(container: PIXI.Container, days: number[]): number[] {
  return days.map((day) => {
    const txt = findText(container, (s) => s === String(day));
    expect(txt).not.toBeNull();
    return txt!.x;
  });
}

describe('DailyScene checkin grid — column count (2026-08-09 portrait 5-col tweak)', () => {
  it('portrait: lays out exactly 5 columns before wrapping to row 2 (not 6)', async () => {
    const scene = await buildCheckinTab(800, 2160);
    // Days 1-5 are row 0's 5 columns — strictly increasing x, evenly spaced.
    const rowXs = colXs(scene.container, [1, 2, 3, 4, 5]);
    for (let i = 1; i < rowXs.length; i++) expect(rowXs[i]!).toBeGreaterThan(rowXs[i - 1]!);
    const spacing = rowXs[1]! - rowXs[0]!;
    for (let i = 2; i < rowXs.length; i++) {
      expect(Math.abs((rowXs[i]! - rowXs[i - 1]!) - spacing)).toBeLessThan(1);
    }
    // Day 6 wraps back to column 0 (same x as day 1) on the next row (greater y) — if COLS were
    // still 6, day 6 would instead sit in row 0's 6th column (x further right than day 5, same y).
    const day1 = findText(scene.container, (s) => s === '1')!;
    const day6 = findText(scene.container, (s) => s === '6')!;
    expect(Math.abs(day6.x - day1.x)).toBeLessThan(1);
    expect(day6.y).toBeGreaterThan(day1.y);
    scene.destroy();
  });

  it('landscape: still lays out 6 columns before wrapping (must not regress — only portrait changed)', async () => {
    const scene = await buildCheckinTab(1280, 800);
    const rowXs = colXs(scene.container, [1, 2, 3, 4, 5, 6]);
    for (let i = 1; i < rowXs.length; i++) expect(rowXs[i]!).toBeGreaterThan(rowXs[i - 1]!);
    const spacing = rowXs[1]! - rowXs[0]!;
    for (let i = 2; i < rowXs.length; i++) {
      expect(Math.abs((rowXs[i]! - rowXs[i - 1]!) - spacing)).toBeLessThan(1);
    }
    const day1 = findText(scene.container, (s) => s === '1')!;
    const day7 = findText(scene.container, (s) => s === '7')!;
    expect(Math.abs(day7.x - day1.x)).toBeLessThan(1);
    expect(day7.y).toBeGreaterThan(day1.y);
    scene.destroy();
  });
});
