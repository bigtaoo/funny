// What the Daily Tasks cards are allowed to say about their own state (2026-09-15, §53.2).
//
// Two decisions live here and both are the kind that get helpfully undone by the next person:
//
//   1. **A pending task draws NOTHING.** The three tasks are binary (shared/src/retention.ts
//      DAILY_TASKS: one point each, done once), so the "In progress" this replaced only ever meant
//      "not the other state" — which the paper-vs-green card fill and the `n / 3` tally under the
//      cards already say. An hourglass would have been the same non-statement in fewer pixels.
//      Re-adding a word or a glyph there is the regression this file exists to catch.
//   2. **The freed width goes to the label.** The label used to be capped at a flat `cardW * 0.6`
//      purely to clear the state word on its right; it is now wrapped against whatever the status
//      tag actually took, so a pending card — which has no tag — gets the whole card. That wiring
//      is invisible on screen until a label is long enough to wrap, so it is asserted on the style
//      rather than on the pixels.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts). Its
// measureText is a flat 7px per character, which is fine for both assertions: one counts nodes, the
// other compares two wrap widths the scene computed itself.
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { DailyScene, type DailyCallbacks } from '../../src/scenes/DailyScene';
import { makeNewSave, type SaveData } from '../../src/game/meta/SaveData';
import { makeDayKey } from '../../src/game/meta/retention';
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

function emptyRetention(): RetentionView {
  return {
    checkin: null, daily: null, weekly: null,
    defs: { rewards: [], tasks: [], pointsThreshold: 3, dailyCoinsReward: 5, weeklyChestTiers: [] },
    claimable: { checkin: false, daily: false, weeklyTiers: [] },
    ads: { watchedToday: 0, cap: 5, rewardCoins: 10, cooldownMs: 0, nextAvailableAt: 0 },
  };
}

/** A save with exactly the listed tasks done, dated today so the lazy boundary reset keeps it. */
function saveWith(done: string[]): SaveData {
  const completedTasks: Record<string, number> = {};
  for (const id of done) completedTasks[id] = 1;
  return {
    ...makeNewSave(),
    retention: {
      daily: {
        dayKey: makeDayKey(Date.now()),
        completedTasks: completedTasks as SaveData['retention'] extends undefined ? never
          : NonNullable<SaveData['retention']>['daily'] extends undefined ? never
            : NonNullable<NonNullable<SaveData['retention']>['daily']>['completedTasks'],
        taskPoints: done.length,
        rewardClaimed: false,
      },
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function collect<T extends PIXI.DisplayObject>(
  root: PIXI.Container, pick: (n: PIXI.DisplayObject) => n is T,
): T[] {
  const out: T[] = [];
  const walk = (node: PIXI.Container): void => {
    if (pick(node)) out.push(node);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(root);
  return out;
}

const isIcon = (kind: string) => (n: PIXI.DisplayObject): n is PIXI.DisplayObject =>
  n.name === `icon:${kind}`;
const isText = (n: PIXI.DisplayObject): n is PIXI.Text => n instanceof PIXI.Text;

/** The three task labels, in the order renderDailyTasks draws them. */
function taskLabels(scene: DailyScene): PIXI.Text[] {
  const wanted = ['daily.tasks.pveLabel', 'daily.tasks.pvpLabel', 'daily.tasks.gachaLabel']
    .map((k) => t(k as Parameters<typeof t>[0]));
  return collect(scene.container, isText).filter((n) => wanted.includes(n.text));
}

async function buildTasksTab(save: SaveData, size: [number, number]): Promise<DailyScene> {
  const cb: DailyCallbacks = {
    onBack() {},
    getSave: () => save,
    getRetention: () => Promise.resolve(emptyRetention()),
  };
  const scene = new DailyScene(createLayout(size[0], size[1]), new InputManager(), cb);
  await flush();
  const s = scene as unknown as { activeTab: string; render(): void };
  s.activeTab = 'tasks';
  s.render();
  return scene;
}

describe('DailyScene daily tasks — what a card says about its own state', () => {
  for (const [name, size] of [['portrait', [800, 1280]], ['landscape', [1280, 800]]] as const) {
    it(`${name}: a pending task draws no state at all`, async () => {
      const scene = await buildTasksTab(saveWith([]), size as [number, number]);
      expect(collect(scene.container, isIcon('check'))).toHaveLength(0);
      expect(collect(scene.container, isIcon('hourglassSm'))).toHaveLength(0);
      // Not just "no 'In progress'": nothing at all may stand in for it. The panel's whole text
      // budget is its section title, the three task labels and the `0 / 3` tally — with no
      // `onClaimDaily` callback the claim button is not drawn either. Asserted as the TAIL of the
      // scene's text, since the panel is drawn last and the header/tab chrome ahead of it is not
      // this test's business.
      const texts = collect(scene.container, isText).map((n) => n.text);
      expect(texts.slice(-5)).toEqual([t('daily.tasks.title'), ...taskLabels(scene).map((n) => n.text), '0 / 3']);
      scene.destroy();
    });

    it(`${name}: a done task gets one check, and only the done card gets one`, async () => {
      const scene = await buildTasksTab(saveWith(['pve.clear']), size as [number, number]);
      expect(collect(scene.container, isIcon('check'))).toHaveLength(1);
      expect(collect(scene.container, isText).map((n) => n.text)).toContain(t('daily.tasks.done'));
      scene.destroy();
    });
  }

  it('wraps a pending label against the whole card, and a done one against what the tag left', async () => {
    const pending = await buildTasksTab(saveWith([]), [800, 1280]);
    const done = await buildTasksTab(saveWith(['pve.clear']), [800, 1280]);

    // Same card, same label, different neighbour: `pve.clear` is the first task in both scenes.
    const pendingWrap = taskLabels(pending)[0]!.style.wordWrapWidth;
    const doneWrap = taskLabels(done)[0]!.style.wordWrapWidth;

    expect(doneWrap).toBeLessThan(pendingWrap);
    // ...and the pending one is genuinely the whole card rather than the old flat 60% cap. The two
    // untouched cards below it in the `done` scene are the control: they have no tag either, so
    // they must match the pending scene exactly.
    expect(taskLabels(done)[1]!.style.wordWrapWidth).toBe(pendingWrap);

    pending.destroy();
    done.destroy();
  });
});
