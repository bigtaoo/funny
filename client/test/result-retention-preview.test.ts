// The result screen's "come back tomorrow" check-in hook (RETENTION_LAUNCH_PLAN.md §3.3):
// nav/result.ts's getRetentionPreview, unit-tested against createResultNav directly (hand-built
// AppCtx, no PIXI/no real match/no network bootstrap) — same style as result-nav-onback.test.ts.
import { describe, it, expect } from 'vitest';
import { createResultNav } from '../src/app/nav/result';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews, ResultViewProps } from '../src/app/AppViews';
import type { PlayerStats } from '@nw/engine/types';

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

function buildCtx(opts: {
  claimedDays?: number[];
  online?: boolean;
}): { ctx: AppCtx; getResult: () => ResultViewProps | null } {
  let captured: ResultViewProps | null = null;
  const views = { showResult: (props: ResultViewProps) => { captured = props; } } as unknown as AppViews;

  // Current month, so nav/result.ts's makeMonthKey(Date.now()) matches this fixture.
  const monthKey = new Date().toISOString().slice(0, 7);
  const save = { retention: { checkin: { monthKey, claimedDays: opts.claimedDays ?? [] } } };
  const api = opts.online === false ? undefined : ({
    getRetention: async () => ({
      defs: { rewards: [{ kind: 'material', count: 3, id: 'scrap' }] },
    }),
  } as unknown as AppCtx['api']);

  const ctx: AppCtx = {
    platform: {
      onGameplayStop: () => {},
      showMidgameAd: () => Promise.resolve(),
    } as unknown as AppCtx['platform'],
    views,
    api,
    baseUrl: null,
    saveManager: { get: () => save } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: { inLobby: true } as unknown as AppState,
    nav: {} as Nav,
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

describe('nav/result — come back tomorrow check-in hook', () => {
  it('shows day 1\'s reward on a win when nothing has been claimed yet this month', async () => {
    const { ctx, getResult } = buildCtx({ claimedDays: [] });
    const { goResult } = createResultNav(ctx);

    await goResult(0, [zeroStats(0), zeroStats(1)]); // winner=0, localOwner defaults to 0 -> a win
    expect(getResult()?.retentionPreview).toEqual({ day: 1, reward: { kind: 'material', count: 3, id: 'scrap' } });
  });

  it('shows nothing once a check-in day has already been claimed this month', async () => {
    const { ctx, getResult } = buildCtx({ claimedDays: [1] });
    const { goResult } = createResultNav(ctx);

    await goResult(0, [zeroStats(0), zeroStats(1)]);
    expect(getResult()?.retentionPreview).toBeUndefined();
  });

  it('shows nothing on a loss, even with nothing claimed yet', async () => {
    const { ctx, getResult } = buildCtx({ claimedDays: [] });
    const { goResult } = createResultNav(ctx);

    await goResult(1, [zeroStats(0), zeroStats(1)]); // winner=1, localOwner defaults to 0 -> a loss
    expect(getResult()?.retentionPreview).toBeUndefined();
  });

  it('shows nothing on a draw', async () => {
    const { ctx, getResult } = buildCtx({ claimedDays: [] });
    const { goResult } = createResultNav(ctx);

    await goResult(null, [zeroStats(0), zeroStats(1)]);
    expect(getResult()?.retentionPreview).toBeUndefined();
  });

  it('shows nothing offline (no api) — never blocks the result screen itself', async () => {
    const { ctx, getResult } = buildCtx({ claimedDays: [], online: false });
    const { goResult } = createResultNav(ctx);

    await goResult(0, [zeroStats(0), zeroStats(1)]);
    const props = getResult();
    expect(props, 'the result screen must still render even without the hook').not.toBeNull();
    expect(props?.retentionPreview).toBeUndefined();
  });
});
