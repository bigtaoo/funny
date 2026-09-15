// Regression for the 2026-09-14 portrait cell-height pass (user report + screenshot, design log
// section 52). Two things are pinned here, both of which live in the same few lines:
//
//  1. Portrait sizes the cell off the grid's REAL available height and clips it on aspect
//     (PORTRAIT_MAX_ASPECT), instead of deriving it from cellW and spending the leftover on row
//     gaps. Everything inside a cell is a fraction of its height - the day number, the reward
//     glyph, the "+N", the bonus badge - so cell height is the only dial that reaches any of them,
//     and the 2026-08-09 pass was handing 48% of the grid's vertical extent to empty paper.
//  2. The day number clears the bonus-coin badge. The badge is pinned to the cell's top-RIGHT and
//     sized off `ch`; the number is centred and also sized off `ch`; the one dimension that decides
//     whether they meet - cell WIDTH - appears in neither. Landscape's 2.2:1 cell had width to
//     spare and never collided; the taller portrait cell (0.8:1) collided immediately, on days
//     14/21/30, and portrait now reserves a top strip for the badge instead.
//
// Everything asserted here is a POSITION or a style fontSize, never a measured text width: the
// headless PIXI adapter's `measureText` is a flat `length * 7` per character and ignores fontSize
// (test/harness/pixiHeadless.ts), so a width-derived overlap assertion would be measuring the
// harness. Real glyph widths are the real-browser audit's job (test/browser/portraitLayout.spec.ts),
// which is what caught the collision in the first place; this file is the cheap guard that runs in
// the default suite.
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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The 30 real check-in slots, with the four milestone days carrying bonus coins. */
function rewardDefs(): RetentionView['defs']['rewards'] {
  const bonus: Record<number, number> = { 7: 30, 14: 40, 21: 50, 30: 80 };
  return Array.from({ length: 30 }, (_, i) => ({
    kind: 'coins', count: 3, ...(bonus[i + 1] ? { bonusCoins: bonus[i + 1] } : {}),
  }));
}

function retentionWithRewards(): RetentionView {
  return {
    checkin: null,
    daily: null,
    weekly: null,
    defs: { rewards: rewardDefs(), tasks: [], pointsThreshold: 3, dailyCoinsReward: 5, weeklyChestTiers: [] },
    claimable: { checkin: false, daily: false, weeklyTiers: [] },
    ads: { watchedToday: 0, cap: 5, rewardCoins: 10, cooldownMs: 0, nextAvailableAt: 0 },
  };
}

async function buildCheckinTab(w: number, h: number): Promise<DailyScene> {
  const cb: DailyCallbacks = {
    onBack() {},
    getSave: () => makeNewSave(),
    getRetention: () => Promise.resolve(retentionWithRewards()),
  };
  const scene = new DailyScene(createLayout(w, h), new InputManager(), cb);
  await flush();
  const s = scene as unknown as { activeTab: string; render(): void };
  s.activeTab = 'checkin';
  s.render();
  return scene;
}

function one(container: PIXI.Container, s: string): PIXI.Text {
  const out: PIXI.Text[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && node.text === s) out.push(node);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  expect(out, `expected exactly one "${s}"`).toHaveLength(1);
  return out[0]!;
}

describe('DailyScene checkin grid - portrait cell height (2026-09-14)', () => {
  it('portrait: the cell keeps the height the old formula spent on row gaps, so every glyph in it grows', async () => {
    const scene = await buildCheckinTab(390, 844);
    // The day number is `snapFont(ch * 0.32)`, so it IS the cell height, read through the one
    // number this harness reports faithfully. The old derivation pinned cellH at cellW*0.8 = 143
    // design px, i.e. snapFont(round(131.7 * 0.32)) = snapFont(42) = 42. Anything above that means
    // the cell grew; the aspect cap puts it at 60 (the `display` tier, which is also the ladder's
    // top - see PORTRAIT_MAX_ASPECT's doc for why the cap sits just under it).
    expect(Number(one(scene.container, '1').style.fontSize)).toBeGreaterThan(42);
    scene.destroy();
  });

  it('portrait: the day number starts BELOW the bonus-coin badge, on every cell alike', async () => {
    const scene = await buildCheckinTab(390, 844);
    // The badge is drawn at ch*0.04 from the cell top and is ch*0.16 tall; the number's top is
    // reserved to ch*0.22. Comparing against the badge's OWN font size keeps this free of any
    // private constant: the badge glyph and its label are both ch*0.16, so clearing one font size
    // below the badge's top is exactly "the number starts under the badge".
    const badge = one(scene.container, '+40');
    const gap = one(scene.container, '14').y - badge.y;
    expect(gap).toBeGreaterThanOrEqual(Number(badge.style.fontSize));
    // ...and the reserve is uniform, so a badge-less day sits on the same baseline as day 14.
    expect(one(scene.container, '13').y).toBe(one(scene.container, '14').y);
    scene.destroy();
  });

  it('landscape: number offset and font are untouched by the portrait branch', async () => {
    // Same aspect, different absolute size: LandscapeLayout's design box resolves identically, so
    // every geometry input renderCheckin reads is the same and the rendered y/size must match
    // byte-for-byte. A portrait-only branch leaking into this path is what this catches.
    const small = await buildCheckinTab(1280, 800);
    const smallNum = one(small.container, '1');
    const smallY = smallNum.y;
    const smallFont = Number(smallNum.style.fontSize);
    const smallBadgeGap = one(small.container, '14').y - one(small.container, '+40').y;
    small.destroy();

    const big = await buildCheckinTab(2560, 1600);
    const bigNum = one(big.container, '1');
    expect(bigNum.y).toBe(smallY);
    expect(Number(bigNum.style.fontSize)).toBe(smallFont);
    // Landscape keeps the number BESIDE the badge (it has the width for it), so its vertical
    // offset from the badge stays the tiny ch*0.02 it always was - pinned here so a later pass
    // cannot quietly give landscape portrait's reserve and shrink its cell for nothing.
    expect(one(big.container, '14').y - one(big.container, '+40').y).toBe(smallBadgeGap);
    expect(smallBadgeGap).toBeLessThan(smallFont);
    big.destroy();
  });
});
