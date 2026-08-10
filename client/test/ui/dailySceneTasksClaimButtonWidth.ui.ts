// Regression for the 2026-08-10 bug report (screenshot): in portrait, the Daily Tasks tab's
// claim/claimed button background was sized as a fixed `cardW * 0.45` fraction of the card, while
// its label's font was sized off `cardH` (== btnH * 0.36). Portrait's `cardH` scales with the
// screen's tall *height* while `cardW` scales with its narrow *width*, so the same fraction that
// comfortably fit landscape's squat cards yielded a font too big for the box in portrait —
// "Claimed today" spilled past the gray button's right edge. Landscape was fine because its cardH
// (and thus font) is small relative to its wide cardW.
//
// Fix (DailyScene.renderDailyTasks): the button width is now `max(cardW * 0.45, label.width +
// pad)` — the fixed fraction stays as a floor (unchanged look for landscape's roomy cards), but the
// label's own measured width sets a ceiling-breaker so the button always fits its text, in any
// orientation or locale. These tests assert that invariant directly: the button (its Graphics
// background, found either via `hits` for the clickable claimable state, or as the last two
// children `renderDailyTasks` appends for the non-clickable claimed state) is always at least as
// wide as its label plus the fix's fixed padding — regardless of what the headless canvas mock's
// font-size-independent measureText (see harness/pixiHeadless.ts) would make any particular string
// render to in a real browser.
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { DailyScene, type DailyCallbacks } from '../../src/scenes/DailyScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData } from '../../src/game/meta/SaveData';
import type { RetentionView } from '../../src/net/ApiClient';
import { makeDayKey } from '../../src/game/meta/retention';

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

/**
 * A retention view whose `dailyCoinsReward` interpolates into an implausibly long label. The
 * headless canvas mock measures text as `text.length * 7`, independent of font size (see
 * harness/pixiHeadless.ts) — so, unlike a real browser, a *longer string* is the only lever this
 * harness has to push a label past the button's `cardW * 0.45` floor and actually exercise the
 * fix's ceiling-breaker branch. `dailyCoinsReward` is typed `number`, but `t()`'s substitution is
 * just `String(v)` — a huge digit-string plugged in via `as unknown` renders verbatim instead of
 * collapsing to exponential notation the way an actual out-of-range `number` would, which is what
 * makes this string long enough to matter without needing an unrealistic real font size.
 */
function retentionWithHugeReward(): RetentionView {
  const r = emptyRetention();
  return { ...r, defs: { ...r.defs, dailyCoinsReward: '9'.repeat(80) as unknown as number } };
}

type Internals = {
  activeTab: string;
  render(): void;
  hits: Array<{ x: number; y: number; w: number; h: number; fn: () => void }>;
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildDaily(save: SaveData, cb: Partial<DailyCallbacks>, layout: ReturnType<typeof createLayout>): DailyScene {
  return new DailyScene(layout, new InputManager(), {
    onBack() {},
    getSave: () => save,
    getRetention: () => Promise.resolve(emptyRetention()),
    ...cb,
  });
}

/** Fixed padding the fix adds around the label (btnH * 0.5) — mirrors DailyScene.renderDailyTasks. */
function expectedPad(btnH: number): number {
  return btnH * 0.5;
}

/**
 * `renderDailyTasks` appends the button's Graphics background then its Text label as the very
 * last two children it adds (nothing else is added after in `render()` while `bt.loadingVisible`
 * is false, which it is here) — so they're reliably the last two entries in `container.children`.
 * Used for the "already claimed" state, which registers no click hit to read geometry from another
 * way.
 */
function lastButtonPair(scene: DailyScene): { bg: PIXI.Graphics; label: PIXI.Text } {
  const children = scene.container.children;
  const label = children[children.length - 1] as PIXI.Text;
  const bg = children[children.length - 2] as PIXI.Graphics;
  expect(label).toBeInstanceOf(PIXI.Text);
  expect(bg).toBeInstanceOf(PIXI.Graphics);
  return { bg, label };
}

function claimedSave(): SaveData {
  const dayKey = makeDayKey(Date.now());
  return {
    ...makeNewSave(),
    retention: {
      daily: { dayKey, completedTasks: { 'pve.clear': 1, 'pvp.match': 1, 'gacha.draw': 1 }, taskPoints: 3, rewardClaimed: true },
    },
  };
}

function claimableSave(): SaveData {
  const dayKey = makeDayKey(Date.now());
  return {
    ...makeNewSave(),
    retention: {
      daily: { dayKey, completedTasks: { 'pve.clear': 1, 'pvp.match': 1, 'gacha.draw': 1 }, taskPoints: 3, rewardClaimed: false },
    },
  };
}

describe('DailyScene — daily-tasks claim button always fits its label (2026-08-10 portrait clipping fix)', () => {
  it('portrait, already-claimed state: the button background is at least as wide as "Claimed today" + padding', async () => {
    // onClaimDaily must be present even though it's never called here — renderDailyTasks only
    // draws the button at all when `this.cb.onClaimDaily` is set (see the `if` guard around it).
    const scene = buildDaily(claimedSave(), { async onClaimDaily() { return { coins: 5 }; } }, createLayout(800, 1280));
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'tasks';
    s.render();

    const { bg, label } = lastButtonPair(scene);
    expect(label.text).toBe(t('daily.tasks.rewardClaimed'));
    expect(bg.width).toBeGreaterThanOrEqual(label.width + expectedPad(bg.height));
    // Label stays centred in the (now possibly widened) button — a few px of slack for the
    // sketchPanel border's hand-drawn jitter, which nudges the Graphics' measured bounds slightly
    // off its nominal w/h (see sketchPanel/SketchPen), independent of this fix.
    expect(Math.abs(label.x - (bg.x + bg.width / 2))).toBeLessThan(3);
    scene.destroy();
  });

  it('portrait, claimable state: the clickable hit is at least as wide as "Claim +N coins" + padding', async () => {
    const scene = buildDaily(claimableSave(), { async onClaimDaily() { return { coins: 5 }; } }, createLayout(800, 1280));
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'tasks';
    s.render();

    const label = findText(scene.container, (txt) => txt === t('daily.tasks.rewardCoins', { n: 5 }));
    expect(label).not.toBeNull();
    const hit = s.hits[s.hits.length - 1]!;
    expect(hit.w).toBeGreaterThanOrEqual(label!.width + expectedPad(hit.h));
    scene.destroy();
  });

  it('landscape, already-claimed state: same invariant holds (fix is orientation-agnostic, not a portrait-only patch)', async () => {
    const scene = buildDaily(claimedSave(), { async onClaimDaily() { return { coins: 5 }; } }, createLayout(1280, 800));
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'tasks';
    s.render();

    const { bg, label } = lastButtonPair(scene);
    expect(label.text).toBe(t('daily.tasks.rewardClaimed'));
    expect(bg.width).toBeGreaterThanOrEqual(label.width + expectedPad(bg.height));
    expect(Math.abs(label.x - (bg.x + bg.width / 2))).toBeLessThan(3);
    scene.destroy();
  });

  it('landscape, claimable state: same invariant holds and the click hit still fires onClaimDaily', async () => {
    let claimed = false;
    const scene = buildDaily(claimableSave(), { async onClaimDaily() { claimed = true; return { coins: 5 }; } }, createLayout(1280, 800));
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'tasks';
    s.render();

    const label = findText(scene.container, (txt) => txt === t('daily.tasks.rewardCoins', { n: 5 }));
    expect(label).not.toBeNull();
    const hit = s.hits[s.hits.length - 1]!;
    expect(hit.w).toBeGreaterThanOrEqual(label!.width + expectedPad(hit.h));

    hit.fn();
    await flush();
    expect(claimed).toBe(true);
    scene.destroy();
  });

  // Discriminating regression test: with the pre-fix fixed `cardW * 0.45` button width, this label
  // (93 chars once interpolated) overflows the button — `hit.w` stays pinned at the floor no matter
  // how long the text gets. The fix's `Math.max(cardW * 0.45, label.width + pad)` grows the button
  // to match. Confirmed by temporarily reverting the fix locally: this test fails without it and
  // passes with it, unlike the others above (whose realistic-length strings never reach the floor
  // in this harness — see the file header comment).
  it('an implausibly long reward label still fits — the button grows past its cardW*0.45 floor to match', async () => {
    const scene = buildDaily(
      claimableSave(),
      { async onClaimDaily() { return { coins: 5 }; }, getRetention: () => Promise.resolve(retentionWithHugeReward()) },
      createLayout(800, 1280),
    );
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'tasks';
    s.render();

    const label = findText(scene.container, (txt) => txt === t('daily.tasks.rewardCoins', { n: '9'.repeat(80) }));
    expect(label).not.toBeNull();
    expect(label!.width).toBeGreaterThan(500); // sanity: this string is indeed long enough to matter
    const hit = s.hits[s.hits.length - 1]!;
    expect(hit.w).toBeGreaterThanOrEqual(label!.width + expectedPad(hit.h));
    scene.destroy();
  });
});
