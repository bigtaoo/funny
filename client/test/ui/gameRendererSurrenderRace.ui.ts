// Regression coverage for the post-game-over surrender race (2026-08-03 fix,
// client/src/render/GameRenderer/{input,base,events}.ts).
//
// Before: game_over/game_draw (and tutorial victory) showed the banner immediately but deferred
// `onGameEnd` via a bare, untracked `setTimeout(..., 2000)`. The surrender button was never gated on
// `gameEnded`, so a player could tap Surrender + Confirm during that window — synchronously calling
// `onExitToLobby` and navigating away — while the earlier setTimeout was still pending and neither
// tracked nor cancelled by destroy(). It fired ~2s later anyway, re-invoking `onGameEnd` against a
// scene the player had already left (duplicate reportResult/analytics/recordClear).
//
// Fix: `scheduleGameEnd()` tracks the timer handle (`destroy()` cancels it + nulls `onGameEnd`), and
// `handleDown` gates on `gameEnded` before any other input (including surrender) is processed.
//
// Drives a REAL local match engine to an actual game-over (forcing bottomPlayer.baseHp to 0 and
// ticking once) so this exercises the genuine events.ts `game_over` → `gameEnded=true` →
// `scheduleGameEnd()` pipeline, not just a hand-set flag.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { GameScene } from '../../src/scenes/GameScene';
import { createLocalMatch } from '../../src/app/matchEngine';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1280, 800];
const SEED = 0x1234abcd;

/** Drives the real engine to an actual game_over by zeroing the local (bottom) base's HP, then
 *  ticks the scene once so GameRenderer's events.ts processes the resulting event for real. */
function driveToGameOver(scene: GameScene, renderer: any): void {
  const engine = renderer.engine;
  engine.state.bottomPlayer.baseHp = 0;
  scene.update(1 / 30);
}

describe('GameRenderer — post-game-over surrender race (2026-08-03 fix)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tapping surrender+confirm after game_over does nothing (gameEnded gates all input)', () => {
    let exited = false;
    let ended = false;
    const input = new InputManager();
    const scene = new GameScene(
      createLayout(W, H),
      input,
      { onGameEnd: () => { ended = true; }, onExitToLobby: () => { exited = true; } },
      { seed: SEED },
    );
    const renderer = (scene as unknown as { renderer: any }).renderer;

    driveToGameOver(scene, renderer);
    expect(renderer.gameEnded).toBe(true);
    expect(ended).toBe(false); // onGameEnd is still deferred (2s), hasn't fired yet

    // Tap Surrender, then tap where Confirm would be — must be a complete no-op.
    const sr = renderer.hudView.getSurrenderRect();
    input._emitDown(sr.x + sr.w / 2, sr.y + sr.h / 2);
    input._emitUp(sr.x + sr.w / 2, sr.y + sr.h / 2);
    expect(renderer.hudView.isPaused).toBe(false); // never even opened the confirm overlay
    expect(exited).toBe(false);

    scene.destroy();
  });

  it('regression: destroy() cancels the pending onGameEnd timer — it never fires against a torn-down scene', () => {
    let endedCount = 0;
    const scene = new GameScene(
      createLayout(W, H),
      new InputManager(),
      { onGameEnd: () => { endedCount++; }, onExitToLobby: () => {} },
      { seed: SEED },
    );
    const renderer = (scene as unknown as { renderer: any }).renderer;

    driveToGameOver(scene, renderer);
    expect(renderer.gameEnded).toBe(true);

    scene.destroy(); // player exits (e.g. via a legitimate path) while onGameEnd is still pending

    vi.advanceTimersByTime(5000); // well past the 2000ms defer
    expect(endedCount).toBe(0); // must NOT have fired after destroy()
  });

  it('sanity: without an intervening destroy(), the deferred onGameEnd still fires normally', () => {
    let endedCount = 0;
    const scene = new GameScene(
      createLayout(W, H),
      new InputManager(),
      { onGameEnd: () => { endedCount++; }, onExitToLobby: () => {} },
      { seed: SEED },
    );
    const renderer = (scene as unknown as { renderer: any }).renderer;

    driveToGameOver(scene, renderer);
    vi.advanceTimersByTime(2100);
    expect(endedCount).toBe(1); // fires exactly once when nothing interrupts it

    scene.destroy();
  });
});
