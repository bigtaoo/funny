// The surrender dialog freezes the local match, so the renderer reports it as a pause
// (GameRendererCore.onPauseChange → PixiAppViews → IPlatform.onGameplayStop/Start; CrazyGames asks
// for gameplayStop on every in-game pause, CRAZYGAMES_LAUNCH §4). Open → true, cancel → false,
// confirm → no resume (it exits through onExitToLobby instead).
// Same headless approach as gameRendererInput.ui.ts. Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel } from '../../src/game';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

type R = { x: number; y: number; w: number; h: number };
const centre = (r: R) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

function setup() {
  const { engine } = createLocalMatch({ level: getLevel('ch1_lv1')! });
  const input = new InputManager();
  const renderer = new GameRenderer(engine, createLayout(800, 1280), input);
  renderer.init();
  for (let i = 0; i < 5; i++) renderer.update(1 / 30);
  const events: string[] = [];
  renderer.onPauseChange = (p) => events.push(p ? 'pause' : 'resume');
  renderer.onExitToLobby = () => events.push('exit');
  const hud = (renderer as unknown as { core: { hudView: {
    getSurrenderRect(): R; getSurrenderCancelRect(): R | null; getSurrenderConfirmRect(): R | null; isPaused: boolean;
  } } }).core.hudView;
  const tap = (r: R) => { const c = centre(r); input._emitDown(c.x, c.y); input._emitUp(c.x, c.y); };
  return { renderer, hud, events, tap };
}

describe('GameRenderer — surrender dialog reports gameplay pause', () => {
  it('open → pause, cancel → resume', () => {
    const { renderer, hud, events, tap } = setup();
    tap(hud.getSurrenderRect());
    expect(hud.isPaused).toBe(true);
    expect(events).toEqual(['pause']);
    tap(hud.getSurrenderCancelRect()!);
    expect(hud.isPaused).toBe(false);
    expect(events).toEqual(['pause', 'resume']);
    renderer.destroy();
  });

  it('confirm exits without a resume', () => {
    const { renderer, hud, events, tap } = setup();
    tap(hud.getSurrenderRect());
    tap(hud.getSurrenderConfirmRect()!);
    expect(events).toEqual(['pause', 'exit']);
    renderer.destroy();
  });
});
