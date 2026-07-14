// SettingsScene rename button: one-time free rename UI. A player whose display name is still a
// system-assigned default (freeRename:true) sees a free rename button + hint and can open the rename
// dialog even with zero coins; once the free rename is spent (freeRename:false) the button reverts to
// the paid label and is disabled when the balance is short.
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — real PIXI tree, no renderer.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { SettingsScene, type SettingsSceneCallbacks } from '../../src/scenes/SettingsScene';

initI18n('en');

const W = 800, H = 1280;

function collectTexts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (n: PIXI.Container) => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

function build(overrides: Partial<SettingsSceneCallbacks>): SettingsScene {
  return new SettingsScene(createLayout(W, H), new InputManager(), {
    onBack() {},
    playerName: 'Tester',
    publicId: '123456789',
    pvp: { rank: 'bronze', elo: 1000 },
    renameCost: 500,
    getCoins: () => 0,
    onRename: async (name: string) => ({ ok: true, name }),
    ...overrides,
  });
}

describe('SettingsScene — one-time free rename', () => {
  it('freeRename:true shows the free label + hint even with zero coins', () => {
    const scene = build({ freeRename: true, getCoins: () => 0 });
    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('settings.renameFree'));
    expect(texts).toContain(t('settings.renameFreeHint'));
    // The paid label must not appear while the free rename is available.
    expect(texts).not.toContain(t('settings.rename', { cost: 500 }));
    scene.destroy();
  });

  it('freeRename:true is actionable with zero coins (a hit rect is registered for the button)', () => {
    const scene = build({ freeRename: true, getCoins: () => 0 });
    // With a free rename, the button is enabled → at least one interactive hit rect exists.
    const hits = (scene as unknown as { hits: unknown[] }).hits;
    expect(hits.length).toBeGreaterThan(0);
    scene.destroy();
  });

  it('freeRename:false with an insufficient balance shows the paid label, not the free one', () => {
    const scene = build({ freeRename: false, getCoins: () => 100 });
    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('settings.rename', { cost: 500 }));
    expect(texts).not.toContain(t('settings.renameFree'));
    scene.destroy();
  });
});
