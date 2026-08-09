// Regression for the 09.08.2026 bug report: lobby's "每日" red dot was lit (server-fresh
// GET /lobby/badges truth) but opening DailyScene showed nothing claimable on any tab. Root cause —
// goDaily() fires `saveManager.refresh()` on entry so retention progress from a just-finished
// match shows immediately, but DailyScene never subscribed to save changes at all (every other
// post-lobby scene does, via `onSaveChanged` — see ShopScene/GachaScene/CardScene/...). If that
// refresh (or any other save mutation) resolved after DailyScene's own render, the scene was stuck
// showing whatever `save` snapshot existed at mount time forever, with no way to catch up.
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { DailyScene, type DailyCallbacks } from '../../src/scenes/DailyScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData } from '../../src/game/meta/SaveData';
import type { RetentionView } from '../../src/net/ApiClient';
import { makeDayKey } from '../../src/game/meta/retention';
import * as PIXI from 'pixi.js-legacy';

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

type Internals = {
  activeTab: string;
  render(): void;
  hits: Array<{ x: number; y: number; w: number; h: number; fn: () => void }>;
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('DailyScene — reacts to a save change after mount (2026-08-09 stale-render fix)', () => {
  it('registers onSaveChanged and re-renders the daily-tasks claim button once the local save catches up', async () => {
    const dayKey = makeDayKey(Date.now());
    // Mount with today's daily task points below the claim threshold — exactly what a stale local
    // save mirror would show if the server-side match-completion update (taskPoints -> 3) hasn't
    // landed in saveManager yet when the scene first renders.
    const save: SaveData = {
      ...makeNewSave(),
      retention: { daily: { dayKey, completedTasks: {}, taskPoints: 0, rewardClaimed: false } },
    };
    let savedListener: (() => void) | null = null;
    const cb: DailyCallbacks = {
      onBack() {},
      getSave: () => save,
      getRetention: () => Promise.resolve(emptyRetention()),
      onSaveChanged: (listener: () => void) => { savedListener = listener; return () => { savedListener = null; }; },
      async onClaimDaily() { return { coins: 5 }; },
    };
    const scene = new DailyScene(createLayout(800, 1280), new InputManager(), cb);
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'tasks';
    s.render();

    // Before the catch-up: 0/3 points, no claim button hit registered.
    expect(findText(scene.container, (txt) => txt === '0 / 3')).not.toBeNull();
    const baselineHits = s.hits.length;

    // The scene must actually have subscribed — this is exactly what was missing before the fix.
    expect(savedListener).not.toBeNull();

    // Simulate saveManager.refresh() resolving late (after this scene's own getRetention() round
    // trip already settled) and mutating the same local save object in place, then notifying.
    save.retention!.daily = { dayKey, completedTasks: { 'pve.clear': 1 }, taskPoints: 3, rewardClaimed: false };
    savedListener!();

    expect(findText(scene.container, (txt) => txt === '3 / 3')).not.toBeNull();
    expect(s.hits.length).toBe(baselineHits + 1); // the newly-claimable reward button is now clickable
    scene.destroy();
  });

  it('unsubscribes on destroy so a later save change cannot touch a torn-down container', async () => {
    const save: SaveData = { ...makeNewSave() };
    let unsubCalled = false;
    let savedListener: (() => void) | null = null;
    const cb: DailyCallbacks = {
      onBack() {},
      getSave: () => save,
      getRetention: () => Promise.resolve(emptyRetention()),
      onSaveChanged: (listener: () => void) => {
        savedListener = listener;
        return () => { unsubCalled = true; savedListener = null; };
      },
    };
    const scene = new DailyScene(createLayout(800, 1280), new InputManager(), cb);
    await flush();
    scene.destroy();

    expect(unsubCalled).toBe(true);
    // Firing a stale listener reference post-destroy must not throw (render() guards on `destroyed`).
    expect(() => savedListener?.()).not.toThrow();
  });
});
