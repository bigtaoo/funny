// Regression for the 2026-09-15 sweep finding on `narrow-360x640-de` (fixed 2026-09-29, UI design
// log §68.1): the weekly chest card wrapped its progress label at a flat `cardW * 0.55` and drew the
// reward row at a fixed `cardH * 0.58`, so German's "9 / 9 Aktivitätspunkte" broke into three lines
// and the third one landed on the reward icon and its "+20".
//
// The headless harness measures every string at a flat 7 px per character whatever the font size,
// so no real translation wraps here. Same lever as `battlePassXpBarOverlap.ui.ts`: `t()` is mocked
// for the one key to return a string long enough to wrap even at the legibility floor. What is held
// is the geometry the fix promises, not a pixel count: the label wraps against the strip left of
// the Claim button, and the reward row starts below the label's real bottom however many lines
// it takes.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';

/** Many short words, so it wraps line by line instead of breaking one long word. */
const LONG_PROGRESS = Array.from({ length: 200 }, () => 'Aktiv').join(' ');

vi.mock('../../src/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/i18n')>();
  return {
    ...actual,
    t: (key: string, params?: Record<string, string | number>) =>
      key === 'daily.weekly.pointsProgress' ? LONG_PROGRESS : actual.t(key as never, params),
  };
});

import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { DailyScene } from '../../src/scenes/DailyScene';
import { makeNewSave, type SaveData } from '../../src/game/meta/SaveData';
import type { RetentionView } from '../../src/net/ApiClient';
import { makeWeekKey } from '../../src/game/meta/retention';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function retention(): RetentionView {
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
        { threshold: 15, reward: { kind: 'material', count: 30, id: 'lead' } },
        { threshold: 21, reward: { kind: 'material', count: 40, id: 'lead' } },
      ],
    },
    claimable: { checkin: false, daily: false, weeklyTiers: [] },
    ads: { watchedToday: 0, cap: 5, rewardCoins: 10, cooldownMs: 0, nextAvailableAt: 0 },
  };
}

type Internals = {
  activeTab: string;
  render(): void;
  hits: Array<{ rect: { x: number; y: number; w: number; h: number } }>;
};

function texts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (n: PIXI.Container): void => {
    if (n instanceof PIXI.Text) out.push(n);
    for (const c of n.children) walk(c as PIXI.Container);
  };
  walk(root);
  return out;
}

async function weeklyScene(w: number, h: number): Promise<DailyScene> {
  // Every tier claimable, so every card registers its Claim button as a hit.
  const save: SaveData = {
    ...makeNewSave(),
    retention: { weekly: { weekKey: makeWeekKey(Date.now()), points: 21, claimedTiers: [] } },
  };
  const scene = new DailyScene(createLayout(w, h), new InputManager(), {
    onBack() {},
    getSave: () => save,
    getRetention: () => Promise.resolve(retention()),
    onClaimWeekly: () => Promise.resolve(null as never),
  });
  await new Promise((r) => setTimeout(r, 0));
  const s = scene as unknown as Internals;
  s.activeTab = 'weekly';
  s.render();
  return scene;
}

describe('DailyScene weekly tab — progress label and reward row share the card without overlapping', () => {
  for (const [w, h] of [[360, 640], [390, 844], [844, 390]] as const) {
    it(`${w}x${h}: the reward row starts below the wrapped label, and the label stops short of Claim`, async () => {
      const scene = await weeklyScene(w, h);
      const all = texts(scene.container);
      const labels = all.filter((t) => t.text === LONG_PROGRESS).sort((a, b) => a.y - b.y);
      expect(labels).toHaveLength(3);

      const claims = (scene as unknown as Internals).hits
        .map((hit) => hit.rect)
        // The Claim buttons: right of the labels (not the landscape sidebar or the back button) and
        // level with a card (not the header row above the first one).
        .filter((r) => r.x > labels[0]!.x && labels.some((l) => r.y > l.y - r.h && r.y < l.y + r.h))
        .sort((a, b) => a.y - b.y);
      expect(claims).toHaveLength(3);

      for (const [i, count] of [20, 30, 40].entries()) {
        const label = labels[i]!;
        // Precondition: the mocked string really does wrap, so the row below has to follow it.
        expect(PIXI.TextMetrics.measureText(label.text, label.style, true).lines.length).toBeGreaterThan(1);
        const reward = all.find((t) => t.text === `+${count}`);
        expect(reward).toBeDefined();
        expect(reward!.y).toBeGreaterThanOrEqual(label.y + label.height);
        expect(label.x + (label.style.wordWrapWidth as number)).toBeLessThanOrEqual(claims[i]!.x);
      }
      scene.destroy();
    });
  }
});
