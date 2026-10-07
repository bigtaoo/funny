// The one-shot opening-story card over the campaign map (ONBOARDING_DESIGN §11.7): one line, gone
// within ~3 s on its own, any tap dismisses it — and that tap must not also land on the map under it.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CampaignMapScene, type CampaignMapCallbacks } from '../../src/scenes/CampaignMapScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const layout = createLayout(1080, 1920);

function hasText(root: PIXI.Container, s: string): boolean {
  const stack: PIXI.DisplayObject[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n instanceof PIXI.Text && n.text === s) return true;
    if (n instanceof PIXI.Container) stack.push(...n.children);
  }
  return false;
}

function build(opts: { withCard: boolean; onSelectLevel?: (id: string) => void }) {
  const done: boolean[] = [];
  const input = new InputManager();
  const cb: CampaignMapCallbacks = {
    onBack() {},
    onSelectLevel: opts.onSelectLevel ?? (() => {}),
    onOpenEquipment() {},
    getStars: () => ({}),
    getCleared: () => [],
    isOnline: () => true,
    getPendingLevels: () => [],
    getStoryCard: () => opts.withCard
      ? { illustrationUrl: 'data:image/png;base64,', text: t('story.card'), onDone: (skipped) => { done.push(skipped); } }
      : null,
  };
  const scene = new CampaignMapScene(layout, input, cb);
  const levelHit = (): { x: number; y: number } => {
    const hits = (scene as unknown as { hits: Array<{ rect: { x: number; y: number; w: number; h: number } }> }).hits;
    const r = hits.find(({ rect }) => rect.y >= Math.round(layout.designHeight * 0.12))!.rect;
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };
  return { scene, input, done, levelHit };
}

describe('CampaignMapScene — opening-story card', () => {
  it('shows the one line, and closes by itself within ~3 s (not a tap gate)', () => {
    const { scene, done } = build({ withCard: true });
    expect(hasText(scene.container, t('story.card'))).toBe(true);
    for (let i = 0; i < 28; i++) scene.update(0.1); // 2.8 s
    expect(done).toEqual([]);
    for (let i = 0; i < 4; i++) scene.update(0.1); // 3.2 s
    expect(done).toEqual([false]);
    expect(hasText(scene.container, t('story.card'))).toBe(false);
    scene.update(1);
    expect(done, 'onDone fires once').toEqual([false]);
    scene.destroy();
  });

  it('a tap dismisses it and is swallowed — the level under it is not selected', () => {
    let selected: string | null = null;
    const { scene, input, done, levelHit } = build({ withCard: true, onSelectLevel: (id) => { selected = id; } });
    scene.update(0.5);
    const p = levelHit();
    input._emitDown(p.x, p.y);
    expect(selected).toBeNull();
    scene.update(0.5); // fade-out
    expect(done).toEqual([true]);
    // Card gone: the same tap now reaches the map.
    input._emitDown(p.x, p.y);
    expect(selected).not.toBeNull();
    scene.destroy();
  });

  it('no card when the nav says the story was already told', () => {
    let selected: string | null = null;
    const { scene, input, levelHit } = build({ withCard: false, onSelectLevel: (id) => { selected = id; } });
    expect(hasText(scene.container, t('story.card'))).toBe(false);
    const p = levelHit();
    input._emitDown(p.x, p.y);
    expect(selected).not.toBeNull();
    scene.destroy();
  });

  it('destroying the scene while the card is up does not throw or fire onDone', () => {
    const { scene, done } = build({ withCard: true });
    scene.update(0.2);
    expect(() => scene.destroy()).not.toThrow();
    expect(done).toEqual([]);
  });
});
