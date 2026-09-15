// The achievement tier's claim button always fits its own label (2026-09-15, §53.4).
//
// The width was a fixed `rowH * 1.9`. On a phone held sideways the row is short, so `bh` — and the
// font derived from it — is small in DESIGN px, but the whole screen renders at 0.36x, and
// `drawButtonLabel` stops shrinking at the legibility floor and lets the label overflow rather than
// go under it (its own header, §50.12). "Claim +200" then ran out of both ends of the gold box.
// Same failure, same fix and same invariant as DailyScene's claim button
// (test/ui/dailySceneTasksClaimButtonWidth.ui.ts): the fraction stays as a FLOOR, and the label's
// measured width sets the ceiling-breaker, so this holds in any orientation and any locale.
//
// Found by looking at a screenshot, not by the gate: the layout sweep's seeded account had no
// claimable tier until the same pass gave it one, so this button had never been rendered in a
// sweep at all.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Its measureText is a flat 7px per
// character independent of font size, so a LONG STRING is the only lever this harness has to push a
// label past the fixed floor and actually exercise the fix — hence the implausible coin count
// below, the same trick the DailyScene test uses and for the same reason.
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { AchievementScene } from '../../src/scenes/AchievementScene';
import { buttonLabelIconW } from '../../src/ui/widgets/buttonLabel';
import { snapFont } from '../../src/render/fontScale';
import type { AchievementsView } from '../../src/net/ApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/**
 * Tier I claimed, tier II reached and claimable, tier III still running — the shape that puts a
 * claim button and a status tag on the same card. `coins` is typed `number`, but `t()` substitutes
 * with `String(v)`, so a digit-string smuggled through `as unknown` renders verbatim instead of
 * collapsing to exponential notation the way a real out-of-range number would.
 */
function view(coins: number | string): AchievementsView {
  return {
    defs: [{
      id: 'ach.campaign.chapters', statKey: 'campaign.chaptersCleared', category: 'pve',
      countsReplay: false,
      tiers: [
        { threshold: 1, coins: 100 },
        { threshold: 3, coins: coins as unknown as number },
        { threshold: 9, coins: 400 },
      ],
    }],
    stats: { 'campaign.chaptersCleared': 3 },
    achievements: { 'ach.campaign.chapters': { claimedTiers: [1] } },
  } as unknown as AchievementsView;
}

type Internals = { hits: Array<{ rect: { x: number; y: number; w: number; h: number }; sound?: string }> };

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function build(size: [number, number], coins: number | string): Promise<AchievementScene> {
  const scene = new AchievementScene(createLayout(size[0], size[1]), new InputManager(), {
    onBack() {},
    loadAchievements: () => Promise.resolve(view(coins)),
    onClaim: () => Promise.resolve(200),
  });
  await flush();
  return scene;
}

/** The claim button's hit is the one the scene tags with the reward sound. */
function claimHit(scene: AchievementScene): { x: number; y: number; w: number; h: number } {
  const hits = (scene as unknown as Internals).hits.filter((h) => h.sound === 'sfx.ui.reward');
  expect(hits).toHaveLength(1);
  return hits[0]!.rect;
}

function findText(root: PIXI.Container, text: string): PIXI.Text | null {
  let found: PIXI.Text | null = null;
  const walk = (n: PIXI.Container): void => {
    if (found) return;
    if (n instanceof PIXI.Text && n.text === text) { found = n; return; }
    for (const c of n.children) walk(c as PIXI.Container);
  };
  walk(root);
  return found;
}

describe('AchievementScene — the claim button fits its label in both orientations', () => {
  for (const [name, size] of [['portrait', [800, 1280]], ['landscape', [1280, 800]]] as const) {
    it(`${name}: the button is at least as wide as [gift][label] plus its padding`, async () => {
      const coins = '9'.repeat(60);
      const scene = await build(size as [number, number], coins);
      const rect = claimHit(scene);
      const label = findText(scene.container, t('achievement.claim', { coins }));
      expect(label).not.toBeNull();

      const fs = snapFont(Math.round(rect.h * 0.42));
      expect(rect.w).toBeGreaterThanOrEqual(label!.width + buttonLabelIconW(fs) + rect.h * 0.5);
      scene.destroy();
    });

    it(`${name}: a short label leaves the old fixed width alone`, async () => {
      // The fraction is a floor, not a replacement — an ordinary reward must not re-shape the
      // button, or every existing screenshot of this page changes for nothing.
      const short = await build(size as [number, number], 200);
      const long = await build(size as [number, number], '9'.repeat(60));
      expect(claimHit(short).w).toBeLessThan(claimHit(long).w);
      short.destroy();
      long.destroy();
    });
  }

  it('draws the claimed tier as a check tag rather than a second button', async () => {
    const scene = await build([800, 1280], 200);
    // One claimable tier → exactly one reward-sounding hit; the claimed tier above it is a tag.
    expect((scene as unknown as Internals).hits.filter((h) => h.sound === 'sfx.ui.reward')).toHaveLength(1);
    expect(findText(scene.container, t('achievement.claimed'))).not.toBeNull();
    scene.destroy();
  });
});
