// Regression coverage for the 2026-07-29 SaveManager pub/sub fix (design/game/META_DESIGN.md §3.3
// "变更通知"): before this, a scene only re-read `saveManager.get()` on its own next render(). When
// two scenes are mounted at once via SceneManager.pushOverlay (e.g. WorldMapScene + a City/Friends/
// Sect/Auction overlay), spending coins in one didn't refresh the wallet balance shown by the other —
// it stayed stale until that scene happened to redraw for an unrelated reason.
//
// This test simulates that exact "two concurrently-mounted scenes share one SaveManager" scenario
// with two real, independently-constructed scenes (GachaScene + BattlePassScene — simplest pair that
// both display `getCoins()` in their header) wired the same way `nav/shop.ts` wires them in
// production: `getCoins: () => saveManager.get().wallet.coins` + `onSaveChanged: (fn) =>
// saveManager.subscribe(fn)`. A wallet mutation on the shared SaveManager, with neither scene's
// render() called manually, must be reflected in both.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { GachaScene } from '../../src/scenes/GachaScene';
import { BattlePassScene } from '../../src/scenes/BattlePassScene';
import { SaveManager } from '../../src/game/meta/SaveManager';
import { LocalSaveStore } from '../../src/game/meta/SaveStore';
import type { IStorage } from '../../src/platform/IPlatform';

class MemStorage implements IStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
}

initI18n('en', new MemStorage(), ['zh', 'en', 'de']);

const [W, H] = [800, 1280];

/** All PIXI.Text content currently in the display tree, recursing sub-containers (same helper as coinHeaderDisplay.ui.ts). */
function collectTexts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

describe('SaveManager.subscribe wired end-to-end: two concurrently-mounted scenes share one wallet view', () => {
  it('a wallet mutation on the shared SaveManager updates both scenes without either scene calling render() itself', () => {
    const mgr = new SaveManager({ store: new LocalSaveStore(new MemStorage()) });
    mgr.update((s) => { s.wallet.coins = 100; });

    // Mirrors nav/shop.ts's showGacha/showBattlePass wiring exactly.
    const onSaveChanged = (fn: () => void): (() => void) => mgr.subscribe(fn);

    const gacha = new GachaScene(createLayout(W, H), new InputManager(), {
      onBack() {},
      getCoins: () => mgr.get().wallet.coins,
      onSaveChanged,
      getPity: () => 0,
      getFatePoints: () => 0,
      loadPools: async () => [],
      draw: async () => ({ ok: true, results: [], overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 } }),
      redeemFate: async () => ({ ok: true, granted: 'placeholder' }),
    });
    const battlePass = new BattlePassScene(createLayout(W, H), new InputManager(), {
      onBack() {},
      getCoins: () => mgr.get().wallet.coins,
      onSaveChanged,
    });

    expect(collectTexts(gacha.container)).toContain((100).toLocaleString());
    expect(collectTexts(battlePass.container)).toContain((100).toLocaleString());

    // Simulate "the other scene spent/gained coins" — neither gacha nor battlePass calls render() itself.
    mgr.update((s) => { s.wallet.coins = 250; });

    expect(collectTexts(gacha.container)).toContain((250).toLocaleString());
    expect(collectTexts(battlePass.container)).toContain((250).toLocaleString());

    gacha.destroy();
    battlePass.destroy();
  });

  it('destroy() unsubscribes — a destroyed scene stops listening and a later mutation does not throw', () => {
    const mgr = new SaveManager({ store: new LocalSaveStore(new MemStorage()) });
    mgr.update((s) => { s.wallet.coins = 10; });
    const onSaveChanged = (fn: () => void): (() => void) => mgr.subscribe(fn);

    const gacha = new GachaScene(createLayout(W, H), new InputManager(), {
      onBack() {},
      getCoins: () => mgr.get().wallet.coins,
      onSaveChanged,
      getPity: () => 0,
      getFatePoints: () => 0,
      loadPools: async () => [],
      draw: async () => ({ ok: true, results: [], overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 } }),
      redeemFate: async () => ({ ok: true, granted: 'placeholder' }),
    });
    const battlePass = new BattlePassScene(createLayout(W, H), new InputManager(), {
      onBack() {},
      getCoins: () => mgr.get().wallet.coins,
      onSaveChanged,
    });

    gacha.destroy();
    // A destroyed scene's own onSaveChanged listener must be gone — the mutation must not throw
    // (e.g. by trying to render into a torn-down container) and the still-live scene keeps updating.
    expect(() => { mgr.update((s) => { s.wallet.coins = 999; }); }).not.toThrow();
    expect(collectTexts(battlePass.container)).toContain((999).toLocaleString());

    battlePass.destroy();
  });
});
