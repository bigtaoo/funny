// Regression coverage for GameScene/RoomScene reacting to the 'disconnected' NetState (2026-08-03
// fix). Before the fix there was only 'closed', used for both an intentional/graceful disconnect
// AND a permanent server-side rejection — every scene consumer only special-cased 'reconnecting', so
// a fatal mid-match/mid-room disconnect (e.g. evicted by another device) produced no visible error at
// all, just an indefinite "waiting/reconnecting" pill. 'disconnected' is now a distinct NetState value
// both scenes branch on explicitly.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { GameScene } from '../../src/scenes/GameScene';
import { RoomScene, type RoomSceneCallbacks } from '../../src/scenes/RoomScene';
import { setToastSink } from '../../src/net/log';

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
const GONE = t('reconnect.gone');

function hasText(container: PIXI.Container, text: string): boolean {
  let found = false;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === text) { found = true; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

describe('GameScene — NetStatusView shows a distinct message for a permanent disconnect', () => {
  function buildNetGameScene(): GameScene {
    return new GameScene(
      createLayout(W, H),
      new InputManager(),
      { onGameEnd() {}, onExitToLobby() {} },
      { seed: SEED, net: true },
    );
  }

  it('applyNetState("reconnecting") shows the ordinary reconnecting pill, not the disconnected message', () => {
    const scene = buildNetGameScene();
    scene.applyNetState('reconnecting');
    expect(hasText(scene.container, GONE)).toBe(false);
    scene.destroy();
  });

  it('regression: applyNetState("disconnected") shows a distinct "gone" message, not indistinguishable from reconnecting', () => {
    const scene = buildNetGameScene();
    scene.applyNetState('disconnected');
    expect(hasText(scene.container, GONE)).toBe(true);
    scene.destroy();
  });

  it('applyNetState("open") hides the disconnected pill again (NetStatusView.refresh() visibility, unchanged by this fix)', () => {
    const scene = buildNetGameScene();
    scene.applyNetState('disconnected');
    expect(hasText(scene.container, GONE)).toBe(true);
    const netStatusContainer = (scene as unknown as { renderer: { core: { netStatus: { container: PIXI.Container } } } })
      .renderer.core.netStatus.container;
    expect(netStatusContainer.visible).toBe(true);

    scene.applyNetState('open');
    // The pill hides (container.visible=false) — NetStatusView doesn't clear the stale Text content
    // once hidden (unnecessary work), so hasText() alone can't observe this; check visibility instead.
    expect(netStatusContainer.visible).toBe(false);
    scene.destroy();
  });
});

function buildRoom(cb: Partial<RoomSceneCallbacks> = {}): RoomScene {
  return new RoomScene(createLayout(W, H), new InputManager(), {
    onBack() {},
    createRoom() {},
    joinRoom() {},
    setReady() {},
    startMatch() {},
    createRanked() {},
    cancelQueue() {},
    available: true,
    ...cb,
  });
}

describe('RoomScene — permanent disconnect drops back to idle instead of hanging on a dead room/queue view', () => {
  it('regression: applyNetState("disconnected") resets the view to idle and toasts', () => {
    const toasts: Array<[string, string]> = [];
    setToastSink((text, kind) => toasts.push([text, kind]));
    const scene = buildRoom();
    (scene as unknown as { view: string }).view = 'inRoom';
    (scene as unknown as { mySide: number }).mySide = 0;

    scene.applyNetState('disconnected');

    const s = scene as unknown as { view: string; mySide: number };
    expect(s.view).toBe('idle');
    expect(s.mySide).toBe(-1);
    expect(toasts.some(([text]) => text === GONE)).toBe(true);
    scene.destroy();
  });

  it('applyNetState("reconnecting") while inRoom keeps the room view (does not bounce to idle)', () => {
    const scene = buildRoom();
    (scene as unknown as { view: string }).view = 'inRoom';

    scene.applyNetState('reconnecting');

    expect((scene as unknown as { view: string }).view).toBe('inRoom');
    scene.destroy();
  });

  it('applyNetState("disconnected") while idle (nothing to reset) does not throw', () => {
    const scene = buildRoom();
    expect(() => scene.applyNetState('disconnected')).not.toThrow();
    scene.destroy();
  });
});
