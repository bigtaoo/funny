// Regression test for "Fight Again re-enters a match instead of the lobby".
//
// Root cause (05.07.2026 result-screen back-button pass): the PvE-vs-AI practice
// match's onGameEnd handler called `nav.goResult(winner, stats, 0, replay)` with no
// onPlayAgain override, so ResultScene's default ("play again" == goLobby()) kicked
// in — "FIGHT AGAIN" silently dropped the player back at the lobby instead of
// starting a new match. Fixed in src/app/nav/game.ts by passing an onPlayAgain that
// calls goGame() again (re-rolling AI difficulty off the current ELO, same formula
// the lobby's own "start match" entry uses).
//
// This pins the contract directly against createGameNav, without a real PIXI scene
// or a full engine simulation — see test/social-world-chat-playername.test.ts for
// the same "hand-built AppCtx" unit-test style.
import { describe, it, expect } from 'vitest';
import { createGameNav } from '../src/app/nav/game';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { GameSceneCallbacks, GameSceneOptions } from '../src/scenes/GameScene';
import type { PlayerStats } from '../src/game/types';

const zeroStats = (owner: 0 | 1): PlayerStats => ({
  owner,
  damageDealtToBase: 0,
  damageTakenByBase: 0,
  unitsSent: 0,
  unitsKilled: 0,
  spellHits: 0,
  killsByType: {},
  castsByType: {},
  buildingSurvivalTicks: 0,
  goldSpent: 0,
});

function buildCtx(): {
  ctx: AppCtx;
  getGameCall: () => { cb: GameSceneCallbacks; opts: GameSceneOptions } | null;
  goResultCalls: unknown[][];
} {
  let lastGame: { cb: GameSceneCallbacks; opts: GameSceneOptions } | null = null;
  const goResultCalls: unknown[][] = [];

  const views = {
    showGame: (cb: GameSceneCallbacks, opts: GameSceneOptions) => { lastGame = { cb, opts }; },
  } as unknown as AppViews;

  const nav: Partial<Nav> = {
    goResult: (...args: unknown[]): Promise<void> => { goResultCalls.push(args); return Promise.resolve(); },
    goLobby: () => {},
  };

  const ctx: AppCtx = {
    platform: { onGameplayStart: () => {}, onGameplayStop: () => {} } as unknown as AppCtx['platform'],
    views,
    api: undefined,
    baseUrl: null,
    saveManager: {
      get: () => ({ equipped: {}, pvp: { elo: 1300 } }),
      update: () => {},
    } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: { inLobby: true } as unknown as AppState,
    nav: nav as Nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };

  return { ctx, getGameCall: () => lastGame, goResultCalls };
}

describe('nav/game — PvE "fight again" re-enters a match instead of the lobby', () => {
  it('onGameEnd wires goResult with an onPlayAgain that starts a fresh practice match', () => {
    const { ctx, getGameCall, goResultCalls } = buildCtx();
    const { goGame } = createGameNav(ctx);

    goGame();
    const first = getGameCall();
    if (!first) throw new Error('views.showGame was not called by goGame()');

    // Simulate the match ending in a win for the local player.
    first.cb.onGameEnd(0, [zeroStats(0), zeroStats(1)], undefined);

    expect(goResultCalls.length).toBe(1);
    const args = goResultCalls[0]!;
    const onPlayAgain = args[7] as (() => void) | undefined;
    expect(typeof onPlayAgain).toBe('function');

    // Invoking the "fight again" callback must start a NEW match (views.showGame
    // called again), not fall through to the default "play again == goLobby".
    const before = getGameCall();
    onPlayAgain!();
    const after = getGameCall();
    expect(after).not.toBe(before);
    // Difficulty is re-rolled from the current ELO (AISystem range 1–10).
    expect(after!.opts.difficulty).toBeGreaterThanOrEqual(1);
    expect(after!.opts.difficulty).toBeLessThanOrEqual(10);
  });

  it('bot-fallback matches (queue-timeout, not a manual "fight again") still wire the same re-fight callback', () => {
    const { ctx, getGameCall, goResultCalls } = buildCtx();
    const { goGame } = createGameNav(ctx);

    goGame({ fromBotFallback: true, seed: 42 });
    const first = getGameCall();
    if (!first) throw new Error('views.showGame was not called by goGame()');

    first.cb.onGameEnd(1, [zeroStats(0), zeroStats(1)], undefined);

    const onPlayAgain = goResultCalls[0]![7] as (() => void) | undefined;
    expect(typeof onPlayAgain).toBe('function');
  });
});
