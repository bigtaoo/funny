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

import { describe, it, expect } from 'vitest';
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
