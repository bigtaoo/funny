// The result screen's "come back tomorrow" check-in hook (RETENTION_LAUNCH_PLAN.md §3.3) —
// verifies the row ResultScene draws from a `retentionPreview` prop: it shows only on a win, stays
// above the primary CTA at every locale/viewport this repo's other ResultScene UI tests use, and
// does not draw at all when there is nothing to show (loss/draw, or no retentionPreview prop).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { ResultScene, type ResultRetentionPreview } from '../../src/scenes/ResultScene';
import { initI18n, setLocale, t, type Locale } from '../../src/i18n';
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

const PORTRAIT_DESIGN: [number, number] = [1080, 1920];
const LANDSCAPE_DESIGN: [number, number] = [1920, 1080];

// Zero stats -> no badges (`result.keepGoing` branch) — keeps the row's own position independent
// of the badge block, matching the "row anchors off primaryY, not headerBottom" design intent.
function zeroStats(owner: 0 | 1): PlayerStats {
  return {
    owner, damageDealtToBase: 0, damageTakenByBase: 0, unitsSent: 0, unitsKilled: 0,
    spellHits: 0, killsByType: {}, castsByType: {}, buildingSurvivalTicks: 0, goldSpent: 0,
  };
}

const PREVIEW: ResultRetentionPreview = { day: 1, reward: { kind: 'material', count: 3, id: 'scrap' } };

function buildScene(
  w: number, h: number, winner: 0 | 1 | null, retentionPreview?: ResultRetentionPreview,
): ResultScene {
  return new ResultScene(
    w, h, winner,
    [zeroStats(0), zeroStats(1)],
    { onPlayAgain() {}, onBack() {} },
    0, undefined, undefined, undefined, retentionPreview,
  );
}

function texts(root: PIXI.Container): Array<{ text: string; b: PIXI.Rectangle }> {
  const out: Array<{ text: string; b: PIXI.Rectangle }> = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) { out.push({ text: ch.text, b: ch.getBounds() }); continue; }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

describe('ResultScene — come back tomorrow check-in hook', () => {
  it('draws the reward icon + count + label on a win, above the primary button, at every locale', () => {
    for (const locale of ['zh', 'en', 'de'] as Locale[]) {
      setLocale(locale);
      try {
        const [w, h] = LANDSCAPE_DESIGN;
        const scene = buildScene(w, h, 0, PREVIEW);

        const all = texts(scene.container);
        const label = all.find((n) => n.text.includes(String(PREVIEW.day)) && n.text !== '+3');
        expect(label, `no day-${PREVIEW.day} label drawn (have: ${all.map((n) => n.text).join(' | ')})`).toBeDefined();
        expect(all.some((n) => n.text === '+3'), 'no reward count drawn').toBe(true);

        const primaryY = Math.round(h * 0.78);
        expect(label!.b.y + label!.b.height, 'reward row must sit above the primary CTA').toBeLessThanOrEqual(primaryY);
        expect(label!.b.x, 'label spills off the left edge').toBeGreaterThanOrEqual(0);
        expect(label!.b.x + label!.b.width, 'label spills off the right edge').toBeLessThanOrEqual(w);

        scene.destroy();
      } finally {
        setLocale('en');
      }
    }
  });

  it('fits on screen in portrait too', () => {
    const [w, h] = PORTRAIT_DESIGN;
    const scene = buildScene(w, h, 0, PREVIEW);
    const label = texts(scene.container).find((n) => n.text.includes(t('result.tomorrowReward', { day: 1 }).slice(0, 8)));
    expect(label).toBeDefined();
    expect(label!.b.x).toBeGreaterThanOrEqual(0);
    expect(label!.b.x + label!.b.width).toBeLessThanOrEqual(w);
    scene.destroy();
  });

  // Card/equipment milestone rewards are singleItem (CHECKIN_REWARDS' day-14/30 draws) — no "+N"
  // count, unlike every other reward kind. Only kind: 'material' was ever exercised above.
  it('milestone rewards (card/equipment) draw the icon + label with no "+N" count', () => {
    for (const kind of ['card', 'equipment'] as const) {
      const [w, h] = LANDSCAPE_DESIGN;
      const preview: ResultRetentionPreview = { day: 30, reward: { kind, id: 'x' } };
      const scene = buildScene(w, h, 0, preview);

      const all = texts(scene.container);
      expect(all.some((n) => n.text === t('result.tomorrowReward', { day: 30 })), `no label for ${kind}`).toBe(true);
      expect(all.some((n) => /^\+\d/.test(n.text)), `unexpected "+N" count drawn for singleItem kind ${kind}`).toBe(false);

      scene.destroy();
    }
  });

  it('draws nothing when there is no retentionPreview', () => {
    const [w, h] = LANDSCAPE_DESIGN;
    const scene = buildScene(w, h, 0, undefined);
    const all = texts(scene.container).map((n) => n.text);
    expect(all.some((s) => s.includes('scrap') || s === '+3')).toBe(false);
    scene.destroy();
  });

  it('draws nothing on a loss, even with a retentionPreview prop', () => {
    const [w, h] = LANDSCAPE_DESIGN;
    const scene = buildScene(w, h, 1, PREVIEW); // winner=1, localOwner=0 -> a loss
    const all = texts(scene.container).map((n) => n.text);
    expect(all.some((s) => s === '+3')).toBe(false);
    scene.destroy();
  });

  it('draws nothing on a draw, even with a retentionPreview prop', () => {
    const [w, h] = LANDSCAPE_DESIGN;
    const scene = buildScene(w, h, null, PREVIEW);
    const all = texts(scene.container).map((n) => n.text);
    expect(all.some((s) => s === '+3')).toBe(false);
    scene.destroy();
  });
});
