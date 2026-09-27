// Level prep's rewarded-ad stamina refill (CRAZYGAMES_LAUNCH §4): when the nav passes
// onWatchAdStamina (CrazyGames build only), the out-of-stamina row holds two buttons — coin refill
// left, ad refill right — instead of the single centred coin refill every other build keeps.
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect, beforeAll } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { LevelPrepScene, type LevelPrepCallbacks } from '../../src/scenes/LevelPrepScene';
import type { Hit } from '../../src/ui/hits';

type Rect = Hit['rect'];

function build(w: number, h: number, current: number, extra: Partial<LevelPrepCallbacks> = {}) {
  const calls: string[] = [];
  const scene = new LevelPrepScene(createLayout(w, h), new InputManager(), {
    onBack() {},
    onStart() { calls.push('start'); },
    levelNumber: 1,
    staminaCost: 10,
    getStamina: () => ({ current, regenAt: 0 }),
    onBuyStamina() { calls.push('buy'); },
    ...extra,
  });
  const hits = (scene as unknown as { hits: Hit[] }).hits;
  return { scene, hits, calls };
}

/** The refill row: hits whose top edge sits in the band just under the stamina line. */
function refillRow(hits: Hit[], calls: string[]): Array<{ rect: Rect; fires: string }> {
  return hits.map((hit) => {
    const before = calls.length;
    hit.fn();
    return { rect: hit.rect, fires: calls.slice(before).join(',') };
  }).filter((r) => r.fires === 'buy' || r.fires === 'ad');
}

const lowest = (hits: Hit[]): Rect => hits.map((h) => h.rect).reduce((a, b) => (b.y > a.y ? b : a));

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('LevelPrepScene — rewarded-ad stamina refill', () => {
  beforeAll(() => initI18n('en'));

  for (const [w, h] of [[1080, 1920], [1920, 1080]] as const) {
    it(`${w}x${h}: coin + ad buttons side by side, each wired to its own callback`, () => {
      const { scene, hits, calls } = build(w, h, 0, { onWatchAdStamina() { calls.push('ad'); } });
      const row = refillRow(hits, calls);
      expect(row.map((r) => r.fires)).toEqual(['buy', 'ad']);
      const [buy, ad] = row.map((r) => r.rect);
      expect(buy.y).toBe(ad.y);
      expect(buy.w).toBe(ad.w);
      expect(overlaps(buy, ad)).toBe(false);
      expect(buy.x + buy.w).toBeLessThan(ad.x);
      // The pair is centred as a group and sits wholly above the Start button (the lowest hit).
      expect(Math.abs(buy.x - (w - (ad.x + ad.w)))).toBeLessThanOrEqual(1);
      const start = lowest(hits);
      expect(buy.y + buy.h).toBeLessThanOrEqual(start.y);
      expect(buy.x).toBe(start.x);
      expect(ad.x + ad.w).toBe(start.x + start.w);
      scene.destroy();
    });

    it(`${w}x${h}: without the ad callback the coin refill stays alone and centred`, () => {
      const { scene, hits, calls } = build(w, h, 0);
      const row = refillRow(hits, calls);
      expect(row.map((r) => r.fires)).toEqual(['buy']);
      const [buy] = row.map((r) => r.rect);
      expect(Math.abs(buy.x - (w - (buy.x + buy.w)))).toBeLessThanOrEqual(1);
      expect(buy.y + buy.h).toBeLessThanOrEqual(lowest(hits).y);
      scene.destroy();
    });
  }

  it('enough stamina: no refill buttons at all, even with the ad callback', () => {
    const { scene, hits, calls } = build(1080, 1920, 120, { onWatchAdStamina() { calls.push('ad'); } });
    expect(refillRow(hits, calls)).toEqual([]);
    scene.destroy();
  });
});
