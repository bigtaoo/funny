// Regression coverage for the SLG opening guide chain's WorldMapScene half — step1 (highlight the
// player's own main city) and step4 (closing "occupy nearby land" tip), ONBOARDING_DESIGN §4.2.
// CityScene's half (step2/step3) is covered separately in cityGuideChain.ui.ts.
//
// Two collaborators are exercised directly with hand-rolled fake contexts (mirrors
// worldMapBaseClick.ui.ts's harness pattern) rather than constructing a full WorldMapScene:
//   - WorldMapInput: onTileClick's step1-completion routing + handleDown's guide-tap priority.
//   - WorldMapRendererLifecycle: the private updateGuide() — TS privacy is erased at runtime, so
//     it's called directly (`as unknown as {...}`) rather than driving the whole public update()
//     (which also touches panels/vignette/fog — irrelevant noise for this file's purpose).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import { initI18n } from '../../src/i18n';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import { WorldMapRendererLifecycle } from '../../src/scenes/worldmap/WorldMapRenderer/lifecycle';
import { GuideOverlay } from '../../src/render/GuideOverlay';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { WorldTileView, PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const WORLD_ID = 'world:1:0';
const ANCHOR = { x: 20, y: 20 };

function makeMe(overrides: Partial<PlayerWorldView> = {}): PlayerWorldView {
  return { joined: true, mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`, troops: 2000, ...overrides } as PlayerWorldView;
}

// ── WorldMapInput: step1 completion + guide-tap priority ─────────────────────────────────────

function zeroRect(): { x: number; y: number; w: number; h: number } {
  return { x: 0, y: 0, w: 0, h: 0 };
}

function buildInputHarness(opts: { guideStep?: 'step1' | null; getFlag?: (k: string) => boolean } = {}) {
  const setFlag = vi.fn();
  const onOpenCity = vi.fn();
  const guide = new GuideOverlay();

  const ctx = {
    w: 800, h: 1280, topInset: 86,
    panX: 0, panY: 0, dragging: false, dragMoved: false, dragStartX: 0, dragStartY: 0,
    modalDimRect: null, modalBtnRects: [],
    zoomBtnRect: zeroRect(), backRect: zeroRect(), aucBtnRect: zeroRect(), shopBtnRect: zeroRect(),
    homeBtnRect: zeroRect(), teamBadgeRect: zeroRect(), replayBadgeRect: zeroRect(),
    chatBarRect: zeroRect(), resClusterRect: zeroRect(), teamRowRects: [],
    mapW: 500, mapH: 500,
    tileCache: new Map<string, WorldTileView>(),
    me: makeMe(),
    selectedTile: null,
    stationed: [],
    guideStep: opts.guideStep ?? null,
    guide,
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: () => {} },
    cb: { worldId: WORLD_ID, onOpenCity, getFlag: opts.getFlag ?? (() => false), setFlag },
    panels: { showModal: vi.fn(), showToast: vi.fn(), closeModal: vi.fn(), showDeployDialog: vi.fn() },
    net: { doJoin: vi.fn() },
  } as unknown as WorldMapContext;

  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    ctx.tileCache.set(`${ANCHOR.x + dx}:${ANCHOR.y + dy}`, { mine: true } as WorldTileView);
  }

  const input = new WorldMapInput(ctx);
  return { ctx, input, setFlag, onOpenCity, guide };
}

describe('WorldMapInput — step1 completion (ONBOARDING_DESIGN §4.2)', () => {
  it('tapping the highlighted base tile marks step1 seen and clears guideStep, then still opens the city', () => {
    const { ctx, input, setFlag, onOpenCity } = buildInputHarness({ guideStep: 'step1' });
    input.onTileClick(ANCHOR.x, ANCHOR.y);
    expect(setFlag).toHaveBeenCalledWith('guide.world.step1', true);
    expect(ctx.guideStep).toBeNull();
    expect(onOpenCity).toHaveBeenCalledTimes(1);
  });

  it('tapping the base tile when step1 is NOT active does not touch the flag (already seen / already cleared)', () => {
    const { setFlag, input, onOpenCity } = buildInputHarness({ guideStep: null });
    input.onTileClick(ANCHOR.x, ANCHOR.y);
    expect(setFlag).not.toHaveBeenCalled();
    expect(onOpenCity).toHaveBeenCalledTimes(1); // the city still opens either way
  });

  it('tapping any of the other 8 footprint cells while step1 is active also completes it (ADR-025 "whole footprint is the city")', () => {
    const { ctx, input, setFlag } = buildInputHarness({ guideStep: 'step1' });
    input.onTileClick(ANCHOR.x + 1, ANCHOR.y - 1);
    expect(setFlag).toHaveBeenCalledWith('guide.world.step1', true);
    expect(ctx.guideStep).toBeNull();
  });

  it("handleDown routes a tap on the guide's own skip glyph to its callback, before any other hit-test", () => {
    const { input, guide } = buildInputHarness();
    const onSkip = vi.fn();
    guide.showAt({ x: 300, y: 300, w: 60, h: 60 }, 'tap your city', { w: 800, h: 1280 }, { onSkip });
    const action = guide.currentAction()!;

    input.handleDown(action.rect.x + action.rect.w / 2, action.rect.y + action.rect.h / 2);
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('handleDown falls through to normal dispatch when the tap is outside the guide action rect', () => {
    const { input, ctx, guide } = buildInputHarness();
    const onSkip = vi.fn();
    guide.showAt({ x: 300, y: 300, w: 60, h: 60 }, 'tap your city', { w: 800, h: 1280 }, { onSkip });

    // Tap somewhere in the map band, nowhere near the guide's skip glyph.
    input.handleDown(700, 900);
    expect(onSkip).not.toHaveBeenCalled();
    expect(ctx.dragging).toBe(true); // normal drag-begin path ran instead
  });
});

// ── WorldMapRendererLifecycle.updateGuide (step1 tracking + step4 tip) ────────────────────────

function buildLifecycleHarness(opts: {
  guideStep?: 'step1' | null;
  getFlag?: (k: string) => boolean;
  mainBaseTile?: string | null;
} = {}) {
  const setFlag = vi.fn();
  const guide = new GuideOverlay();
  const ctx = {
    w: 800, h: 1280,
    panX: 0, panY: 0,
    tp: 100,
    guideStep: opts.guideStep ?? null,
    guide,
    me: opts.mainBaseTile === null ? null : { mainBaseTile: opts.mainBaseTile ?? `${WORLD_ID}:10:10` },
    cb: { getFlag: opts.getFlag ?? (() => false), setFlag },
    parseTileStrict(tileId: string | undefined | null): [number, number] | null {
      if (!tileId) return null;
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
  };
  const core = { ctx } as unknown as import('../../src/scenes/worldmap/WorldMapRenderer/core').WorldMapRendererCore;
  const lifecycle = new WorldMapRendererLifecycle(core, {} as never, {} as never, {} as never, () => {});
  const updateGuide = (dt: number): void => (lifecycle as unknown as { updateGuide(dt: number): void }).updateGuide(dt);
  return { ctx, guide, setFlag, updateGuide };
}

describe('WorldMapRendererLifecycle.updateGuide — step1 highlight tracking', () => {
  it('shows a highlight around the main city while guideStep is step1', () => {
    const { guide, updateGuide } = buildLifecycleHarness({ guideStep: 'step1' });
    const spy = vi.spyOn(guide, 'showAt');
    updateGuide(0.1);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('the highlight rect follows panX/panY by the exact same delta (tracks camera drag)', () => {
    const { ctx, guide, updateGuide } = buildLifecycleHarness({ guideStep: 'step1' });
    const spy = vi.spyOn(guide, 'showAt');
    updateGuide(0.1);
    const rect1 = spy.mock.calls[0][0] as { x: number; y: number };

    ctx.panX += 37;
    ctx.panY -= 21;
    updateGuide(0.1);
    const rect2 = spy.mock.calls[1][0] as { x: number; y: number };

    expect(rect2.x - rect1.x).toBe(37);
    expect(rect2.y - rect1.y).toBe(-21);
  });

  it("the highlight's own skip callback marks step1 seen and clears guideStep", () => {
    const { ctx, guide, setFlag, updateGuide } = buildLifecycleHarness({ guideStep: 'step1' });
    updateGuide(0.1);
    guide.currentAction()!.fn();
    expect(setFlag).toHaveBeenCalledWith('guide.world.step1', true);
    expect(ctx.guideStep).toBeNull();
  });

  it('does nothing when guideStep is step1 but the main base tile is unknown yet (mainBaseTile null)', () => {
    const { guide, updateGuide } = buildLifecycleHarness({ guideStep: 'step1', mainBaseTile: null });
    const spy = vi.spyOn(guide, 'showAt');
    updateGuide(0.1);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('WorldMapRendererLifecycle.updateGuide — step4 closing tip', () => {
  it('shows the target-less tip once step3 is done and step4 has not been seen yet', () => {
    const { guide, updateGuide } = buildLifecycleHarness({
      guideStep: null,
      getFlag: (k) => k === 'guide.world.step3',
    });
    const spy = vi.spyOn(guide, 'showCard');
    updateGuide(0.1);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("the tip's dismiss button marks step4 seen", () => {
    const { setFlag, guide, updateGuide } = buildLifecycleHarness({
      guideStep: null,
      getFlag: (k) => k === 'guide.world.step3',
    });
    updateGuide(0.1);
    guide.currentAction()!.fn();
    expect(setFlag).toHaveBeenCalledWith('guide.world.step4', true);
  });

  it('does not show the tip before step3 is done', () => {
    const { guide, updateGuide } = buildLifecycleHarness({ guideStep: null, getFlag: () => false });
    const showCard = vi.spyOn(guide, 'showCard');
    const showAt = vi.spyOn(guide, 'showAt');
    updateGuide(0.1);
    expect(showCard).not.toHaveBeenCalled();
    expect(showAt).not.toHaveBeenCalled();
  });

  it('hides the guide once the whole chain (step3 + step4) is done', () => {
    const { guide, updateGuide } = buildLifecycleHarness({ guideStep: null, getFlag: () => true });
    const hideSpy = vi.spyOn(guide, 'hide');
    updateGuide(0.1);
    expect(hideSpy).toHaveBeenCalledOnce();
  });
});
