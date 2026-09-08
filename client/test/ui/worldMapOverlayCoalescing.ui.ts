// The SLG map's per-frame budget: overlay INK is repainted on demand, tokens move every frame.
//
// The bug this pins (2026-09-08 "地图甚至卡顿到影响体验"): `renderOverlay()` did both halves at once
// and lifecycle.ts called it on every frame that had any march / occupation / garrison in flight. So
// a single march in the air rebuilt, 60 times a second, geometry that had not changed — the cloud
// veil (viewport rect + clipped polygon hole + a thick rim stroke), an `occupyFrontierCells` scan
// over every visible tile plus a polygon and four corner brackets per frontier cell, every
// garrison's 3x3 dashed aura, ten capital stars, and a nine-segment faded trace per march. All of
// it re-triangulated to draw the identical picture.
//
// The two directions both matter, so both are asserted:
//   - it must STOP repainting the ink while its inputs are unchanged (the saving), and
//   - it must STILL repaint for every input that ink is a function of (the correctness).
// The second half is one case per term of `overlayInkSignature`, mutation-verified by deleting the
// term and watching the case go red — the same method test/ui/renderPolicy.ui.ts uses, and for the
// same reason: a signature that misses a term leaves a stale frontier on screen until the next pan,
// which no other test would notice.
//
// Run: npm run test:ui

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import {
  RenderPolicy, resetRenderHold, setRenderPolicyClock, type PaintMode,
} from '../../src/render/renderPolicy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { WorldMapScene } from '../../src/scenes/WorldMapScene';
import type { WorldApiClient, MarchView, StationedView, NationView } from '../../src/net/WorldApiClient';
import { createFakeTextInput } from '../harness/fakeTextInput';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 1280];

function stubWorldApi(): WorldApiClient {
  const never = () => new Promise<never>(() => {});
  return {
    getMe: never, getMap: never, getMapSparse: never, getTile: never, getMarches: never,
    getOccupations: never, joinWorld: never, occupyTile: never, abandonTile: never,
    startMarch: never, recallMarch: never,
  } as unknown as WorldApiClient;
}

interface Spied {
  ctx: {
    marches: MarchView[];
    stationed: StationedView[];
    nations: NationView[];
    selectedTile: { x: number; y: number } | null;
    panX: number;
    panY: number;
    overlayInkDirty: boolean;
    tileCache: Map<string, unknown>;
  };
  update(dt: number): void;
  destroy(): void;
  /** How many times the ink was repainted since the last {@link resetCounts}. */
  inkPaints: number;
  /** How many times the tokens were stepped. */
  tokenSyncs: number;
  resetCounts(): void;
}

/**
 * A WorldMapScene with the two halves of the old `renderOverlay` counted separately.
 *
 * The spy wraps the FOG DOMAIN's own methods rather than the scene's, because that is the boundary
 * lifecycle.ts calls across — wrapping `WorldMapRenderer.renderOverlay` would still count 1 for a
 * frame that rebuilt everything, which is exactly the bug.
 */
function buildScene(): Spied {
  const scene = new WorldMapScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {},
    onOpenCity() {}, onOpenDefense() {},
    worldApi: stubWorldApi(), worldId: 'world:1:0', playerName: 'Tester', accountId: 'acc_test',
    storage: memStore, openTextInput: createFakeTextInput().openTextInput,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const fog = scene.ctx.view.fog;
  const realInk = fog.renderOverlayInk.bind(fog);
  const realSync = fog.syncTokens.bind(fog);
  const spied = scene as Spied;
  spied.inkPaints = 0;
  spied.tokenSyncs = 0;
  spied.resetCounts = () => { spied.inkPaints = 0; spied.tokenSyncs = 0; };
  fog.renderOverlayInk = (): void => { spied.inkPaints += 1; realInk(); };
  fog.syncTokens = (dt: number): void => { spied.tokenSyncs += 1; realSync(dt); };
  return spied;
}

function march(marchId: string, toX = 25): MarchView {
  const now = Date.now();
  return {
    marchId, kind: 'occupy', fromTile: 'world:1:0:15:20', toTile: `world:1:0:${toX}:20`,
    troops: 100, departAt: now - 2000, arriveAt: now + 8000, status: 'marching', mine: true,
  };
}

/** Run `n` frames and return what the two halves did. */
function frames(scene: Spied, n: number): { ink: number; tokens: number } {
  scene.resetCounts();
  for (let i = 0; i < n; i++) scene.update(1 / 60);
  return { ink: scene.inkPaints, tokens: scene.tokenSyncs };
}

describe('world-map overlay: ink on demand, tokens every frame', () => {
  it('stops repainting the ink while a march is in flight, but keeps stepping the token', () => {
    const scene = buildScene();
    scene.ctx.marches = [march('m1')];
    scene.update(1 / 60);                       // first frame: the ink has to paint once

    const after = frames(scene, 60);
    expect(after.ink).toBe(0);                  // <- the fix. Was 60.
    expect(after.tokens).toBe(60);              // <- and the token still advances every frame
    scene.destroy();
  });

  it('paints the ink exactly once per change, not once per frame after it', () => {
    const scene = buildScene();
    scene.ctx.marches = [march('m1')];
    scene.update(1 / 60);

    scene.resetCounts();
    scene.ctx.marches = [march('m1'), march('m2', 30)];
    for (let i = 0; i < 10; i++) scene.update(1 / 60);
    expect(scene.inkPaints).toBe(1);
    scene.destroy();
  });

  it('never runs either half with an empty, still map (nothing to draw, nothing to move)', () => {
    const scene = buildScene();
    scene.update(1 / 60);
    const after = frames(scene, 30);
    expect(after).toEqual({ ink: 0, tokens: 0 });
    scene.destroy();
  });

  it('a drag rebuilds the ink once per FRAME, not once per pointer-move event', () => {
    const scene = buildScene();
    scene.update(1 / 60);
    scene.resetCounts();

    // A pointer-move can arrive more often than the display refreshes; each one moves the camera.
    const ctx = scene.ctx as unknown as {
      dragging: boolean; dragMoved: boolean; dragStartX: number; dragStartY: number;
      input: { handleMove(x: number, y: number): void };
    };
    ctx.dragging = true;
    ctx.dragMoved = true;
    ctx.dragStartX = 0;
    ctx.dragStartY = 0;
    for (let i = 1; i <= 6; i++) ctx.input.handleMove(i * 10, i * 5);
    expect(scene.inkPaints).toBe(0);   // nothing painted from inside the event handler

    scene.update(1 / 60);
    expect(scene.inkPaints).toBe(1);   // ...and exactly one paint for the whole batch
    scene.destroy();
  });

  describe('repaints for every input the ink is a function of', () => {
    /** Settle, then assert the change produces exactly one ink repaint over the following frames. */
    function expectOneRepaint(mutate: (scene: Spied) => void): void {
      const scene = buildScene();
      scene.ctx.marches = [march('m1')];
      scene.update(1 / 60);
      expect(frames(scene, 3).ink).toBe(0);     // settled first — otherwise the case proves nothing

      scene.resetCounts();
      mutate(scene);
      for (let i = 0; i < 3; i++) scene.update(1 / 60);
      expect(scene.inkPaints).toBe(1);
      scene.destroy();
    }

    it('a pan', () => expectOneRepaint((s) => { s.ctx.panX += 40; }));
    it('a vertical pan', () => expectOneRepaint((s) => { s.ctx.panY -= 25; }));
    it('a selection', () => expectOneRepaint((s) => { s.ctx.selectedTile = { x: 12, y: 9 }; }));
    it('a march list change', () => expectOneRepaint((s) => { s.ctx.marches = [march('m1', 26)]; }));
    it('a march being recalled', () => expectOneRepaint((s) => { s.ctx.marches = []; }));
    it('a garrison arriving', () => expectOneRepaint((s) => {
      s.ctx.stationed = [{
        teamId: 't1', x: 10, y: 10, mode: 'garrison', troops: 50, mine: true,
      } as unknown as StationedView];
    }));
    it('a capital changing hands', () => expectOneRepaint((s) => {
      s.ctx.nations = [{ x: 5, y: 5, ownerId: 'acc_other' } as unknown as NationView];
    }));
    it('tile ownership changing (the occupy frontier is derived from it)', () => expectOneRepaint((s) => {
      // Through the cache's own mutator, which is what bumps its revision — see VersionedTileCache.
      s.ctx.tileCache.set('10:10', { x: 10, y: 10, kind: 'plain', ownerId: 'acc_test' });
    }));
    it('an explicit "repaint regardless" request', () => expectOneRepaint((s) => {
      s.ctx.overlayInkDirty = true;
    }));
  });
});

// ── the gate for turning WorldMapScene's `paint` to 'reactive' ────────────────────────────────
//
// The map is the most expensive tick in this client, and idle it draws the same picture ~49 of every
// 60 frames (claudedocs/client-render-budget.md §7) — which is what makes demand-driven painting
// worth having here. But getting it wrong does not show up as a slow map: it shows up as a march
// visibly frozen in mid-air until the player touches the screen, and the two valves that make
// ADR-083 safe elsewhere (the 500 ms floor, the 400 ms post-input hold) would only turn that into a
// stutter instead of preventing it.
//
// So this pins the load-bearing direction against the real policy: while a march is in the air,
// `RenderPolicy` in 'reactive' mode must paint EVERY frame. The policy clock is frozen so neither
// valve can paint on the test's behalf, and `Date.now` is driven by hand because the token's
// position is interpolated from it — a synchronous 60-frame loop otherwise takes place at a single
// instant, the token never moves, and the test would pass for the wrong reason.
describe("world map under a 'reactive' paint policy", () => {
  let clockMs = 10_000;
  let nowMs = 0;
  const realNow = Date.now;

  beforeEach(() => {
    clockMs = 10_000;
    nowMs = realNow();
    Date.now = () => nowMs;
    setRenderPolicyClock(() => clockMs);
    resetRenderHold();
  });

  afterEach(() => {
    Date.now = realNow;
    setRenderPolicyClock();
    resetRenderHold();
  });

  /** Get the first-paint cover out of the picture. It is a spinning ink ring plus a 1.3 s eraser
   * wipe with falling flecks (WorldMapRenderer/loadingReveal.ts), and here the stubbed API never
   * resolves, so nothing would ever dismiss it — leaving a scene that legitimately changes every
   * frame and a "does it skip" assertion that silently measures the spinner. */
  function revealMap(scene: Spied): void {
    const ctx = scene.ctx as unknown as {
      view: { buildPanel: { hideLoading(): void } };
      loadingSpinner: unknown; loadingEraseLayer: unknown;
    };
    ctx.view.buildPanel.hideLoading();
    for (let i = 0; i < 400 && (ctx.loadingSpinner || ctx.loadingEraseLayer); i++) frame(scene);
    expect(ctx.loadingSpinner).toBeNull();
    expect(ctx.loadingEraseLayer).toBeNull();
  }

  /** One frame of scene time, wall clock included. */
  function frame(scene: Spied): void { nowMs += 17; scene.update(1 / 60); }

  /** A march's token as a plain container on the real token layer.
   *
   * The stickman token cannot exist headlessly — `StickmanRuntime.loadAsset` never resolves under
   * the test adapter, so that branch of `syncMarchTokens` has no display object and moves nothing.
   * The 'dot' entry is the LOD-downgrade variant the same function builds past
   * STICKMAN_TOKEN_BUDGET live tokens, and it goes through the same per-frame `position.set` — so
   * seeding one exercises the real "the token moves every frame" path with only the artwork faked. */
  function seedToken(scene: Spied, marchId: string): void {
    const ctx = scene.ctx as unknown as {
      marchTokenLayer: PIXI.Container;
      marchTokenRuntimes: Map<string, unknown>;
    };
    const sprite = new PIXI.Container();
    ctx.marchTokenLayer.addChild(sprite);
    ctx.marchTokenRuntimes.set(marchId, { mode: 'dot', sprite, kind: 'infantry' });
  }

  /** A protection-shield bubble on one tile: the cached local-space geometry plus the two `Graphics`
   * children `lifecycle.update` re-draws into. Same shape of fake as `seedToken` — `city.ts` builds
   * these off a decoded city sprite, which headless has no atlas for, but the animation loop that
   * re-draws them every 100 ms is the real one. */
  function seedShield(scene: Spied, key: string): void {
    const ctx = scene.ctx as unknown as {
      citySprites: Map<string, PIXI.Container>;
      shieldGeom: Map<string, { cx: number; cy: number; rx: number; ry: number; tp: number }>;
      container: PIXI.Container;
    };
    const cityC = new PIXI.Container();
    for (const name of ['shieldFx', 'shieldGlowFx']) {
      const g = new PIXI.Graphics();
      g.name = name;
      cityC.addChild(g);
    }
    (scene as unknown as { container: PIXI.Container }).container.addChild(cityC);
    ctx.citySprites.set(key, cityC);
    ctx.shieldGeom.set(key, { cx: 0, cy: -20, rx: 30, ry: 22, tp: 64 });
  }

  /** The scene mounted under a policy-driven stage, `tick()` called by hand exactly as
   * SceneManager's ticker listener does. Returns paints over `n` frames after one settling frame.
   *
   * The policy reads the scene's **own** `paint` declaration rather than a hard-coded `'reactive'`:
   * that is the one line the whole flip consists of, and hard-coding the mode here would leave it
   * unpinned — reverting `WorldMapScene.paint` would keep every case below green. */
  function paintsOver(scene: Spied, n: number): number {
    const stage = new PIXI.Container();
    stage.addChild((scene as unknown as { container: PIXI.Container }).container);
    const host = { ticker: new PIXI.Ticker(), stage, paints: 0, render(): void { host.paints += 1; } };
    const policy = new RenderPolicy(host, () => (scene as unknown as { paint?: PaintMode }).paint);
    frame(scene);
    policy.tick();          // settling frame: with lastPaintMs still 0 the floor paints regardless
    host.paints = 0;
    for (let i = 0; i < n; i++) { frame(scene); policy.tick(); }
    return host.paints;
  }

  it('paints every single frame while a march is in flight', () => {
    const scene = buildScene();
    revealMap(scene);
    scene.ctx.marches = [march('m1')];
    seedToken(scene, 'm1');
    expect(paintsOver(scene, 60)).toBe(60);
    scene.destroy();
  });

  it('...and all but stops once the march lands (otherwise the saving is imaginary)', () => {
    const scene = buildScene();
    revealMap(scene);
    scene.ctx.marches = [march('m1')];
    seedToken(scene, 'm1');
    frame(scene);
    scene.ctx.marches = [];                  // arrived / recalled — nothing moving any more
    // Not 0: the HUD countdown repaints once a second (lifecycle.ts hudTickTimer), and 60 frames is
    // one second of scene time. That is the floor of what an idle map costs, and it is the number
    // §7's "~11 changes/s" is made of — one HUD tick plus the shield bubbles this map has none of.
    expect(paintsOver(scene, 60)).toBeLessThanOrEqual(2);
    scene.destroy();
  });

  it('an idle map is all but still', () => {
    const scene = buildScene();
    revealMap(scene);
    expect(paintsOver(scene, 60)).toBeLessThanOrEqual(2);
    scene.destroy();
  });

  it("declares 'reactive' itself — the flip is one line and nothing else pins it", () => {
    const scene = buildScene();
    // Every case above runs the policy off THIS field (see paintsOver). Asserted separately anyway,
    // because "the map is demand-painted" is a decision (ADR-085) and not an implementation detail:
    // a revert should have to delete a test, not just a line. How SceneManager derives a paint mode
    // for scene+overlay+fade combinations is pinned generically in test/ui/renderLoopWiring.ui.ts.
    expect((scene as unknown as { paint?: PaintMode }).paint).toBe('reactive');
    scene.destroy();
  });

  // ── the things that DO move on an "idle" map ─────────────────────────────────────────────────
  //
  // The three cases above cover the two extremes (a march in flight; nothing at all). In between sit
  // the animations nobody would think to check, and each one's failure mode is a frozen picture that
  // no other test in the suite would notice: a loading spinner that never spins, a protection dome
  // that stops breathing, a march countdown stuck at the same number. They are exactly the reason
  // ADR-083 derives "changed" from the display list instead of trusting call sites to announce it —
  // so each is asserted through the real policy, not by inspecting the animation's own bookkeeping.

  it('paints every frame while the first-paint loading cover is still up', () => {
    const scene = buildScene();
    // Deliberately NOT revealMap()'d: this is what entering the map looks like until the atlases
    // settle. The cover is a spinning ink ring plus a caption over the whole scene, and a player
    // watching a frozen spinner would reasonably conclude the game had hung.
    expect(paintsOver(scene, 60)).toBe(60);
    scene.destroy();
  });

  it('keeps painting for a protection shield on an otherwise idle map (~10 fps, not 0)', () => {
    const scene = buildScene();
    revealMap(scene);
    seedShield(scene, '12:14');
    // SHIELD_ANIM_FPS is 10 (lifecycle.ts), so one second of frames is ~10 dome+glow redraws — an
    // order of magnitude below frame rate, and an order of magnitude above frozen.
    const paints = paintsOver(scene, 60);
    expect(paints).toBeGreaterThanOrEqual(8);
    expect(paints).toBeLessThanOrEqual(15);
    scene.destroy();
  });

  it('the opening guide ring costs ~10 paints/s, not 60 — the regression this flip waited on', () => {
    const scene = buildScene();
    revealMap(scene);
    // What a brand-new player sees on their first world-map entry: step1 rings their own base
    // (WorldMapRendererLifecycle.updateGuide derives this from flags + `me` every frame, and calls
    // both `guide.update(dt)` and `guide.showAt(...)` — the two call sites that made quantizing the
    // ring's PHASE rather than throttling the caller the only fix that works).
    const ctx = scene.ctx as unknown as { guideStep: string | null; me: unknown };
    ctx.me = { mainBaseTile: 'world:1:0:15:20' };
    ctx.guideStep = 'step1';

    const paints = paintsOver(scene, 60);
    // Pre-fix this was 60/60: `drawRing()` ran on every frame, so `geometry.dirty` moved on every
    // frame, so the map's whole signature changed on every frame — with the ring up, the flip this
    // file gates would have saved exactly nothing during onboarding.
    expect(paints).toBeLessThanOrEqual(25);
    expect(paints).toBeGreaterThanOrEqual(8);   // ...and it is still visibly breathing
    scene.destroy();
  });

  it('lets the once-a-second HUD countdown through (the correctness half of "all but still")', () => {
    const scene = buildScene();
    revealMap(scene);
    // `an idle map is all but still` above bounds this from ABOVE (<=2 per 60 frames) — which a
    // policy that never painted at all would also satisfy. This is the other direction: over two
    // seconds of scene time the HUD tick (lifecycle.ts hudTickTimer) must reach the screen, or every
    // march/siege countdown on the map sits frozen between the ~5 s polls.
    expect(paintsOver(scene, 120)).toBeGreaterThanOrEqual(1);
    scene.destroy();
  });
});
