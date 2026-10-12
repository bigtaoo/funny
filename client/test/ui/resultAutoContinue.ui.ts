// Next-level auto-continue on a won campaign level's result screen, and the outro story's
// auto-advance (ONBOARDING_DESIGN §13). The countdown presses the primary button by itself unless the
// player touches the screen — anywhere, not only a control — and the buttons must stay clickable
// while it runs. Hit-testing goes through a real PIXI.EventBoundary, like a live pointer: a bare
// `.emit` on the found node would pass even if the countdown's tap catcher swallowed the buttons.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { ResultScene, type ResultSceneCallbacks } from '../../src/scenes/ResultScene';
import { initI18n } from '../../src/i18n';
import type { PlayerStats } from '@nw/engine/types';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const VIEWPORTS: Array<[string, number, number]> = [
  ['portrait', 1080, 1920],
  ['landscape', 1920, 1080],
];

function zeroStats(owner: 0 | 1): PlayerStats {
  return {
    owner, damageDealtToBase: 0, damageTakenByBase: 0, unitsSent: 0, unitsKilled: 0,
    spellHits: 0, killsByType: {}, castsByType: {}, buildingSurvivalTicks: 0, goldSpent: 0,
  };
}

function build(w: number, h: number, extra: Partial<ResultSceneCallbacks>, outro?: string[]) {
  const calls = { next: 0, map: 0 };
  const scene = new ResultScene(w, h, 0, [zeroStats(0), zeroStats(1)], {
    onPlayAgain() { calls.next++; },
    onBack() {},
    playAgainLabel: 'NEXT LEVEL',
    secondaryAction: { label: 'BACK TO MAP', icon: 'mapPin', onTap() { calls.map++; } },
    ...extra,
  }, 0, undefined, undefined, outro);
  return { scene, calls };
}

function centerOf(node: PIXI.DisplayObject): { x: number; y: number } {
  const b = node.getBounds();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** The node a live tap at (x, y) reaches, and whether it bubbles up to the scene container. */
function tapTarget(scene: ResultScene, x: number, y: number): PIXI.DisplayObject | null {
  return new PIXI.EventBoundary(scene.container).hitTest(x, y);
}

describe('ResultScene — next-level auto-continue', () => {
  for (const [label, w, h] of VIEWPORTS) {
    it(`${label}: presses the primary button by itself once the countdown runs out`, () => {
      const { scene, calls } = build(w, h, { autoContinueSec: 5 });
      scene.update(4.9);
      expect(calls.next).toBe(0);
      scene.update(0.2);
      expect(calls.next).toBe(1);
      scene.update(10);
      expect(calls.next, 'pressed once, not every frame after').toBe(1);
      scene.destroy();
    });

    it(`${label}: a tap on empty page reaches the scene and stops the countdown`, () => {
      const { scene, calls } = build(w, h, { autoContinueSec: 5 });
      const hit = tapTarget(scene, w * 0.97, h * 0.5);
      expect(hit, 'an empty spot must still be hit, or the tap never reaches the cancel').not.toBeNull();
      scene.container.emit('pointerdown', {} as PIXI.FederatedPointerEvent); // what that hit bubbles up to
      scene.update(10);
      expect(calls.next).toBe(0);
      scene.destroy();
    });

    it(`${label}: the buttons stay clickable while the countdown runs`, () => {
      const { scene, calls } = build(w, h, { autoContinueSec: 5 });
      const cta = scene.container.getChildByName('resultPrimaryCta')!;
      const ctaHit = tapTarget(scene, centerOf(cta).x, centerOf(cta).y);
      expect(ctaHit?.name).toBe('resultPrimaryCta');
      const map = scene.container.getChildByName('resultSecondary:mapPin')!;
      const mapHit = tapTarget(scene, centerOf(map).x, centerOf(map).y);
      expect(mapHit?.name).toBe('resultSecondary:mapPin');
      ctaHit!.emit('pointertap', {} as PIXI.FederatedPointerEvent);
      expect(calls.next).toBe(1);
      scene.destroy();
    });
  }

  it('without autoContinueSec nothing presses itself', () => {
    const { scene, calls } = build(1920, 1080, {});
    scene.update(60);
    expect(calls.next).toBe(0);
    scene.destroy();
  });
});

describe('ResultScene — outro story auto-advance', () => {
  it('each page turns by itself after a dwell that grows with its length, capped', () => {
    const short = 'Short line.';
    const long = 'x'.repeat(400);
    const { scene } = build(1920, 1080, {}, [short, long]);
    expect(scene.container.getChildByName('resultPrimaryCta')).toBeNull();
    scene.update(2.5 + short.length * 0.045 + 0.05); // first page's dwell
    scene.update(9.9); // second page: capped at 10 s
    expect(scene.container.getChildByName('resultPrimaryCta')).toBeNull();
    scene.update(0.2);
    expect(scene.container.getChildByName('resultPrimaryCta')).not.toBeNull();
    scene.destroy();
  });
});
