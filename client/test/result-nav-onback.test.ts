// Regression test for the ResultScene top-left "back to lobby" chip
// (design/game/UI_DESIGN.md §4.9.1, 2026-07-06): the back chip must always exit
// straight to the lobby, independent of what the primary "play again" CTA does —
// which, since the PvE "fight again" fix, may re-enter a match instead of
// returning to the lobby. For ranked matches (which close a live NetSession on
// exit), the back chip must reuse that teardown instead of a bare nav.goLobby(),
// or the session would leak.
//
// Unit-tests createResultNav directly (hand-built AppCtx, no PIXI/no real match) —
// see test/social-world-chat-playername.test.ts for the same style.
import { describe, it, expect } from 'vitest';
import { createResultNav } from '../src/app/nav/result';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews, ResultViewProps } from '../src/app/AppViews';
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

function buildCtx(nav: Partial<Nav>): { ctx: AppCtx; getResult: () => ResultViewProps | null } {
  let captured: ResultViewProps | null = null;

  const views = {
    showResult: (props: ResultViewProps) => { captured = props; },
  } as unknown as AppViews;

  const ctx: AppCtx = {
    platform: {
      onGameplayStop: () => {},
      showMidgameAd: () => Promise.resolve(),
    } as unknown as AppCtx['platform'],
    views,
    api: undefined,
    baseUrl: null,
    saveManager: {} as unknown as AppCtx['saveManager'],
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

  return { ctx, getResult: () => captured };
}

describe('nav/result — top-left back chip always exits to the lobby', () => {
  it('with no onPlayAgain/onReturnToLobby override, both onBack and onPlayAgain fall back to nav.goLobby()', async () => {
    let lobbyCalls = 0;
    const { ctx, getResult } = buildCtx({ goLobby: () => { lobbyCalls++; } });
    const { goResult } = createResultNav(ctx);

    await goResult(0, [zeroStats(0), zeroStats(1)]);
    const props = getResult();
    if (!props) throw new Error('views.showResult was not called');

    props.cb.onBack();
    expect(lobbyCalls).toBe(1);

    props.cb.onPlayAgain();
    expect(lobbyCalls).toBe(2);
  });

  it('when onPlayAgain re-enters a match (e.g. PvE "fight again"), onBack still goes to the lobby', async () => {
    let lobbyCalls = 0;
    let playAgainCalls = 0;
    const { ctx, getResult } = buildCtx({ goLobby: () => { lobbyCalls++; } });
    const { goResult } = createResultNav(ctx);

    await goResult(
      0, [zeroStats(0), zeroStats(1)], 0, undefined, undefined, undefined, undefined,
      () => { playAgainCalls++; }, // onPlayAgain override — does NOT return to lobby
    );
    const props = getResult();
    if (!props) throw new Error('views.showResult was not called');

    props.cb.onPlayAgain();
    expect(playAgainCalls).toBe(1);
    expect(lobbyCalls).toBe(0); // play again must not also touch the lobby

    props.cb.onBack();
    expect(lobbyCalls).toBe(1); // but back always does
  });

  it('ranked play: onBack reuses onReturnToLobby (session teardown) instead of a bare goLobby()', async () => {
    let lobbyCalls = 0;
    let returnToLobbyCalls = 0;
    let playAgainCalls = 0;
    const { ctx, getResult } = buildCtx({ goLobby: () => { lobbyCalls++; } });
    const { goResult } = createResultNav(ctx);

    await goResult(
      0, [zeroStats(0), zeroStats(1)], 0, undefined, undefined, undefined, undefined,
      () => { playAgainCalls++; },       // re-queue ranked
      undefined,
      () => { returnToLobbyCalls++; },   // close session then go to lobby
    );
    const props = getResult();
    if (!props) throw new Error('views.showResult was not called');

    props.cb.onBack();
    expect(returnToLobbyCalls).toBe(1);
    expect(lobbyCalls).toBe(0); // must not ALSO fall back to a plain goLobby (would skip session.close())

    props.cb.onPlayAgain();
    expect(playAgainCalls).toBe(1);
  });
});
