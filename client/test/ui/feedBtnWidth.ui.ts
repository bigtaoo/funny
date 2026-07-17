// Verifies the feed modal's Confirm/Cancel buttons auto-fit their label width per locale:
// German "Zusammenbauen" is wider than Chinese "携手成长", and the button box must grow to fit
// so the label never overflows. Asserts each button label's measured width <= its button rect width.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, setLocale, t } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import type { CardInstance } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

type Hit = { rect: { x: number; y: number; w: number; h: number }; action: () => void };

function makeCard(id: string, defId: string, o: Partial<CardInstance> = {}): CardInstance {
  return { id, defId, level: 1, xp: 0, gear: {}, locked: false, ...o } as CardInstance;
}

/** Collect every PIXI.Text with its world position + measured width. */
function collectTexts(container: PIXI.Container): { text: string; x: number; y: number; w: number }[] {
  const out: { text: string; x: number; y: number; w: number }[] = [];
  const walk = (node: PIXI.Container, wx: number, wy: number, ws: number): void => {
    if (node instanceof PIXI.Text && node.text) {
      out.push({ text: node.text, x: wx, y: wy, w: node.width * ws });
    }
    for (const c of node.children) {
      const child = c as PIXI.Container;
      walk(child, wx + child.x * ws, wy + child.y * ws, ws * child.scale.x);
    }
  };
  walk(container, 0, 0, 1);
  return out;
}

describe('feed modal Confirm/Cancel buttons auto-fit label width per locale', () => {
  for (const loc of ['zh', 'en', 'de'] as const) {
    it(`${loc}: labels fit inside their buttons`, () => {
      setLocale(loc);
      const target = makeCard('target', 'lena');
      const cardInv: Record<string, CardInstance> = { target, mat0: makeCard('mat0', 'max') };
      const cb = {
        onBack() {}, getSave: () => ({ cardInv, equipmentInv: {}, wallet: { coins: 0 } }),
        feedCards: async () => ({ ok: true }), setCardLock: async () => ({ ok: true }),
        getOwnedSkins: () => [], getEquippedSkin: () => null, equipSkin() {},
      } as unknown as CardCallbacks;

      const scene = new CardScene(createLayout(1920, 1080), new InputManager(), cb);
      (scene as unknown as { openFeedSelect: (c: CardInstance) => void }).openFeedSelect(target);

      const hitsOf = (): Hit[] => (scene as unknown as { modalHits: Hit[] }).modalHits;
      // Select the material row so Confirm renders "(1)".
      const rowLabel = `${t('card.max.name' as never)} Lv.1`;
      const rowText = collectTexts(scene.container).find((tt) => tt.text === rowLabel)!;
      hitsOf().find((h) => rowText.x >= h.rect.x && rowText.x <= h.rect.x + h.rect.w && rowText.y >= h.rect.y && rowText.y <= h.rect.y + h.rect.h)!.action();

      const confirmLabel = `${t('roster.feedBtn')} (1)`;
      const cancelLabel = t('equip.cancel');
      const texts = collectTexts(scene.container);
      const hits = hitsOf();

      for (const label of [confirmLabel, cancelLabel]) {
        const txEntry = texts.find((tt) => tt.text === label);
        expect(txEntry, `${loc}: label "${label}" not rendered`).toBeDefined();
        const btn = hits.find((h) => txEntry!.x >= h.rect.x && txEntry!.x <= h.rect.x + h.rect.w && txEntry!.y >= h.rect.y && txEntry!.y <= h.rect.y + h.rect.h && h.rect.h < 120);
        expect(btn, `${loc}: no button hit under "${label}"`).toBeDefined();
        expect(txEntry!.w, `${loc}: "${label}" width ${txEntry!.w} overflows button width ${btn!.rect.w}`).toBeLessThanOrEqual(btn!.rect.w);
      }
    });
  }
});
