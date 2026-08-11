// Regression coverage for design/game/LOBBY_IA_REDESIGN.md §22: GachaScene's contentBounds() was
// the one outlier in the shop group (Shop/Gacha/BattlePass/Recharge) — its portrait branch
// returned full width (100%) while BattlePassScene/RechargeScene both already reserved a 5%-per-
// side margin (90% total, same convention as LobbyScene's fullContentW, §21). Pins the fix and
// guards the landscape path (sidebar-rail offset, and the !openShop full-width fallback), which
// must stay byte-for-byte unchanged.
//
// contentBounds() is `protected` — reached via `as any`, same pattern already used for
// LobbyScene.btnRect a few describe blocks up in scenes.ui.ts. Runs under the headless PIXI
// adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { GachaScene, type GachaSceneCallbacks } from '../../src/scenes/GachaScene';
import { sidebarNavW } from '../../src/ui/widgets/HubTabs';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const PORTRAIT: [number, number] = [800, 1280];
const LANDSCAPE: [number, number] = [1280, 800];

function buildGacha(w: number, h: number, cb: Partial<GachaSceneCallbacks>) {
  const layout = createLayout(w, h);
  const scene = new GachaScene(layout, new InputManager(), {
    onBack() {},
    getCoins: () => 1000,
    getPity: () => 0,
    getFatePoints: () => 0,
    loadPools: async () => [],
    draw: async () => ({ ok: true, results: [], overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 } }),
    redeemFate: async () => ({ ok: true, granted: 'placeholder' }),
    ...cb,
  });
  return { scene, layout };
}

// `contentBounds` lives on the composed `core` field (2026-08-11: GachaScene converted from a
// mixin-chain `extends` to composition — see claudedocs/client-modules.md's split-form priority note).
function contentBounds(scene: GachaScene): { x0: number; w: number } {
  return (scene as any).core.contentBounds();
}

describe('GachaScene — contentBounds() follows orientation (LOBBY_IA_REDESIGN §22)', () => {
  it('portrait + shop group: 90% width, 5%-of-w pad each side (was 100% — the bug)', () => {
    const { scene, layout } = buildGacha(...PORTRAIT, { openShop() {} });
    const pad = Math.round(layout.designWidth * 0.05);
    expect(contentBounds(scene)).toEqual({ x0: pad, w: layout.designWidth - pad * 2 });
    scene.destroy();
  });

  it('portrait, no shop group (openShop absent): also 90% — portrait branch no longer keys off openShop', () => {
    const { scene, layout } = buildGacha(...PORTRAIT, {});
    const pad = Math.round(layout.designWidth * 0.05);
    expect(contentBounds(scene)).toEqual({ x0: pad, w: layout.designWidth - pad * 2 });
    scene.destroy();
  });

  it('landscape + shop group: unchanged — offset right of the sidebar rail, not 90%', () => {
    const { scene, layout } = buildGacha(...LANDSCAPE, { openShop() {} });
    const { designWidth: w, designHeight: h } = layout;
    const gap = Math.round(w * 0.02);
    const x0 = sidebarNavW(w, h, true) + gap;
    expect(contentBounds(scene)).toEqual({ x0, w: w - x0 - gap });
    scene.destroy();
  });

  it('landscape, no shop group: unchanged — full width, no margin at all', () => {
    const { scene, layout } = buildGacha(...LANDSCAPE, {});
    expect(contentBounds(scene)).toEqual({ x0: 0, w: layout.designWidth });
    scene.destroy();
  });
});
