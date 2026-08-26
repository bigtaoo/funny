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
import { initI18n, t } from '../../src/i18n';
import { InputManager } from '../../src/inputSystem/InputManager';
import { GameScene } from '../../src/scenes/GameScene';
import { StatePlayerScene, skinsForOwner } from '../../src/scenes/StatePlayerScene';
import { UnitView } from '../../src/render/UnitView';
import { BoardView } from '../../src/render/BoardView';
import { stateRecorder } from '../../src/game/replay/StateRecorder';
import {
  STATE_SCHEMA_VERSION, encodeStateReplay, decodeStateReplay,
  type StateFrame, type StateReplay,
} from '../../src/game/replay/StateReplay';

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

const CB = { onPlayDemo() {}, onBackToLogin() {} };

/** Most recent call of a spy. (`Array.prototype.at` needs lib es2022; this project targets ES2020.) */
function lastCall<A extends unknown[]>(spy: { mock: { calls: A[] } }): A {
  const { calls } = spy.mock;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('spy was never called');
  return last;
}

/**
 * Hand-built stream (no recorder needed): one walking unit per side, a skin each, and ink that moves
 * in opposite directions per side (owner 0: 7 → 9 → 11, owner 1: 3 → 2 → 1) so a test can tell "the
 * HUD is synced every frame" from "the HUD was filled in once at build time", and "owner 0's readout"
 * from "owner 1's".
 */
function mkShared(opts: { skins?: boolean; res?: boolean } = {}): StateReplay {
  const { skins = true, res = true } = opts;
  const frame = (i: number, row: number): StateFrame => ({
    tick: i * 30,
    units: [
      { id: 1, type: 'infantry', side: 0, col: 3, row, hp: 100, maxHp: 100, state: 'moving' },
      { id: 2, type: 'archer', side: 1, col: 8, row: 16, hp: 60, maxHp: 60, state: 'moving' },
    ],
    buildings: [],
    bases: [{ owner: 0, hp: 80, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }],
    ...(res ? { res: [{ owner: 0, ink: 7 + i * 2, upgrade: 1 }, { owner: 1, ink: 3 - i, upgrade: 0 }] } : {}),
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
    frames: [frame(0, 1), frame(1, 4), frame(2, 7)],
  };
}

interface HudProbe {
  container: PIXI.Container;
  sides: Record<0 | 1, { hp: PIXI.Graphics; inkText: PIXI.Text }>;
}

/** The scene's HUD, reached through the private field the tests need to observe. */
function hudOf(scene: StatePlayerScene): HudProbe {
  return (scene as unknown as { hud: HudProbe }).hud;
}

/** The transport overlay (progress bar / buttons / tag), likewise private. */
function overlayOf(scene: StatePlayerScene): PIXI.Container {
  return (scene as unknown as { overlay: PIXI.Container }).overlay;
}

/** Every drawn, currently-visible box under `root`, in design space. Empty graphics are skipped —
 *  PIXI reports a zero-size rect at the origin for them, which would false-positive an overlap. */
function visibleBoxes(root: PIXI.Container): PIXI.Rectangle[] {
  const out: PIXI.Rectangle[] = [];
  const walk = (c: PIXI.Container): void => {
    if (!c.visible) return;
    for (const ch of c.children) {
      if (!(ch instanceof PIXI.Container)) continue;
      if (!ch.visible) continue;
      if (ch.children.length > 0) { walk(ch); continue; }
      const b = ch.getBounds();
      if (b.width > 0 && b.height > 0) out.push(b);
    }
  };
  walk(root);
  return out;
}

/** Do two boxes overlap vertically (the axis the HUD strips divide the screen on)? */
function overlapsBand(box: PIXI.Rectangle, band: { y: number; h: number }): boolean {
  return box.y < band.y + band.h && box.y + box.height > band.y;
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
    expect(lastCall(sync)[1]).toBeCloseTo(1 / 30, 6);

    // At 2× the units cross the board twice as fast, so their legs have to run twice as fast too.
    (scene as unknown as { speedIdx: number }).speedIdx = 1;
    scene.update(1 / 30);
    expect(lastCall(sync)[1]).toBeCloseTo(2 / 30, 6);

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

  it('puts each owner\'s readouts on its own strip — owner 0 bottom, owner 1 top', () => {
    // The mapping is fixed (the dumb player never mirrors the viewpoint), and swapping it is the
    // classic failure here — a set-wise check on the two numbers would pass a swap.
    const layout = createLayout(...PORTRAIT);
    const scene = new StatePlayerScene(layout, mkShared(), CB);
    scene.update(1 / 30);
    const hud = hudOf(scene);

    expect(hud.sides[0].inkText.text).toBe('7');
    expect(hud.sides[1].inkText.text).toBe('3');
    for (const [owner, band] of [[0, layout.hudBottomLeftRect], [1, layout.hudTopRect]] as const) {
      for (const gfx of [hud.sides[owner].hp, hud.sides[owner].inkText]) {
        expect(overlapsBand(gfx.getBounds(), band)).toBe(true);
      }
    }
    // Names too: each side's label sits in that side's strip.
    const label = (name: string): PIXI.Text => {
      const found = hud.container.children.find((c): c is PIXI.Text => c instanceof PIXI.Text && c.text === name);
      if (!found) throw new Error(`no HUD label for ${name}`);
      return found;
    };
    expect(overlapsBand(label('Tao').getBounds(), layout.hudBottomLeftRect)).toBe(true);
    expect(overlapsBand(label('Anna').getBounds(), layout.hudTopRect)).toBe(true);

    scene.destroy();
  });

  it('keeps the HUD in sync as playback advances (not filled in once at build time)', () => {
    const scene = new StatePlayerScene(createLayout(...PORTRAIT), mkShared(), CB);
    scene.update(1 / 30);
    expect([hudOf(scene).sides[0].inkText.text, hudOf(scene).sides[1].inkText.text]).toEqual(['7', '3']);

    // Past tick 30 → the second frame is current: owner 0 spent up to 9, owner 1 down to 2.
    for (let i = 0; i < 34; i++) scene.update(1 / 30);
    expect([hudOf(scene).sides[0].inkText.text, hudOf(scene).sides[1].inkText.text]).toEqual(['9', '2']);

    scene.destroy();
  });

  it('drives the board\'s base rings from the recorded upgrade level', () => {
    const spy = vi.spyOn(BoardView.prototype, 'setBaseUpgradeLevel');
    const scene = new StatePlayerScene(createLayout(...PORTRAIT), mkShared(), CB);
    scene.update(1 / 30);

    expect(spy).toHaveBeenCalledWith(0, 1); // fixture: owner 0 upgraded once
    expect(spy).toHaveBeenCalledWith(1, 0);

    scene.destroy();
    spy.mockRestore();
  });

  it('feeds UnitView a finite attack interval (a missing field would reach the rig as NaN)', () => {
    const sync = vi.spyOn(UnitView.prototype, 'sync');
    const scene = new StatePlayerScene(createLayout(...PORTRAIT), mkShared(), CB);
    scene.update(1 / 30);

    const board = lastCall(sync)[0] as unknown as {
      units: Map<number, { effectiveAttackIntervalTicks: number }>;
    };
    for (const unit of board.units.values()) {
      expect(Number.isFinite(unit.effectiveAttackIntervalTicks)).toBe(true);
    }

    scene.destroy();
    sync.mockRestore();
  });

  it('re-shares an adopted stream verbatim, skins and ink included', () => {
    stateRecorder.reset();
    const encoded = encodeStateReplay(mkShared());
    const scene = new StatePlayerScene(createLayout(...PORTRAIT), decodeStateReplay(encoded), CB, encoded);

    // Watching someone's share and hitting share again must forward the original bytes — no re-capture
    // (the dumb player runs no engine, so there is nothing to re-record), and no header rewrite either.
    expect(stateRecorder.build({ localName: 'SomeoneElse' })).toBe(encoded);
    expect(encoded.header.players[0]?.skins).toEqual(['skin_l1']);
    expect(encoded.frames.some((f) => f.rs !== undefined)).toBe(true);

    scene.destroy();
    stateRecorder.reset();
  });
});

// The transport chrome floats over the board, so nothing keeps it off the HUD strips but the geometry
// itself: the progress bar used to be placed at a fraction of the design height, which in landscape
// (a shorter design space with the same 70px strip) landed it inside the top strip, on top of the
// enemy HP bar; the "shared replay" tag was sized off the button height alone and grew until it ran
// under the centered transport buttons on a tall portrait screen.
describe('StatePlayerScene — transport chrome clears the HUD strips', () => {
  for (const [label, size] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
    it(`${label}: no transport widget overlaps either strip, and the tag stays left of the bar`, () => {
      const layout = createLayout(...size);
      const scene = new StatePlayerScene(layout, mkShared(), CB);
      scene.update(1 / 30);

      const boxes = visibleBoxes(overlayOf(scene));
      expect(boxes.length).toBeGreaterThan(0);
      for (const band of [layout.hudTopRect, layout.hudBottomLeftRect]) {
        for (const box of boxes) expect(overlapsBand(box, band)).toBe(false);
      }

      // The "shared replay" tag lives in the gap left of the progress bar; its font size is capped
      // and it is additionally scaled down to fit that gap. Only its *presence and side* can be
      // checked here — the harness' measureText mock is a flat 7px/char, font-size-independent, so
      // a too-wide label is invisible to it. The real fit is exercised in
      // test/browser/shareReplay.spec.ts.
      const tag = overlayOf(scene).children.find(
        (c): c is PIXI.Text => c instanceof PIXI.Text && c.text === t('stateplayer.tag'),
      );
      expect(tag).toBeDefined();
      expect(tag!.x).toBeLessThan((scene as unknown as { barX: number }).barX);

      scene.destroy();
    });
  }

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
