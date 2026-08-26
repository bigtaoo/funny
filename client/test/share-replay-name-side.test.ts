// Regression test for "a match shared by the netplay joiner had both names on the wrong side"
// (2026-08-26, found while fixing the shared-replay skins/animation/HUD trio).
//
// `doShareReplay` used to build the header's `players` itself, hardcoding the sharer's own name onto
// side 0 — correct for the host and for every single-player match, wrong for the joiner, who plays
// owner 1. It now passes only `localName` and lets the recorder place it on whichever side the render
// layer reported as local (`StateRecorder.setRoster`).
//
// Pins the nav boundary the same way test/skin-passthrough-net-replay.test.ts does — hand-built
// AppCtx, no PIXI, no engine — but goes one step further and asserts the *encoded header* that comes
// out of the recorder, since the bug lived exactly in the seam between the two.
import { describe, it, expect, beforeEach } from 'vitest';
import { createResultNav } from '../src/app/nav/result';
import { stateRecorder } from '../src/game/replay/StateRecorder';
import { decodeStateReplay, type EncodedStateReplay } from '../src/game/replay/StateReplay';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { ReplaySceneCallbacks } from '../src/scenes/ReplayScene';
import type { GameState, Replay } from '../src/game';
import { toFp } from '@nw/engine/math/fixed';

/** Minimal fake GameState for the recorder — same shape as test/stateRecorder.test.ts's mkState. */
function mkState(tick: number): GameState {
  return {
    elapsedTicks: tick,
    bottomPlayer: { baseHp_fp: toFp(100), ink: 3, upgradeLevel: 0 },
    topPlayer: { baseHp_fp: toFp(100), ink: 5, upgradeLevel: 0 },
    board: { units: new Map(), buildings: new Map() },
  } as unknown as GameState;
}

/**
 * Drive the real `goReplay` → capture the ReplayScene callbacks → fire `onShare`, which is the only
 * way into `doShareReplay` (it isn't exported). Returns the blob the share API was handed.
 */
async function shareViaReplayScene(playerName: string): Promise<EncodedStateReplay> {
  const captured: { uploaded?: EncodedStateReplay; cb?: ReplaySceneCallbacks } = {};

  const ctx = {
    platform: {
      onGameplayStart: () => {},
      onGameplayStop: () => {},
      shareReplay: () => Promise.resolve({ method: 'clipboard' as const, url: 'https://x/?r=code' }),
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    } as unknown as AppCtx['platform'],
    views: {
      showReplay: (_r: Replay, cb: ReplaySceneCallbacks) => { captured.cb = cb; },
    } as unknown as AppViews,
    api: {
      createStateReplayShare: (blob: unknown) => {
        captured.uploaded = blob as EncodedStateReplay;
        return Promise.resolve({ shareCode: 'code' });
      },
    } as unknown as AppCtx['api'],
    saveManager: { get: () => ({ equipped: {}, pvp: { elo: 1000, rank: 'bronze' } }) } as unknown as AppCtx['saveManager'],
    state: { inLobby: false } as unknown as AppState,
    nav: {} as Nav,
    playerName: () => playerName,
  } as unknown as AppCtx;

  createResultNav(ctx).goReplay({ mode: 'netplay' } as unknown as Replay);
  if (!captured.cb?.onShare) throw new Error('ReplayScene got no onShare callback');
  await captured.cb.onShare();
  if (!captured.uploaded) throw new Error('createStateReplayShare was never called');
  return captured.uploaded;
}

describe('shared replay — the sharer\'s name lands on the side they actually played', () => {
  beforeEach(() => {
    stateRecorder.reset();
  });

  it('joiner (owner 1): own name on side 1, opponent\'s on side 0', async () => {
    // What GameRenderer.buildSceneGraph reports for a joiner: local = owner 1, and only the opponent's
    // name is known from their profile (the local name comes from the share site, i.e. playerName()).
    stateRecorder.setRoster({
      localOwner: 1,
      local: { skins: ['skin_l1'] },
      opponent: { name: 'HostAlice', skins: [] },
    });
    stateRecorder.capture(mkState(0));
    stateRecorder.capture(mkState(1));

    const enc = await shareViaReplayScene('JoinerBob');
    expect(enc.header.players).toEqual([
      { name: 'HostAlice', side: 0 },
      { name: 'JoinerBob', side: 1, skins: ['skin_l1'] },
    ]);
  });

  it('host / single player (owner 0): own name stays on side 0', async () => {
    stateRecorder.setRoster({ localOwner: 0, local: { skins: [] }, opponent: {} });
    stateRecorder.capture(mkState(0));
    stateRecorder.capture(mkState(1));

    const enc = await shareViaReplayScene('HostAlice');
    // Empty opponent name is intentional (PvE/bot has no profile) — the dumb player labels it "red".
    expect(enc.header.players).toEqual([
      { name: 'HostAlice', side: 0 },
      { name: '', side: 1 },
    ]);
  });

  it('the uploaded blob still decodes to the frames that were captured', async () => {
    stateRecorder.setRoster({ localOwner: 0, local: {}, opponent: {} });
    stateRecorder.capture(mkState(0));
    stateRecorder.capture(mkState(1));

    const dec = decodeStateReplay(await shareViaReplayScene('HostAlice'));
    expect(dec.frames.map((f) => f.tick)).toEqual([0, 1]);
    expect(dec.frames[0]!.res).toEqual([
      { owner: 0, ink: 3, upgrade: 0 },
      { owner: 1, ink: 5, upgrade: 0 },
    ]);
  });
});
