// Coverage for the weekly active chest tab added to DailyScene (ECONOMY_NUMBERS §12.3, 2026-08-05).
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
import { makeWeekKey } from '../../src/game/meta/retention';
import { setToastSink } from '../../src/net/log';

// The scene reads Date.now() internally (no injectable clock) — retention.weekly.weekKey must be
// the REAL current ISO week key, or weeklyPoints()/weeklyClaimableTiers() treat it as stale and
// silently zero it out (the exact bug class fixed in server/metaserver's retention e2e test).
const CURRENT_WEEK_KEY = makeWeekKey(Date.now());

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

function retentionWithTiers(): RetentionView {
  return {
    checkin: null,
    daily: null,
    weekly: null,
    defs: {
      rewards: [],
      tasks: [],
      pointsThreshold: 3,
      dailyCoinsReward: 5,
      weeklyChestTiers: [
        { threshold: 9, reward: { kind: 'material', count: 20, id: 'lead' } },
        { threshold: 15, reward: { kind: 'equipment', count: 1 } },
        { threshold: 21, reward: { kind: 'card', count: 1 } },
      ],
    },
    claimable: { checkin: false, daily: false, weeklyTiers: [] },
    ads: { watchedToday: 0, cap: 5, rewardCoins: 10, cooldownMs: 0, nextAvailableAt: 0 },
  };
}

type Internals = {
  activeTab: string;
  render(): void;
  hits: Array<{ x: number; y: number; w: number; h: number; fn: () => void }>;
  bt: { busy: boolean };
  update(dt: number): void;
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildDaily(save: SaveData, cb: Partial<DailyCallbacks> = {}): DailyScene {
  return new DailyScene(createLayout(800, 1280), new InputManager(), {
    onBack() {},
    getSave: () => save,
    getRetention: () => Promise.resolve(retentionWithTiers()),
    ...cb,
  });
}

describe('DailyScene — header title follows the active tab', () => {
  // Regression for the 2026-08-08 bug: the top SceneHeader used to be hardcoded to t('daily.title')
  // ("Daily") no matter which sidebar tab was active, so the Weekly Chest tab still read "Daily" at
  // the top — misleading since the tab content right below it is clearly weekly-scoped.
  it('shows the weekly-tab title, not the generic "Daily" hub title, when the weekly tab is active', async () => {
    const save: SaveData = { ...makeNewSave(), retention: { weekly: { weekKey: CURRENT_WEEK_KEY, points: 0, claimedTiers: [] } } };
    const scene = buildDaily(save);
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'weekly';
    s.render();

    expect(findText(scene.container, (txt) => txt === t('daily.title'))).toBeNull();
    expect(findText(scene.container, (txt) => txt === t('daily.weekly.title'))).not.toBeNull();
    scene.destroy();
  });

  it('shows the tasks-tab title when the daily-tasks tab is active', async () => {
    const save: SaveData = { ...makeNewSave() };
    const scene = buildDaily(save);
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'tasks';
    s.render();

    expect(findText(scene.container, (txt) => txt === t('daily.title'))).toBeNull();
    expect(findText(scene.container, (txt) => txt === t('daily.tasks.title'))).not.toBeNull();
    scene.destroy();
  });
});

describe('DailyScene — weekly active chest tab', () => {
  it('shows the points progress for each of the three tiers', async () => {
    const save: SaveData = {
      ...makeNewSave(),
      retention: { weekly: { weekKey: CURRENT_WEEK_KEY, points: 12, claimedTiers: [] } },
    };
    const scene = buildDaily(save);
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'weekly';
    s.render();

    expect(findText(scene.container, (txt) => txt.includes('9'))).not.toBeNull();
    expect(findText(scene.container, (txt) => txt.includes('15'))).not.toBeNull();
    expect(findText(scene.container, (txt) => txt.includes('21'))).not.toBeNull();
    scene.destroy();
  });

  // Covers renderWeekly's singleItem check (equipment/card kinds render icon-only, no "+N" —
  // mirrors BattlePassScene's single-item skin display; material renders "+N" alongside its icon).
  it('the material tier shows a "+20" count; the equipment and card tiers (single-item rewards) show no count', async () => {
    const save: SaveData = {
      ...makeNewSave(),
      retention: { weekly: { weekKey: CURRENT_WEEK_KEY, points: 21, claimedTiers: [] } },
    };
    const scene = buildDaily(save);
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'weekly';
    s.render();

    expect(findText(scene.container, (txt) => txt === '+20')).not.toBeNull(); // tier 1: material x20
    expect(findText(scene.container, (txt) => txt === '+1')).toBeNull(); // tiers 2/3: equipment + card are single-item, no count text
    scene.destroy();
  });

  it('a tier below its threshold has no claim hit registered (nav-only hit count baseline)', async () => {
    const save: SaveData = {
      ...makeNewSave(),
      retention: { weekly: { weekKey: CURRENT_WEEK_KEY, points: 5, claimedTiers: [] } },
    };
    let called = false;
    const scene = buildDaily(save, {
      async onClaimWeekly() { called = true; return { reward: { kind: 'material', count: 20, id: 'lead' } }; },
    });
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'weekly';
    s.render();

    // Below every threshold (5 < 9/15/21) → renderWeekly registers zero claim hits; only the
    // always-present nav hits remain (back button + the 2 *inactive* sidebar tabs — the
    // currently-active 'weekly' tab gets no hit of its own, per HubTabs.drawBottomNavTabs).
    const baseline = s.hits.length;
    for (const hit of [...s.hits]) hit.fn(); // clicking any of them (back/tab-switch) must never fire the claim callback
    await flush();
    expect(called).toBe(false);
    expect(baseline).toBe(3);
    scene.destroy();
  });

  it('a reached-but-unclaimed tier is clickable and calls onClaimWeekly with that threshold', async () => {
    const save: SaveData = {
      ...makeNewSave(),
      retention: { weekly: { weekKey: CURRENT_WEEK_KEY, points: 9, claimedTiers: [] } },
    };
    let claimedThreshold: number | null = null;
    const scene = buildDaily(save, {
      async onClaimWeekly(threshold: number) {
        claimedThreshold = threshold;
        return { reward: { kind: 'material', count: 20, id: 'lead' } };
      },
    });
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'weekly';
    s.render();

    // Exactly one tier (threshold=9) is claimable at 9 points → exactly one hit beyond the
    // nav-only baseline of 3 (back + the 2 inactive sidebar tabs), appended last since
    // renderWeekly runs after drawSidebarTabs.
    expect(s.hits.length).toBe(4);
    s.hits[s.hits.length - 1]!.fn();
    await flush();

    expect(claimedThreshold).toBe(9);
    expect(s.bt.busy).toBe(false);
    scene.destroy();
  });

  it('a claimed tier shows the "already claimed" state, not a clickable Claim button', async () => {
    const save: SaveData = {
      ...makeNewSave(),
      retention: { weekly: { weekKey: CURRENT_WEEK_KEY, points: 9, claimedTiers: [9] } },
    };
    const scene = buildDaily(save);
    await flush();
    const s = scene as unknown as Internals;
    s.activeTab = 'weekly';
    s.render();

    expect(findText(scene.container, (txt) => txt === t('daily.tasks.rewardClaimed'))).not.toBeNull();
    scene.destroy();
  });
});

describe('DailyScene — weekly chest claim toast per reward kind', () => {
  function claimViaLastHit(scene: DailyScene): void {
    const s = scene as unknown as Internals;
    s.activeTab = 'weekly';
    s.render();
    s.hits[s.hits.length - 1]!.fn();
  }

  it('material reward toast', async () => {
    const save: SaveData = { ...makeNewSave(), retention: { weekly: { weekKey: CURRENT_WEEK_KEY, points: 9, claimedTiers: [] } } };
    let toast: string | null = null;
    setToastSink((text) => { toast = text; });
    const scene = buildDaily(save, {
      async onClaimWeekly() { return { reward: { kind: 'material', count: 20, id: 'lead' } }; },
    });
    await flush();
    claimViaLastHit(scene);
    await flush();

    expect(toast).toBe(t('daily.checkin.rewardMaterial', { n: 20 }));
    scene.destroy();
    setToastSink(() => {});
  });

  it('equipment reward toast', async () => {
    const save: SaveData = { ...makeNewSave(), retention: { weekly: { weekKey: CURRENT_WEEK_KEY, points: 15, claimedTiers: [9] } } };
    let toast: string | null = null;
    setToastSink((text) => { toast = text; });
    const scene = buildDaily(save, {
      async onClaimWeekly() { return { reward: { kind: 'equipment', count: 1, id: 'eq_t1_sword' } }; },
    });
    await flush();
    claimViaLastHit(scene);
    await flush();

    expect(toast).toBe(t('daily.checkin.rewardEquipment'));
    scene.destroy();
    setToastSink(() => {});
  });

  it('card reward toast (tier 3, replaced the shop skin with a random legendary card, 2026-08-08)', async () => {
    const save: SaveData = { ...makeNewSave(), retention: { weekly: { weekKey: CURRENT_WEEK_KEY, points: 21, claimedTiers: [9, 15] } } };
    let toast: string | null = null;
    setToastSink((text) => { toast = text; });
    const scene = buildDaily(save, {
      async onClaimWeekly() { return { reward: { kind: 'card', count: 1, id: 'max' } }; },
    });
    await flush();
    claimViaLastHit(scene);
    await flush();

    expect(toast).toBe(t('daily.weekly.rewardCard'));
    scene.destroy();
    setToastSink(() => {});
  });

  it('a rejected claim (e.g. already claimed by a concurrent tab) shows an error toast and clears busy, without crashing', async () => {
    const save: SaveData = { ...makeNewSave(), retention: { weekly: { weekKey: CURRENT_WEEK_KEY, points: 9, claimedTiers: [] } } };
    let toastKind: string | null = null;
    setToastSink((_text, kind) => { toastKind = kind; });
    const scene = buildDaily(save, {
      async onClaimWeekly() { throw new Error('409 ALREADY_CLAIMED'); },
    });
    await flush();
    const s = scene as unknown as Internals;
    claimViaLastHit(scene);
    await flush();

    expect(toastKind).toBe('error');
    expect(s.bt.busy).toBe(false);
    scene.destroy();
    setToastSink(() => {});
  });
});
