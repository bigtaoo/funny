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

// Coverage for the 2026-08-09 UI fix: at the old fixed FS.label (24px) with no wordWrap, the
// countdown labels ("Protected (1d 1h 41m 41s)" / German "Geschützt (noch ...)" — even longer)
// ran past the right edge of the fixed-width status panel and got clipped by the canvas bounds
// (reported via annotated screenshot). Fix: smaller font + wordWrap + per-label row height sized
// from the actual wrapped text height.
function buffLabelNodes(ctx: WorldMapContext): PIXI.Text[] {
  return (ctx.hudLayer.children as PIXI.DisplayObject[]).filter((c): c is PIXI.Text => c instanceof PIXI.Text)
    .filter((tx) => tx.text.startsWith(t('world.protected').split('{d}')[0]!) || tx.text.startsWith(t('world.speedup').split('{d}')[0]!));
}

describe('WorldMapPanels.renderHud — buff label no longer clips past the panel edge (2026-08-09 UI fix)', () => {
  it('every buff label has wordWrap enabled with a finite width that keeps it inside the status panel', () => {
    const { ctx, panels } = buildHudHarness({ baseProtectedUntil: Date.now() + 3600_000 });
    panels.renderHud();
    const labels = buffLabelNodes(ctx);
    expect(labels.length).toBe(1);
    const lbl = labels[0]!;
    expect(lbl.style.wordWrap).toBe(true);
    expect(lbl.style.wordWrapWidth).toBeGreaterThan(0);
    // Right edge of the label's wrap box must stay within the canvas, clear of the 16px margin
    // the status card is inset by (see renderHud's `rx = w - rightW - 16`).
    expect(lbl.x + lbl.style.wordWrapWidth!).toBeLessThanOrEqual(W - 16);
  });

  it("a label that would overflow unwrapped renders at or under its wordWrapWidth (PIXI actually wrapped it, didn't just clip)", () => {
    const { ctx, panels } = buildHudHarness({ baseProtectedUntil: Date.now() + 3600_000 });
    panels.renderHud();
    const lbl = buffLabelNodes(ctx)[0]!;
    // A single unwrapped line at this font would be wider than the box (that's the original bug);
    // the rendered width must not exceed the configured wrap width (small AA/measurement slack).
    expect(lbl.width).toBeLessThanOrEqual(lbl.style.wordWrapWidth! + 2);
  });

  it('two simultaneous buff chips stack into separate, non-overlapping rows', () => {
    const { ctx, panels } = buildHudHarness({
      baseProtectedUntil: Date.now() + 3600_000,
      speedupUntil: Date.now() + 1800_000,
    });
    panels.renderHud();
    const labels = buffLabelNodes(ctx);
    expect(labels.length).toBe(2);
    const [first, second] = labels.sort((a, b) => a.y - b.y);
    // Second row must start at/after the first row's label bottom — no vertical overlap.
    expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height - 1); // -1 slack for rounding
  });
});
