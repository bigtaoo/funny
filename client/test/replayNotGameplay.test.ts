// Watching a replay is not gameplay (CRAZYGAMES_LAUNCH §4): goReplay (result screen / records page)
// must not report gameplayStart, or the portal counts playback as play time and — from the records
// page, where no stop follows — leaves the session marked as playing.
import { describe, it, expect, vi } from 'vitest';
import { createResultNav } from '../src/app/nav/result';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { ReplaySceneCallbacks } from '../src/scenes/ReplayScene';
import type { Replay } from '../src/game';

describe('goReplay — playback is not gameplay', () => {
  it('reports no gameplayStart, and exiting goes where the caller said', () => {
    const onGameplayStart = vi.fn();
    const shown: { cb?: ReplaySceneCallbacks } = {};
    const ctx = {
      platform: { onGameplayStart, onGameplayStop: vi.fn() } as unknown as AppCtx['platform'],
      views: { showReplay: (_r: Replay, cb: ReplaySceneCallbacks) => { shown.cb = cb; } } as unknown as AppViews,
      api: null,
      saveManager: { get: () => ({ equipped: {} }) } as unknown as AppCtx['saveManager'],
      state: { inLobby: true } as unknown as AppState,
      nav: {} as Nav,
      playerName: () => 'p',
    } as unknown as AppCtx;
    const back = vi.fn();
    createResultNav(ctx).goReplay({ mode: 'campaign' } as unknown as Replay, back);
    expect(onGameplayStart).not.toHaveBeenCalled();
    shown.cb!.onExit();
    expect(back).toHaveBeenCalledOnce();
    expect(onGameplayStart).not.toHaveBeenCalled();
  });
});
