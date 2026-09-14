// Wiring coverage for the chapter-cleared stamp's corner choice (2026-09-14, bottom-up maps).
//
// `test/campaignMapBottomUp.test.ts` checks the RULE against all six bundled maps without a
// scene; this checks that buildChapter still routes the stamp through that rule instead of
// going back to a fixed corner. It asserts positions only — the headless text stub measures
// every glyph as ~7px regardless of font size, so no test at this layer may reason about how
// wide the stamp box or a marker's label actually is (that is what test:portrait is for).
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CampaignMapScene } from '../../src/scenes/CampaignMapScene';
import { CHAPTER_MAPS, CHAPTER_ORDER } from '../../src/game/campaign/maps';
import { clearStampX } from '../../src/scenes/CampaignMapScene/drawing';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1080, 1920];

/** Design-space x of a display object, summing the offsets on its way to the scene root. */
function absX(node: PIXI.DisplayObject, root: PIXI.Container): number {
  let x = 0;
  for (let n: PIXI.Container | null = node as PIXI.Container; n && n !== root; n = n.parent) x += n.x;
  return x;
}

/** First Text in the tree whose content satisfies `match`. */
function findText(root: PIXI.Container, match: (s: string) => boolean): PIXI.Text | null {
  const stack: PIXI.DisplayObject[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n instanceof PIXI.Text && match(n.text)) return n;
    if (n instanceof PIXI.Container) stack.push(...n.children);
  }
  return null;
}

describe('CampaignMapScene — cleared stamp takes the corner the BOSS marker is not in', () => {
  it('stamps the far corner on a fully cleared chapter', () => {
    // Every level cleared: the scene lands on the last chapter (progress landing, §12.2),
    // which is then fully cleared and so draws the stamp. That is chapter 6, whose boss
    // marker sits on the centre line (x = 0.50) and therefore pushes the stamp LEFT — the
    // exact pairing that overlapped before the corner became conditional.
    const cleared = CHAPTER_ORDER.flatMap((ch) => CHAPTER_MAPS[ch]!.nodes.map((n) => n.levelId));
    const landing = CHAPTER_ORDER[CHAPTER_ORDER.length - 1]!;

    const layout = createLayout(W, H);
    const scene = new CampaignMapScene(layout, new InputManager(), {
      onBack() {}, onSelectLevel() {}, onOpenEquipment() {},
      getStars: () => ({}),
      getCleared: () => cleared,
      isOnline: () => true,
      getPendingLevels: () => [],
    });

    const root = scene.container;
    const stamp = findText(root, (s) => s.includes(t('campaign.chapterStamp')));
    const boss = findText(root, (s) => s === t('campaign.markerBoss'));
    expect(stamp, 'cleared stamp is drawn').not.toBeNull();
    expect(boss, 'boss marker is drawn').not.toBeNull();

    const expected = clearStampX(CHAPTER_MAPS[landing]!, layout.designWidth);
    expect(absX(stamp!, root)).toBe(expected);

    // …and that value really is the other side of the page from the marker.
    const mid = layout.designWidth / 2;
    expect(absX(stamp!, root), 'stamp in the left half').toBeLessThan(mid);
    expect(absX(boss!, root), 'boss marker in the right half').toBeGreaterThan(mid);

    scene.destroy();
  });
});
