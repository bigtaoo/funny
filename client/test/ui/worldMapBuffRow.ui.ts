// Coverage for the S8-8 UI fix (2026-08-08): the capital-protection shield and the training-speedup
// shop buff both took effect server-side (PlayerWorldView.baseProtectedUntil / speedupUntil) but had
// no HUD readout at all — no way to see either was active or how much time was left. WorldMapPanels'
// status card now grows a compact buff row (icon + countdown chip per active buff) right below the
// troops/territory/resources block.
//
// Same lightweight fake-ctx harness as worldMapHeaderProduction.ui.ts — WorldMapPanels only reads
// plain-object fields off ctx, no need for the full WorldMapContext/WorldMapRenderer graph.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n, t } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1000, 700];
const TOP_INSET = 90;

function buildHudHarness(me: Partial<PlayerWorldView> = {}) {
  const ctx = {
    w: W, h: H,
    topInset: TOP_INSET,
    backRect: { x: 0, y: 0, w: 160, h: TOP_INSET },
    hudLayer: new PIXI.Container(),
    headerHudLayer: new PIXI.Container(),
    worldChatLatest: null,
    worldChatUnread: 0,
    zoom: 1 as const,
    me: {
      joined: true, troops: 10, troopCap: 100, territoryCount: 1,
      resources: {}, yieldRate: {}, ...me,
    },
    marches: [],
    marchesExpanded: false,
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[1]), Number(p[2])]; },
    cb: { accountId: 'me', getCoins: () => 0 },
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  return { ctx, panels };
}

/** All PIXI.Text content directly under ctx.hudLayer (the status card + buff row live here,
 *  not in headerHudLayer — see WorldMapPanels/hud.ts renderHud). */
function hudTexts(ctx: WorldMapContext): string[] {
  return (ctx.hudLayer.children as PIXI.DisplayObject[])
    .filter((c): c is PIXI.Text => c instanceof PIXI.Text)
    .map((tx) => tx.text);
}

describe('WorldMapPanels.renderHud — shield/speedup buff row (S8-8 UI fix, 2026-08-08)', () => {
  it('shows no buff chip at all when neither baseProtectedUntil nor speedupUntil is active', () => {
    const { ctx, panels } = buildHudHarness();
    panels.renderHud();
    const texts = hudTexts(ctx);
    expect(texts.some((s) => s.includes(t('world.protected').split('{d}')[0]!))).toBe(false);
    expect(texts.some((s) => s.includes(t('world.speedup').split('{d}')[0]!))).toBe(false);
  });

  it('shows a shield countdown chip when baseProtectedUntil is in the future', () => {
    const { ctx, panels } = buildHudHarness({ baseProtectedUntil: Date.now() + 3600_000 });
    panels.renderHud();
    const texts = hudTexts(ctx);
    // Countdown seconds are computed against Date.now() at render time — assert the label prefix
    // (same "don't pin the exact second" convention as cityTrainTroops.ui.ts's queue-entry test).
    const prefix = t('world.protected').split('{d}')[0]!;
    expect(texts.some((s) => s.startsWith(prefix))).toBe(true);
  });

  it('does not show the shield chip once baseProtectedUntil has passed', () => {
    const { ctx, panels } = buildHudHarness({ baseProtectedUntil: Date.now() - 1000 });
    panels.renderHud();
    const texts = hudTexts(ctx);
    const prefix = t('world.protected').split('{d}')[0]!;
    expect(texts.some((s) => s.startsWith(prefix))).toBe(false);
  });

  it('shows a training-speedup countdown chip when speedupUntil is in the future', () => {
    const { ctx, panels } = buildHudHarness({ speedupUntil: Date.now() + 1800_000 });
    panels.renderHud();
    const texts = hudTexts(ctx);
    const prefix = t('world.speedup').split('{d}')[0]!;
    expect(texts.some((s) => s.startsWith(prefix))).toBe(true);
  });

  it('does not show the speedup chip once speedupUntil has passed', () => {
    const { ctx, panels } = buildHudHarness({ speedupUntil: Date.now() - 1000 });
    panels.renderHud();
    const texts = hudTexts(ctx);
    const prefix = t('world.speedup').split('{d}')[0]!;
    expect(texts.some((s) => s.startsWith(prefix))).toBe(false);
  });

  it('shows both chips together when shield and speedup are both active', () => {
    const { ctx, panels } = buildHudHarness({
      baseProtectedUntil: Date.now() + 3600_000,
      speedupUntil: Date.now() + 1800_000,
    });
    panels.renderHud();
    const texts = hudTexts(ctx);
    const shieldPrefix = t('world.protected').split('{d}')[0]!;
    const speedupPrefix = t('world.speedup').split('{d}')[0]!;
    expect(texts.some((s) => s.startsWith(shieldPrefix))).toBe(true);
    expect(texts.some((s) => s.startsWith(speedupPrefix))).toBe(true);
  });

  it('re-rendering (as the ~5s march poll does) tears down and rebuilds the buff row without leaking children', () => {
    const { ctx, panels } = buildHudHarness({
      baseProtectedUntil: Date.now() + 3600_000,
      speedupUntil: Date.now() + 1800_000,
    });
    panels.renderHud();
    const firstCount = ctx.hudLayer.children.length;
    panels.renderHud();
    panels.renderHud();
    expect(ctx.hudLayer.children.length).toBe(firstCount);
  });
});
