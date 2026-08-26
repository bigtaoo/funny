// Gameplay-scene startup smoke tests — GameScene / ReplayScene.
//
// scenes.ui.ts covers the menu/overlay scenes but deliberately left these two out:
// they drive the FULL GameRenderer (board / units / buildings / HUD / VFX) off a
// live IGameEngine, which is the path most likely to "logic is fine but the screen
// explodes on entry". This file closes gap A — exercise that path headlessly.
//
// Same harness as scenes.ui.ts: the pixiHeadless adapter (vitest.ui.config.ts
// setupFiles) builds the real PIXI tree in plain Node. We never call
// setBakeRenderer(), so bake.ts returns null and every layer draws live on the CPU
// — no RenderTexture / WebGL is touched. STARTUP smoke, not a visual check.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import type { Scene } from '../../src/scenes/SceneManager';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';

import { GameScene } from '../../src/scenes/GameScene';
import { ReplayScene } from '../../src/scenes/ReplayScene';
import { StatePlayerScene } from '../../src/scenes/StatePlayerScene';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel, type Replay, Side, UnitType, UnitState, BuildingType } from '../../src/game';
import { stateRecorder } from '../../src/game/replay/StateRecorder';
import { decodeStateReplay, type StateReplay } from '../../src/game/replay/StateReplay';
import type { GameState } from '../../src/game';

// In-memory storage so initI18n (which persists the locale) has somewhere to write.
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

const SEED = 0x1234abcd;

/** Every PIXI.Text baseTexture reachable from `root` (recursing sub-containers) — collect
 * BEFORE the teardown under test, since a Text's own `.texture` reference goes away on destroy.
 * Same helper as scenes.ui.ts / campaignMapTextTeardown.ui.ts. */
function collectTextBaseTextures(root: PIXI.Container): PIXI.BaseTexture[] {
  const out: PIXI.BaseTexture[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.texture.baseTexture);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

/**
 * Build → step a handful of frames → destroy. Asserts the tree is real, nothing throws, the
 * container is actually torn down, and every Text canvas texture is actually freed (not just
 * detached) — same invariants scenes.ui.ts's exercise() checks for the menu/overlay scenes,
 * extended here to the full-GameRenderer gameplay scenes (2026-08-03; see
 * claudedocs/client-memory-leak.md §8.7 for why this outcome-based check matters more than a
 * bare container.destroyed check).
 */
function exercise(scene: Scene): void {
  expect(scene.container).toBeInstanceOf(PIXI.Container);
  // A few frames: tick 0 emits the engine's initial-state events (units/buildings
  // spawn), so the first updates are where construction-time render wiring blows up.
  for (let i = 0; i < 8; i++) scene.update(1 / 30);
  const textBaseTextures = collectTextBaseTextures(scene.container);
  scene.destroy();
  expect(scene.container.destroyed).toBe(true);
  expect(textBaseTextures.every((b) => b.destroyed)).toBe(true);
}

/** A real recorded match: drive a local PvP-vs-AI engine, then snapshot its stream. */
function recordReplay(frames: number): Replay {
  const { engine, buildReplay } = createLocalMatch({ seed: SEED });
  for (let i = 0; i < frames; i++) engine.tick(1 / 30);
  return buildReplay(null);
}

/** A real recorded campaign run, so the replay carries a levelId for getLevel() rebuild. */
function recordCampaignReplay(levelId: string, frames: number): Replay {
  const level = getLevel(levelId)!;
  const { engine, buildReplay } = createLocalMatch({ level });
  for (let i = 0; i < frames; i++) engine.tick(1 / 30);
  return buildReplay(null);
}

// ── StatePlayerScene fixture ──────────────────────────────────────────────────
// StatePlayerScene plays the OTHER replay format (StateReplay, REPLAY_SHARE_DESIGN §2.1) — a
// dumb entity-state stream, no engine involved. Same minimal fake-GameState harness as
// test/stateRecorder.test.ts (mkState): capture a couple of frames on the shared recorder
// singleton, encode, decode back into a StateReplay.
interface FakeUnit {
  id: number; unitType: UnitType; side: Side;
  colExact: number; rowExact: number; hp: number; maxHp: number; state: UnitState;
}
interface FakeBuilding {
  id: number; buildingType: BuildingType; side: Side;
  col: number; row: number; hp: number; maxHp: number;
}

function mkState(tick: number, units: FakeUnit[] = [], buildings: FakeBuilding[] = []): GameState {
  return {
    elapsedTicks: tick,
    bottomPlayer: { baseHp: 100 },
    topPlayer: { baseHp: 100 },
    board: {
      units: new Map(units.map((u) => [u.id, u])),
      buildings: new Map(buildings.map((b) => [b.id, b])),
    },
  } as unknown as GameState;
}

/** A minimal-but-real StateReplay: one unit + one building across a couple of ticks. */
function recordStateReplay(): StateReplay {
  stateRecorder.reset();
  const unit: FakeUnit = {
    id: 1, unitType: UnitType.Infantry, side: Side.Bottom,
    colExact: 3, rowExact: 1, hp: 100, maxHp: 100, state: UnitState.Moving,
  };
  const building: FakeBuilding = {
    id: 2, buildingType: BuildingType.Barracks, side: Side.Bottom,
    col: 1, row: 8, hp: 200, maxHp: 200,
  };
  stateRecorder.capture(mkState(0, [unit], [building]));
  stateRecorder.capture(mkState(1, [{ ...unit, rowExact: 1.5 }], [building]));
  const enc = stateRecorder.build({ mode: 'pvp' })!;
  return decodeStateReplay(enc);
}

for (const [label, [w, h]] of [
  ['portrait', PORTRAIT],
  ['landscape', LANDSCAPE],
] as const) {
  describe(`gameplay scene startup smoke — ${label} ${w}x${h}`, () => {
    it('GameScene (PvP-vs-AI, seeded) builds, steps and destroys', () => {
      exercise(
        new GameScene(
          createLayout(w, h),
          new InputManager(),
          { onGameEnd() {}, onExitToLobby() {} },
          { seed: SEED },
        ),
      );
    });

    it('GameScene (campaign survive ch1_lv1) builds, steps and destroys', () => {
      const level = getLevel('ch1_lv1')!;
      exercise(
        new GameScene(
          createLayout(w, h),
          new InputManager(),
          { onGameEnd() {}, onExitToLobby() {} },
          { level },
        ),
      );
    });

    it('GameScene (campaign boss ch1_lv10) builds, steps and destroys', () => {
      // Boss objective adds the enemy-base `BOSS` battle label — a distinct
      // construction path from survive levels.
      const level = getLevel('ch1_lv10')!;
      expect(level.objective.kind).toBe('boss');
      exercise(
        new GameScene(
          createLayout(w, h),
          new InputManager(),
          { onGameEnd() {}, onExitToLobby() {} },
          { level },
        ),
      );
    });

    it('ReplayScene (PvP replay) builds, plays and destroys', () => {
      const replay = recordReplay(60);
      exercise(
        new ReplayScene(createLayout(w, h), new InputManager(), replay, { onExit() {} }),
      );
    });

    it('ReplayScene (campaign replay, rebuilt via getLevel) builds, plays and destroys', () => {
      const replay = recordCampaignReplay('ch1_lv1', 60);
      exercise(
        new ReplayScene(createLayout(w, h), new InputManager(), replay, { onExit() {} }),
      );
    });

    it('StatePlayerScene (dumb entity-state replay) builds, plays and destroys', () => {
      const replay = recordStateReplay();
      exercise(
        new StatePlayerScene(createLayout(w, h), replay, { onPlayDemo() {}, onBackToLogin() {} }),
      );
    });
  });
}

// ── GameScene: net-callback destroyed-guard (2026-08-03 fix) ────────────────────────────────────
//
// applyNetState/applyPeerDc/applyMatchOver are invoked directly from long-lived NetSession event
// closures (see app.ts's showGameNet / nav/result.ts), not from SceneManager's per-frame tick — so
// they stay reachable after this scene (and its renderer) has been destroyed, e.g. a late
// match_over/peer_dc arriving while the player is already sitting on ResultScene (session.handlers
// isn't always reassigned promptly — see nav/result.ts). Before the fix, any of these calls after
// destroy() would touch the already-destroyed GameRenderer's container/NetStatusView.
describe('GameScene — net callbacks are inert after destroy() (2026-08-03 fix)', () => {
  function buildNetGameScene(): GameScene {
    return new GameScene(
      createLayout(...LANDSCAPE),
      new InputManager(),
      { onGameEnd() {}, onExitToLobby() {}, onNetMatchOver() {} },
      { seed: SEED, net: true },
    );
  }

  it('applyNetState after destroy() does not throw', () => {
    const scene = buildNetGameScene();
    scene.destroy();
    expect(() => scene.applyNetState('reconnecting')).not.toThrow();
    expect(() => scene.applyNetState('disconnected')).not.toThrow();
  });

  it('applyPeerDc after destroy() does not throw', () => {
    const scene = buildNetGameScene();
    scene.destroy();
    expect(() => scene.applyPeerDc({ side: 0, graceMs: 5000 })).not.toThrow();
  });

  it('applyMatchOver after destroy() does not throw and does not fire onNetMatchOver', () => {
    let fired = false;
    const scene = new GameScene(
      createLayout(...LANDSCAPE),
      new InputManager(),
      { onGameEnd() {}, onExitToLobby() {}, onNetMatchOver: () => { fired = true; } },
      { seed: SEED, net: true },
    );
    scene.destroy();
    expect(() => scene.applyMatchOver({ winnerSide: 0, reason: 'disconnect', mismatch: false })).not.toThrow();
    expect(fired).toBe(false); // the destroyed-guard bails before ever reaching cb.onNetMatchOver
  });

  it('sanity: applyMatchOver still fires onNetMatchOver normally BEFORE destroy (guards don\'t overreach)', () => {
    let fired = false;
    const scene = new GameScene(
      createLayout(...LANDSCAPE),
      new InputManager(),
      { onGameEnd() {}, onExitToLobby() {}, onNetMatchOver: () => { fired = true; } },
      { seed: SEED, net: true },
    );
    scene.applyMatchOver({ winnerSide: 0, reason: 'disconnect', mismatch: false });
    expect(fired).toBe(true);
    scene.destroy();
  });
});

// ── ReplayScene: spectator playback advances and ends ────────────────────────
describe('ReplayScene — playback', () => {
  it('advances currentTick while playing and stops at endFrame', () => {
    const replay = recordReplay(45);
    const scene = new ReplayScene(createLayout(...PORTRAIT), new InputManager(), replay, {
      onExit() {},
    });
    // Step well past the recording length; playback must terminate, not run forever.
    for (let i = 0; i < 200; i++) scene.update(1 / 30);
    expect((scene as any).ended).toBe(true);
    scene.destroy();
  });

  it('renders a transport overlay (controls drawn on top of the spectator view)', () => {
    const replay = recordReplay(30);
    const scene = new ReplayScene(createLayout(...PORTRAIT), new InputManager(), replay, {
      onExit() {},
    });
    const overlay = (scene as any).overlay as PIXI.Container;
    expect(overlay).toBeInstanceOf(PIXI.Container);
    expect(overlay.children.length).toBeGreaterThan(0);
    scene.destroy();
  });
});

// ── ReplayScene: distinct load-error messages + real exception logged (2026-08-03 fix) ───────────
//
// Before: `errorMsg = e instanceof ReplayVersionError ? t('replay.versionError') : t('replay.versionError')`
// — both branches produced the identical string, so a genuinely corrupted replay or an invalid
// stale levelId was misreported to the player as "version incompatible" (factually wrong), and the
// real exception was never logged anywhere (no way to tell an expected version skip from a real bug
// from the console/telemetry).
describe('ReplayScene — construction-failure error messages (2026-08-03 fix)', () => {
  it('a genuine engine-version mismatch reports replay.versionError', () => {
    const replay = recordReplay(10);
    (replay as unknown as { engineVersion: number }).engineVersion = replay.engineVersion + 999;
    const scene = new ReplayScene(createLayout(...PORTRAIT), new InputManager(), replay, { onExit() {} });
    const s = scene as unknown as { errorMsg: string; renderer: unknown; ended: boolean };
    expect(s.renderer).toBeNull();
    expect(s.ended).toBe(true);
    expect(s.errorMsg).toBe('Replay version incompatible — cannot play back');
    scene.destroy();
  });

  it('regression: a non-version load failure (corrupted replay data) reports a distinct, generic message — not "version incompatible"', () => {
    const replay = recordCampaignReplay('ch1_lv1', 10);
    // Corrupt the recording itself so the constructor throws a plain TypeError, unrelated to
    // engine version — same shape as truncated/corrupted replay JSON coming back from storage.
    (replay as unknown as { frames: unknown }).frames = null;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scene = new ReplayScene(createLayout(...PORTRAIT), new InputManager(), replay, { onExit() {} });
    const s = scene as unknown as { errorMsg: string; renderer: unknown; ended: boolean };
    expect(s.renderer).toBeNull();
    expect(s.ended).toBe(true);
    expect(s.errorMsg).not.toBe('Replay version incompatible — cannot play back');
    expect(s.errorMsg).toBe('Something went wrong — please try again');
    // The real exception must actually be logged somewhere, not silently swallowed.
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    scene.destroy();
  });
});

// ── Transport chrome geometry + loss vignette (§26 fix) ──────────────────────
// Regression coverage for a user-reported bug on a wide landscape screen: the
// progress bar + Pause/2×/Share/Exit row were sized off layout.designWidth (which
// is padded with side margins in landscape), overhanging past the board's own
// edges; the buttons were fully opaque even though they unavoidably cover the
// board's top row; and a losing final frame left GameRenderer's screen-edge red
// vignette pinned at full alpha forever because ReplayScene stops driving
// renderer.update() the instant playback ends.
describe('ReplayScene — transport chrome geometry (§26)', () => {
  // Wide enough that designWidth (padded for a wide safe area) meaningfully
  // exceeds the board's own width — this is exactly the shape of screen the bug
  // reproduced on. At a plain 16:9 viewport designWidth ends up equal to the
  // board-centering width, so the old (unclamped) formula and the new one land on
  // the same numbers — this viewport is required to tell them apart.
  const WIDE_LANDSCAPE: [number, number] = [2400, 900];

  it('progress bar + button row stay within the board rect, not the full (padded) design width', () => {
    const replay = recordReplay(30);
    const layout = createLayout(...WIDE_LANDSCAPE);
    const board = layout.boardRect;
    // Sanity-check this viewport actually exercises the padded case the bug needs.
    expect(layout.designWidth).toBeGreaterThan(board.w + 200);

    const scene = new ReplayScene(layout, new InputManager(), replay, { onExit() {} }) as any;
    scene.update(1 / 30);

    expect(scene.barX).toBeGreaterThanOrEqual(board.x);
    expect(scene.barX + scene.barW).toBeLessThanOrEqual(board.x + board.w);

    // Button backgrounds are PIXI.Graphics at the transport row's height (btnH);
    // filter by that instead of a fixed child index — track/hotspots/status panel
    // are all distinct heights and would otherwise collide with a hardcoded index.
    const btnH = Math.round(layout.designHeight * 0.05);
    const overlay = scene.overlay as PIXI.Container;
    const buttons = overlay.children.filter(
      // sketchPanel's hand-drawn stroke jitter perturbs the exact bounding box by a
      // few px, so match within a tolerance rather than the nominal height exactly.
      (c): c is PIXI.Graphics => c instanceof PIXI.Graphics && Math.abs(c.height - btnH) < 5,
    );
    expect(buttons.length).toBeGreaterThanOrEqual(3); // play + speed + exit (+ share when enabled)
    const rowMinX = Math.min(...buttons.map((c) => c.x));
    const rowMaxX = Math.max(...buttons.map((c) => c.x + c.width));
    expect(rowMinX).toBeGreaterThanOrEqual(board.x);
    expect(rowMaxX).toBeLessThanOrEqual(board.x + board.w);

    scene.destroy();
  });

  it('button panels are translucent (board row behind them should still read through)', () => {
    const replay = recordReplay(30);
    const layout = createLayout(...LANDSCAPE);
    const scene = new ReplayScene(layout, new InputManager(), replay, { onExit() {} }) as any;
    scene.update(1 / 30);

    const btnH = Math.round(layout.designHeight * 0.05);
    const overlay = scene.overlay as PIXI.Container;
    const button = overlay.children.find(
      // sketchPanel's hand-drawn stroke jitter perturbs the exact bounding box by a
      // few px, so match within a tolerance rather than the nominal height exactly.
      (c): c is PIXI.Graphics => c instanceof PIXI.Graphics && Math.abs(c.height - btnH) < 5,
    )!;
    expect(button).toBeTruthy();
    const fillAlpha = button.geometry.graphicsData[0]!.fillStyle.alpha;
    // Not fully opaque (the whole point of the fix) and not so faint it's unreadable.
    expect(fillAlpha).toBeLessThan(0.9);
    expect(fillAlpha).toBeGreaterThan(0.3);

    scene.destroy();
  });

  it('clears the screen-edge loss vignette the instant playback ends, instead of leaving it pinned', () => {
    const replay = recordReplay(30);
    const scene = new ReplayScene(createLayout(...PORTRAIT), new InputManager(), replay, {
      onExit() {},
    }) as any;

    // Run up to (but not past) the last tick, then simulate "a decisive hit just
    // landed on the viewed side's base" — exactly what base_hp_changed does to
    // GameRenderer.vignetteAlpha right before a losing game_over fires.
    for (let i = 0; i < scene.endFrame - 1 && !scene.ended; i++) scene.update(1 / 30);
    expect(scene.ended).toBe(false);
    scene.renderer.events.vignetteAlpha = 1;

    scene.update(1 / 30); // the final tick: pushes currentTick to endFrame, ends playback

    expect(scene.ended).toBe(true);
    expect(scene.renderer.events.vignetteAlpha).toBe(0);

    scene.destroy();
  });
});

// ── Siege replay player names (§16.3) ────────────────────────────────────────
// Siege replays feed the attacker/defender display names through meta.players
// (owner-indexed: bottom = attacker = owner0, top = defender = owner1). The generic
// PvP/campaign placeholders (replay.player1/2) only show when a name is blank. This
// asserts both base plates and both HP-bar name chips pick up the provided names.
describe('ReplayScene — siege player names', () => {
  /** All PIXI.Text strings in a container subtree. */
  function collectTexts(node: PIXI.Container): string[] {
    const out: string[] = [];
    const walk = (n: PIXI.Container): void => {
      if (n instanceof PIXI.Text) out.push(n.text);
      for (const c of n.children) walk(c as PIXI.Container);
    };
    walk(node);
    return out;
  }

  it('draws attacker (bottom) + defender (top) names once each, on the two HP-bar chips', () => {
    const replay = recordReplay(30);
    replay.meta = { ...(replay.meta ?? {}), players: { bottom: 'AtkAlice', top: 'DefBob' } };
    const scene = new ReplayScene(createLayout(...LANDSCAPE), new InputManager(), replay, {
      onExit() {},
    });
    scene.update(1 / 30);
    const texts = collectTexts((scene as any).container);
    // The real names render, not the generic placeholders.
    expect(texts).toContain('AtkAlice');
    expect(texts).toContain('DefBob');
    expect(texts).not.toContain('Player 1');
    expect(texts).not.toContain('Player 2');
    // Exactly one chip per side — the viewpoint player's on our own HP bar, the enemy's left
    // of the top-strip bar. The standalone "View: <name>" tag and the two over-the-base name
    // plates are both gone, so a bare name on the near-side HP bar is the whole viewpoint cue.
    expect(texts.filter((s) => s === 'AtkAlice')).toHaveLength(1);
    expect(texts.filter((s) => s === 'DefBob')).toHaveLength(1);
    expect(texts.some((s) => s.includes('View:'))).toBe(false);
    scene.destroy();
  });

  it('falls back to generic placeholders when a name is blank (PvE defender)', () => {
    const replay = recordReplay(30);
    replay.meta = { ...(replay.meta ?? {}), players: { bottom: 'AtkAlice', top: '' } };
    const scene = new ReplayScene(createLayout(...LANDSCAPE), new InputManager(), replay, {
      onExit() {},
    });
    scene.update(1 / 30);
    const texts = collectTexts((scene as any).container);
    expect(texts).toContain('AtkAlice');
    expect(texts).toContain('Player 2'); // blank top → placeholder
    scene.destroy();
  });

  // The name chips are the only thing that says which side you're watching now that the
  // over-the-base plates are gone (2026-08-26), so what "our side" means geometrically has to
  // be exactly what a live match means by it: the viewed side's base on the near side (left in
  // landscape), its HP on the bottom strip. That holds for BOTH viewpoints because a flip
  // rebuilds the renderer on `layout.mirrored()` — the very layout a netplay joiner plays on.
  it('either viewpoint puts the viewed side where a live match puts it (own base near side)', () => {
    const replay = recordReplay(30);
    replay.meta = { ...(replay.meta ?? {}), players: { bottom: 'AtkAlice', top: 'DefBob' } };
    const scene = new ReplayScene(createLayout(...LANDSCAPE), new InputManager(), replay, {
      onExit() {},
    });
    scene.update(1 / 30);

    const view = (): { side: Side; owner: number; own: number; enemy: number } => {
      const core = (scene as any).renderer.core;
      return {
        side: core.layout.localSide,
        owner: core.localOwner,
        own: core.layout.playerBaseRect().x,
        enemy: core.layout.enemyBaseRect().x,
      };
    };

    // Default viewpoint = the recording's bottom player (owner 0), whose base is the left one.
    const bottomView = view();
    expect(bottomView.side).toBe(Side.Bottom);
    expect(bottomView.owner).toBe(0);
    expect(bottomView.own).toBeLessThan(bottomView.enemy);
    expect(collectTexts((scene as any).container)).toContain('AtkAlice');

    // Flip, then let the cross-fade finish so `renderer` is the new (mirrored) one.
    (scene as any).switchViewpoint();
    for (let i = 0; i < 20; i++) scene.update(1 / 30);
    const topView = view();
    expect(topView.side).toBe(Side.Top);
    expect(topView.owner).toBe(1);

    // Both bases stay on the same screen halves — only WHOSE they are changes. Compared against
    // a real joiner-side layout, not against hardcoded pixels.
    const joinerLayout = createLayout(...LANDSCAPE, Side.Top);
    expect(topView.own).toBe(joinerLayout.playerBaseRect().x);
    expect(topView.enemy).toBe(joinerLayout.enemyBaseRect().x);
    expect(topView.own).toBe(bottomView.own);
    expect(topView.enemy).toBe(bottomView.enemy);

    scene.destroy();
  });
});
