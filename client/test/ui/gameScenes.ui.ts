// Gameplay-scene startup smoke tests — GameScene / ReplayScene.
//
// scenes.ui.ts covers the menu/overlay scenes but deliberately left these two out:
// they drive the FULL GameRenderer (board / units / buildings / HUD / VFX) off a
// live IGameEngine, which is the path most likely to "logic is fine but the screen
// explodes on entry". This file closes缺口 A — exercise that path headlessly.
//
// Same harness as scenes.ui.ts: the pixiHeadless adapter (vitest.ui.config.ts
// setupFiles) builds the real PIXI tree in plain Node. We never call
// setBakeRenderer(), so bake.ts returns null and every layer draws live on the CPU
// — no RenderTexture / WebGL is touched. STARTUP smoke, not a visual check.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import type { Scene } from '../../src/scenes/SceneManager';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';

import { GameScene } from '../../src/scenes/GameScene';
import { ReplayScene } from '../../src/scenes/ReplayScene';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel, type Replay } from '../../src/game';

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

/** Build → step a handful of frames → destroy. Asserts the tree is real and nothing throws. */
function exercise(scene: Scene): void {
  expect(scene.container).toBeInstanceOf(PIXI.Container);
  // A few frames: tick 0 emits the engine's initial-state events (units/buildings
  // spawn), so the first updates are where construction-time render wiring blows up.
  for (let i = 0; i < 8; i++) scene.update(1 / 30);
  scene.destroy();
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
  });
}

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
