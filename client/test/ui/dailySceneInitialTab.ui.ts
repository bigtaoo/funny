// Regression for the 09.08.2026 live bug report (account "tao"): the lobby's "每日" red dot was
// correctly lit (server GET /lobby/badges truth: weekly chest tier 9 unclaimed at 9 points, checkin
// already claimed today, daily tasks at 2/3), but DailyScene always opened on the hardcoded 'checkin'
// tab — which had nothing claimable that day — so the player saw an apparently-empty page and
// reported the red dot as broken. It wasn't stale data (the 09.08.2026 onSaveChanged fix was already
// live); the reward was sitting on the Weekly tab the whole time, just not the tab that opened.
// Fix: DailyScene now opens on whichever tab is actually claimable, in the same priority order the
// lobby dot itself uses (checkin || daily-tasks || weekly).
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
import { makeDayKey, makeMonthKey, makeWeekKey } from '../../src/game/meta/retention';

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

function buildDaily(save: SaveData, cb: Partial<DailyCallbacks> = {}): DailyScene {
  return new DailyScene(createLayout(800, 1280), new InputManager(), {
    onBack() {},
    getSave: () => save,
    getRetention: () => Promise.resolve(emptyRetention()),
    ...cb,
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type Internals = { activeTab: string };

describe('DailyScene — opens on whichever tab actually has something claimable (09.08.2026 fix)', () => {
  it('a clean save with nothing claimable anywhere still opens on Checkin (unchanged default)', async () => {
    const scene = buildDaily({ ...makeNewSave() });
    await flush();
    expect((scene as unknown as Internals).activeTab).toBe('checkin');
    expect(findText(scene.container, (txt) => txt === t('daily.checkin.title'))).not.toBeNull();
    scene.destroy();
  });

  it('checkin claimable wins even when weekly also has an unclaimed tier (priority order)', async () => {
    const weekKey = makeWeekKey(Date.now());
    const save: SaveData = {
      ...makeNewSave(),
      retention: { weekly: { weekKey, points: 9, claimedTiers: [] } },
    };
    const scene = buildDaily(save);
    await flush();
    expect((scene as unknown as Internals).activeTab).toBe('checkin');
    scene.destroy();
  });

  it('checkin already claimed today but daily tasks reached threshold → opens on Tasks', async () => {
    const dayKey = makeDayKey(Date.now());
    const monthKey = makeMonthKey(Date.now());
    const todayKey = dayKey;
    const save: SaveData = {
      ...makeNewSave(),
      retention: {
        checkin: { monthKey, claimedDays: [1], lastClaimedDayKey: todayKey },
        daily: { dayKey, completedTasks: { 'pve.clear': 1, 'pvp.match': 1, 'gacha.draw': 1 }, taskPoints: 3, rewardClaimed: false },
      },
    };
    const scene = buildDaily(save);
    await flush();
    expect((scene as unknown as Internals).activeTab).toBe('tasks');
    expect(findText(scene.container, (txt) => txt === t('daily.tasks.title'))).not.toBeNull();
    scene.destroy();
  });

  // Exact live repro: account "tao", 2026-08-09 — checkin claimed today, daily 2/3 points (not yet
  // claimable), weekly at 9 points with tier 9 unclaimed. Lobby's red dot was lit purely by `weekly`;
  // pre-fix the scene opened on Checkin and looked completely empty.
  it('checkin and tasks both settled but a weekly tier is unclaimed → opens on Weekly', async () => {
    const monthKey = makeMonthKey(Date.now());
    const dayKey = makeDayKey(Date.now());
    const weekKey = makeWeekKey(Date.now());
    const save: SaveData = {
      ...makeNewSave(),
      retention: {
        checkin: { monthKey, claimedDays: [1, 2, 3, 4, 5, 6, 7], lastClaimedDayKey: dayKey },
        daily: { dayKey, completedTasks: { 'gacha.draw': 1, 'pvp.match': 1 }, taskPoints: 2, rewardClaimed: false },
        weekly: { weekKey, points: 9, claimedTiers: [] },
      },
    };
    const scene = buildDaily(save);
    await flush();
    expect((scene as unknown as Internals).activeTab).toBe('weekly');
    expect(findText(scene.container, (txt) => txt === t('daily.weekly.title'))).not.toBeNull();
    scene.destroy();
  });

  it('everything already claimed (including weekly) → falls back to Checkin, not stuck on a blank Weekly tab', async () => {
    const monthKey = makeMonthKey(Date.now());
    const dayKey = makeDayKey(Date.now());
    const weekKey = makeWeekKey(Date.now());
    const save: SaveData = {
      ...makeNewSave(),
      retention: {
        checkin: { monthKey, claimedDays: [1], lastClaimedDayKey: dayKey },
        daily: { dayKey, completedTasks: {}, taskPoints: 3, rewardClaimed: true },
        weekly: { weekKey, points: 9, claimedTiers: [9] },
      },
    };
    const scene = buildDaily(save);
    await flush();
    expect((scene as unknown as Internals).activeTab).toBe('checkin');
    scene.destroy();
  });

  it('no getSave callback at all → defaults to checkin without throwing', async () => {
    const scene = new DailyScene(createLayout(800, 1280), new InputManager(), { onBack() {} });
    await flush();
    expect((scene as unknown as Internals).activeTab).toBe('checkin');
    scene.destroy();
  });
});
