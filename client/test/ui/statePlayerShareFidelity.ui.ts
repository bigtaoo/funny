// Regression tests for "分享的录像里角色没皮肤、没动作、没有 UI 信息" (2026-08-26).
//
// A replay opened from a share link (`?r=<code>` → StatePlayerScene) rendered:
//   ① unskinned units — the scene hardcoded an empty skin list AND the stream carried no skin ids at all;
//   ② frozen units — the scene called `UnitView.sync(board, 0)`, and that dt is what advances every
//      stickman clock, so every unit slid around the board locked in the first pose of its clip;
//   ③ no HUD — the dumb player drew only two name labels and the transport bar: no base HP, no ink
//      (and ink was not even recorded, so it could not be drawn).
//
// Same headless-PIXI harness as gameScenes.ui.ts (vitest.ui.config.ts setupFiles). The `.tao` rigs never
// load here (assets are stubbed), so this pins the *wiring* — which skins/dt/frame data reach the render
// layer — not the pixels.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { initI18n } from '../../src/i18n';
import { InputManager } from '../../src/inputSystem/InputManager';
import { GameScene } from '../../src/scenes/GameScene';
import { StatePlayerScene, skinsForOwner } from '../../src/scenes/StatePlayerScene';
import { UnitView } from '../../src/render/UnitView';
import { stateRecorder } from '../../src/game/replay/StateRecorder';
import { STATE_SCHEMA_VERSION, type StateFrame, type StateReplay } from '../../src/game/replay/StateReplay';

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

const CB = { onPlayDemo() {}, onBackToLogin() {} };

/** Hand-built stream (no recorder needed): one walking unit per side, ink 7 vs 3, a skin each. */
function mkShared(opts: { skins?: boolean; res?: boolean } = {}): StateReplay {
  const { skins = true, res = true } = opts;
  const frame = (tick: number, row: number): StateFrame => ({
    tick,
    units: [
      { id: 1, type: 'infantry', side: 0, col: 3, row, hp: 100, maxHp: 100, state: 'moving' },
      { id: 2, type: 'archer', side: 1, col: 8, row: 16, hp: 60, maxHp: 60, state: 'moving' },
    ],
    buildings: [],
    bases: [{ owner: 0, hp: 80, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }],
    ...(res ? { res: [{ owner: 0, ink: 7, upgrade: 1 }, { owner: 1, ink: 3, upgrade: 0 }] } : {}),
  });
  return {
    header: {
      schemaVersion: STATE_SCHEMA_VERSION,
      mode: 'netplay',
      tickRate: 30,
      endTick: 60,
      winner: 0,
      board: { cols: 12, rows: 18, lanes: [0, 1, 2, 3, 4, 7, 8, 9, 10, 11] },
      players: [
        { name: 'Tao', side: 0, ...(skins ? { skins: ['skin_l1'] } : {}) },
        { name: 'Anna', side: 1, ...(skins ? { skins: ['skin_shop_r1'] } : {}) },
      ],
    },
    frames: [frame(0, 1), frame(30, 4), frame(60, 7)],
  };
}

/** The scene's HUD, reached through the private field the tests need to observe. */
function hudOf(scene: StatePlayerScene): {
  container: PIXI.Container;
  sides: Record<0 | 1, { hp: PIXI.Graphics }>;
} {
  return (scene as unknown as { hud: { container: PIXI.Container; sides: Record<0 | 1, { hp: PIXI.Graphics }> } }).hud;
}

/** Visible plain-integer texts under `root` — the ink readouts (the clock is "m:ss", names are words). */
function visibleCounts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) {
        if (ch.visible && /^\d+$/.test(ch.text)) out.push(ch.text);
      } else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

describe('StatePlayerScene — shared replay renders skins / animation / HUD', () => {
  it('routes each owner\'s recorded skins to its own side (owner 0 = bottom = UnitView\'s "local")', () => {
    const replay = mkShared();
    expect(skinsForOwner(replay, 0)).toEqual(['skin_l1']);
    expect(skinsForOwner(replay, 1)).toEqual(['skin_shop_r1']);
    // A v1 stream carries no skins at all → unskinned, exactly as before (no hard-reject).
    expect(skinsForOwner(mkShared({ skins: false }), 0)).toEqual([]);
  });

  it('forwards the playback delta to UnitView.sync so stickman clocks advance (was hardcoded 0)', () => {
    const sync = vi.spyOn(UnitView.prototype, 'sync');
    const scene = new StatePlayerScene(createLayout(...PORTRAIT), mkShared(), CB);
    sync.mockClear(); // drop the constructor's first paint (dt 0 by design — nothing has elapsed yet)

    scene.update(1 / 30);
    expect(sync).toHaveBeenCalled();
    expect(sync.mock.calls.at(-1)![1]).toBeCloseTo(1 / 30, 6);

    // At 2× the units cross the board twice as fast, so their legs have to run twice as fast too.
    (scene as unknown as { speedIdx: number }).speedIdx = 1;
    scene.update(1 / 30);
    expect(sync.mock.calls.at(-1)![1]).toBeCloseTo(2 / 30, 6);

    scene.destroy();
    sync.mockRestore();
  });

  it('draws both sides\' base HP and ink from the stream', () => {
    const scene = new StatePlayerScene(createLayout(...PORTRAIT), mkShared(), CB);
    scene.update(1 / 30);
    const hud = hudOf(scene);

    // Both HP bars have actual geometry (drawHpBar ran for owner 0 and owner 1).
    for (const owner of [0, 1] as const) {
      expect(hud.sides[owner].hp.geometry.graphicsData.length).toBeGreaterThan(0);
    }
    // Ink: 7 for the bottom player, 3 for the top one.
    expect(visibleCounts(hud.container).sort()).toEqual(['3', '7']);

    scene.destroy();
  });

  it('hides the ink readout for a v1 stream instead of showing a fabricated 0', () => {
    const scene = new StatePlayerScene(createLayout(...PORTRAIT), mkShared({ res: false }), CB);
    scene.update(1 / 30);
    expect(visibleCounts(hudOf(scene).container)).toEqual([]);
    // HP still renders — it was always in the stream.
    expect(hudOf(scene).sides[0].hp.geometry.graphicsData.length).toBeGreaterThan(0);
    scene.destroy();
  });
});

describe('GameRenderer — the recorded stream carries the roster it rendered with', () => {
  it('puts each side\'s equipped skins in the shared header (so the dumb player can re-render them)', () => {
    const scene = new GameScene(
      createLayout(...PORTRAIT),
      new InputManager(),
      { onGameEnd() {}, onExitToLobby() {} },
      { seed: 0x1234abcd, equippedSkins: ['skin_l1'], opponentSkins: ['skin_shop_r1'] },
    );
    scene.update(1 / 30);

    // What nav/result.ts's doShareReplay does: pass only the sharer's own name, let the roster place it.
    const header = stateRecorder.build({ localName: 'Tao' })!.header;
    expect(header.players).toEqual([
      { name: 'Tao', side: 0, skins: ['skin_l1'] },
      { name: '', side: 1, skins: ['skin_shop_r1'] },
    ]);
    // Ink was captured too, so the shared HUD has something to show.
    expect(header.schemaVersion).toBe(STATE_SCHEMA_VERSION);

    scene.destroy();
  });
});
