// Regression for the friend "Player profile" popup (render/ProfilePopup.ts): the action row
// (Message / Block) used to be bottom-anchored — computed backward from the Close button — while
// the name/id/rank text flowed downward from the top. On a short card the two collided, so the
// Message/Block buttons rendered on top of the name and id lines (2026-07-22 bug report).
//
// The fix flows the buttons *below* the content and grows the card height to fit. This test builds
// the popup exactly as FriendsScene does (name + id + rank + Message/Block actions) and asserts the
// action buttons and Close button sit strictly below every info-text line — no vertical overlap.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n, setLocale, t } from '../../src/i18n';
import { ProfilePopup } from '../../src/render/ProfilePopup';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

type Box = { text: string; top: number; bottom: number; left: number; right: number };

/** World-space AABB of every non-empty PIXI.Text under `container` (respects anchor via getBounds). */
function collectTextBoxes(container: PIXI.Container): Box[] {
  const out: Box[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && node.text) {
      const b = node.getBounds();
      out.push({ text: node.text, top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width });
    }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

describe('friend profile popup: action row never overlaps the info lines', () => {
  // A short card (small h) is the worst case — this is where the old bottom-anchored layout collided.
  for (const [w, h] of [[1280, 720], [1920, 1080], [900, 600]] as const) {
    it(`${w}x${h}: Message/Block/Close sit below name+id+rank`, () => {
      setLocale('en');
      const popup = new ProfilePopup(w, h);
      popup.show({
        name: 'Playtester',
        publicId: '123456789',
        rankKey: 'rank.gold',
        actions: [
          { labelKey: 'friends.message', fn: () => {} },
          { labelKey: 'friends.block', fn: () => {}, danger: true },
        ],
      });

      const boxes = collectTextBoxes(popup.container);
      const find = (label: string): Box => {
        const b = boxes.find((x) => x.text === label);
        expect(b, `label "${label}" not rendered`).toBeDefined();
        return b!;
      };

      const idLine = find(`${t('profile.id')}  #123456789`);
      const message = find(t('friends.message'));
      const block = find(t('friends.block'));
      const close = find(t('profile.close'));

      // Every button label starts strictly below the id line (the lowest info line here).
      for (const [name, btn] of [['Message', message], ['Block', block], ['Close', close]] as const) {
        expect(btn.top, `${name} (top ${btn.top}) overlaps the id line (bottom ${idLine.bottom})`)
          .toBeGreaterThan(idLine.bottom);
      }

      // Message and Block share a row (roughly same y) and don't overlap horizontally.
      expect(Math.abs(message.top - block.top)).toBeLessThan(4);
      expect(message.right).toBeLessThan(block.left);

      // Close sits below the action row.
      expect(close.top).toBeGreaterThan(message.bottom);

      popup.destroy();
    });
  }
});
