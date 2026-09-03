import { describe, it, expect, vi } from 'vitest';
import { BotSession } from '../src/bot';
import type { BotIdentity } from '../src/pool';
import * as battleSession from '../src/battleSession';

vi.mock('../src/battleSession', () => ({ playRankedMatch: vi.fn() }));

const identity: BotIdentity = { deviceId: 'bot-0001', paymentTier: 'free' };

// Stands in for the world client in the cases below that never reach a world call. `any` (like the
// sibling fake* helpers) rather than a full WorldClient stub: those cases assert on login/social/
// battle behaviour only, and a real stub would have to grow with every WorldClient method.
function fakeWorld(): any {
  return {};
}

function fakeMeta(): any {
  return { deviceLogin: vi.fn().mockResolvedValue({ token: 't', accountId: 'a1', isNew: false }) };
}
function fakeSocial(): any {
  return {
    myFamily: vi.fn().mockResolvedValue(null),
    searchFamilies: vi.fn().mockResolvedValue([]),
    joinFamily: vi.fn(),
    leaveFamily: vi.fn(),
  };
}
function fakeCommercial(): any {
  return { buyMonthlyCard: vi.fn(), buyStarterGrowth: vi.fn() };
}

/** A world fake complete enough to reach trySiege's own checks, so a case can knock out one piece. */
function siegeWorld(over: Record<string, unknown> = {}): any {
  return {
    getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
    joinSeason: vi.fn().mockResolvedValue({ joined: true, worldId: 's3-0' }),
    upgradeBuilding: vi.fn().mockResolvedValue(undefined),
    getWorldMe: vi.fn().mockResolvedValue({ joined: true, troops: 100, mainBaseTile: 's3-0:5:5' }),
    baseCoords: vi.fn().mockReturnValue({ x: 5, y: 5 }),
    getWorldMapSparse: vi.fn().mockResolvedValue({ tiles: [] }),
    pickAttackTarget: vi.fn().mockReturnValue(null),
    startMarchAttack: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const battleOpts = { gatewayWsUrl: 'ws://unused/gw', chancePerTick: 0 };

async function loggedInSession(world: any): Promise<BotSession> {
  const session = new BotSession(identity, fakeMeta(), fakeSocial(), fakeCommercial(), world, battleOpts);
  await session.login();
  return session;
}

describe('BotSession.tickSlg', () => {
  it('joins the active season world on first tick, then upgrades a building', async () => {
    const world: any = {
      getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
      joinSeason: vi.fn().mockResolvedValue({ joined: true, worldId: 's3-0', troops: 100, mainBaseTile: 's3-0:5:5' }),
      upgradeBuilding: vi.fn().mockResolvedValue(undefined),
    };
    const session = await loggedInSession(world);

    await session.tickSlg();

    expect(world.joinSeason).toHaveBeenCalledWith('t', 3);
    expect(world.upgradeBuilding).toHaveBeenCalledWith('t', 's3-0', 'desk');
  });

  it('only resolves the world once — later ticks reuse the cached worldId', async () => {
    const world: any = {
      getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
      joinSeason: vi.fn().mockResolvedValue({ joined: true, worldId: 's3-0' }),
      upgradeBuilding: vi.fn().mockResolvedValue(undefined),
    };
    const session = await loggedInSession(world);

    await session.tickSlg();
    await session.tickSlg();

    expect(world.joinSeason).toHaveBeenCalledTimes(1);
  });

  it('rotates through P1 building keys across ticks instead of repeating one', async () => {
    const world: any = {
      getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
      joinSeason: vi.fn().mockResolvedValue({ joined: true, worldId: 's3-0' }),
      upgradeBuilding: vi.fn().mockResolvedValue(undefined),
    };
    const session = await loggedInSession(world);

    await session.tickSlg();
    await session.tickSlg();

    const keys = world.upgradeBuilding.mock.calls.map((c: unknown[]) => c[2]);
    expect(keys).toEqual(['desk', 'inkPot']);
  });

  it('on the siege-interval tick, marches on a found target instead of upgrading', async () => {
    const world: any = {
      getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
      joinSeason: vi.fn().mockResolvedValue({ joined: true, worldId: 's3-0' }),
      upgradeBuilding: vi.fn().mockResolvedValue(undefined),
      getWorldMe: vi.fn().mockResolvedValue({ joined: true, troops: 100, mainBaseTile: 's3-0:5:5' }),
      baseCoords: vi.fn().mockReturnValue({ x: 5, y: 5 }),
      getWorldMapSparse: vi.fn().mockResolvedValue({ tiles: [{ x: 6, y: 6, type: 'territory', mine: false }] }),
      pickAttackTarget: vi.fn().mockReturnValue({ x: 6, y: 6 }),
      startMarchAttack: vi.fn().mockResolvedValue(undefined),
    };
    const session = await loggedInSession(world);

    for (let i = 0; i < 4; i++) await session.tickSlg(); // ticks 1-4: plain upgrades
    world.upgradeBuilding.mockClear();
    await session.tickSlg(); // tick 5: siege interval

    expect(world.startMarchAttack).toHaveBeenCalledWith('t', 's3-0', { x: 5, y: 5 }, { x: 6, y: 6 }, 30);
    expect(world.upgradeBuilding).not.toHaveBeenCalled();
  });

  it('falls back to upgrading when the siege-interval tick finds no target', async () => {
    const world: any = {
      getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
      joinSeason: vi.fn().mockResolvedValue({ joined: true, worldId: 's3-0' }),
      upgradeBuilding: vi.fn().mockResolvedValue(undefined),
      getWorldMe: vi.fn().mockResolvedValue({ joined: true, troops: 100, mainBaseTile: 's3-0:5:5' }),
      baseCoords: vi.fn().mockReturnValue({ x: 5, y: 5 }),
      getWorldMapSparse: vi.fn().mockResolvedValue({ tiles: [] }),
      pickAttackTarget: vi.fn().mockReturnValue(null),
      startMarchAttack: vi.fn(),
    };
    const session = await loggedInSession(world);

    for (let i = 0; i < 4; i++) await session.tickSlg();
    world.upgradeBuilding.mockClear();
    await session.tickSlg();

    expect(world.startMarchAttack).not.toHaveBeenCalled();
    expect(world.upgradeBuilding).toHaveBeenCalledTimes(1);
  });

  it('does nothing before login (no token yet)', async () => {
    const world: any = { getActiveSeason: vi.fn(), joinSeason: vi.fn() };
    const session = new BotSession(identity, fakeMeta(), fakeSocial(), fakeCommercial(), world, battleOpts);

    await session.tickSlg();

    expect(world.getActiveSeason).not.toHaveBeenCalled();
  });
});

describe('BotSession.tickBattle', () => {
  const world: any = {};

  it('does nothing when not lobby_idle, not logged in, or the roll misses', async () => {
    const offline = new BotSession(identity, fakeMeta(), fakeSocial(), fakeCommercial(), world, battleOpts);
    offline.tickBattle(); // not logged in
    expect(offline.state).toBe('offline');

    const idleButUnlucky = new BotSession(identity, fakeMeta(), fakeSocial(), fakeCommercial(), world, {
      gatewayWsUrl: 'ws://unused/gw',
      chancePerTick: 0, // Math.random() >= 0 is always true -> never rolls in
    });
    await idleButUnlucky.login();
    idleButUnlucky.tickBattle();
    expect(idleButUnlucky.state).toBe('lobby_idle');
    expect(battleSession.playRankedMatch).not.toHaveBeenCalled();
  });

  it('on a hit, transitions lobby_idle -> matchmaking -> in_battle -> lobby_idle and calls playRankedMatch with the bot deck/difficulty', async () => {
    let resolveMatch!: (v: { won: boolean | null; stateHash: string }) => void;
    (battleSession.playRankedMatch as any).mockImplementation(
      (opts: any) =>
        new Promise((resolve) => {
          resolveMatch = resolve;
          opts.onMatched?.();
        }),
    );

    const session = new BotSession(identity, fakeMeta(), fakeSocial(), fakeCommercial(), world, {
      gatewayWsUrl: 'ws://unused/gw',
      chancePerTick: 1, // always rolls in
    });
    await session.login();

    session.tickBattle();
    expect(session.state).toBe('in_battle'); // onMatched fired synchronously in this mock
    expect(battleSession.playRankedMatch).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayWsUrl: 'ws://unused/gw', jwt: 't', deck: [], difficulty: 5 }),
    );

    // A second roll mid-battle must not start a concurrent match.
    session.tickBattle();
    expect(battleSession.playRankedMatch).toHaveBeenCalledTimes(1);

    resolveMatch({ won: true, stateHash: 'abc' });
    await new Promise((r) => setTimeout(r, 0));
    expect(session.state).toBe('lobby_idle');
  });

  it('falls back to lobby_idle when the match rejects (disconnect/timeout/matchmaking failure)', async () => {
    (battleSession.playRankedMatch as any).mockRejectedValue(new Error('gateway unreachable'));

    const session = new BotSession(identity, fakeMeta(), fakeSocial(), fakeCommercial(), world, {
      gatewayWsUrl: 'ws://unused/gw',
      chancePerTick: 1,
    });
    await session.login();

    session.tickBattle();
    await new Promise((r) => setTimeout(r, 0));
    expect(session.state).toBe('lobby_idle');
  });
});

describe('BotSession.login / logout', () => {
  // Regression for the 2026-08-04 fix: a failed deviceLogin used to leave state stuck at 'logging_in'
  // forever — the scheduler's spawnUpTo only re-selects sessions with state==='offline' to retry, and a
  // stuck 'logging_in' session also passed spawnUpTo's `state !== 'offline'` check straight into the
  // online set despite having no token, permanently occupying a fleet slot that never does anything.
  it('login() failure resets state to offline (and rethrows) instead of sticking at logging_in', async () => {
    const meta: any = { deviceLogin: vi.fn().mockRejectedValue(new Error('meta unreachable')) };
    const session = new BotSession(identity, meta, fakeSocial(), fakeCommercial(), fakeWorld(), battleOpts);

    await expect(session.login()).rejects.toThrow('meta unreachable');
    expect(session.state).toBe('offline');

    // A subsequent login (as spawnUpTo would retry, since state is back to 'offline') can still succeed.
    meta.deviceLogin.mockResolvedValueOnce({ token: 't2', accountId: 'a2', isNew: false });
    await session.login();
    expect(session.state).toBe('lobby_idle');
  });

  // Regression for the 2026-08-04 fix: logout() used to just clear local state while an in-flight battle
  // (runBattle -> playRankedMatch) kept running to completion in the background, holding a live gateway/
  // gameserver WS connection open for an account the fleet no longer tracked as online — defeating
  // load-shedding (despawnDownTo) entirely.
  it('logout() aborts an in-flight battle instead of letting it run to completion', async () => {
    let capturedSignal: AbortSignal | undefined;
    (battleSession.playRankedMatch as any).mockImplementation(
      (opts: any) =>
        new Promise((_resolve, reject) => {
          capturedSignal = opts.abortSignal;
          opts.abortSignal?.addEventListener('abort', () => reject(new Error('match aborted: bot logged out')));
          opts.onMatched?.();
        }),
    );

    const session = new BotSession(identity, fakeMeta(), fakeSocial(), fakeCommercial(), fakeWorld(), {
      gatewayWsUrl: 'ws://unused/gw',
      chancePerTick: 1,
    });
    await session.login();
    session.tickBattle();
    expect(session.state).toBe('in_battle');
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    session.logout();

    expect(capturedSignal!.aborted).toBe(true);
    expect(session.state).toBe('offline');
    await new Promise((r) => setTimeout(r, 0));
    expect(session.state).toBe('offline'); // the aborted battle's .finally() must not resurrect lobby_idle
  });
});

describe('BotSession.tickFamily', () => {
  it('no token (not logged in) -> no-op, no social calls', async () => {
    const social = fakeSocial();
    const session = new BotSession(identity, fakeMeta(), social, fakeCommercial(), fakeWorld(), battleOpts);
    await session.tickFamily();
    expect(social.myFamily).not.toHaveBeenCalled();
  });

  it('familyless -> searches, joins the first candidate found', async () => {
    const social = fakeSocial();
    social.searchFamilies.mockResolvedValue([{ familyId: 'f1', tag: 'ABC', memberCount: 5, prosperity: 50 }]);
    const session = new BotSession(identity, fakeMeta(), social, fakeCommercial(), fakeWorld(), battleOpts);
    await session.login();

    await session.tickFamily();

    expect(social.searchFamilies).toHaveBeenCalledWith('t', '');
    expect(social.joinFamily).toHaveBeenCalledWith('t', 'ABC');
    expect(social.leaveFamily).not.toHaveBeenCalled();
  });

  it('familyless with no candidates found -> searches but joins nothing', async () => {
    const social = fakeSocial(); // searchFamilies defaults to []
    const session = new BotSession(identity, fakeMeta(), social, fakeCommercial(), fakeWorld(), battleOpts);
    await session.login();

    await session.tickFamily();

    expect(social.joinFamily).not.toHaveBeenCalled();
  });

  it('already in a healthy (high-prosperity) family -> no-op, no leave/search', async () => {
    const social = fakeSocial();
    social.myFamily.mockResolvedValue({ familyId: 'f1', tag: 'ABC', memberCount: 5, prosperity: 50 });
    const session = new BotSession(identity, fakeMeta(), social, fakeCommercial(), fakeWorld(), battleOpts);
    await session.login();

    await session.tickFamily();

    expect(social.searchFamilies).not.toHaveBeenCalled();
    expect(social.leaveFamily).not.toHaveBeenCalled();
  });

  it('in a low-prosperity ("dead") family -> leaves it (a later tick re-searches once familyless)', async () => {
    const social = fakeSocial();
    social.myFamily.mockResolvedValue({ familyId: 'f1', tag: 'ABC', memberCount: 1, prosperity: 5 });
    const session = new BotSession(identity, fakeMeta(), social, fakeCommercial(), fakeWorld(), battleOpts);
    await session.login();

    await session.tickFamily();

    expect(social.leaveFamily).toHaveBeenCalledWith('t');
    expect(social.searchFamilies).not.toHaveBeenCalled(); // same tick doesn't also re-search
  });
});

describe('BotSession payment-tier bootstrap (on login)', () => {
  it('free tier: no commercial call at all', async () => {
    const commercial = fakeCommercial();
    const session = new BotSession({ deviceId: 'bot-0001', paymentTier: 'free' }, fakeMeta(), fakeSocial(), commercial, fakeWorld(), battleOpts);
    await session.login();
    expect(commercial.buyMonthlyCard).not.toHaveBeenCalled();
    expect(commercial.buyStarterGrowth).not.toHaveBeenCalled();
  });

  it('monthly_card tier: buys the monthly card with a deterministic per-account orderId', async () => {
    const commercial = fakeCommercial();
    const session = new BotSession({ deviceId: 'bot-0002', paymentTier: 'monthly_card' }, fakeMeta(), fakeSocial(), commercial, fakeWorld(), battleOpts);
    await session.login();
    expect(commercial.buyMonthlyCard).toHaveBeenCalledWith('a1', 'bot-bot-0002-monthly_card');
    expect(commercial.buyStarterGrowth).not.toHaveBeenCalled();
  });

  it('starter_growth tier: buys the starter-growth pack', async () => {
    const commercial = fakeCommercial();
    const session = new BotSession({ deviceId: 'bot-0003', paymentTier: 'starter_growth' }, fakeMeta(), fakeSocial(), commercial, fakeWorld(), battleOpts);
    await session.login();
    expect(commercial.buyStarterGrowth).toHaveBeenCalledWith('a1', 'bot-bot-0003-starter_growth');
    expect(commercial.buyMonthlyCard).not.toHaveBeenCalled();
  });

  it('a failed purchase does not keep the bot offline, and is retried on the next login', async () => {
    const commercial = fakeCommercial();
    commercial.buyMonthlyCard.mockRejectedValueOnce(new Error('commercial unreachable'));
    const session = new BotSession({ deviceId: 'bot-0004', paymentTier: 'monthly_card' }, fakeMeta(), fakeSocial(), commercial, fakeWorld(), battleOpts);

    await session.login();
    expect(session.state).toBe('lobby_idle'); // login still succeeds despite the purchase failure

    session.logout();
    await session.login();
    expect(commercial.buyMonthlyCard).toHaveBeenCalledTimes(2); // retried, not permanently given up on
  });

  it('a successful purchase is not repeated on a later re-login (idempotent bootstrap)', async () => {
    const commercial = fakeCommercial();
    const session = new BotSession({ deviceId: 'bot-0005', paymentTier: 'monthly_card' }, fakeMeta(), fakeSocial(), commercial, fakeWorld(), battleOpts);

    await session.login();
    session.logout();
    await session.login();

    expect(commercial.buyMonthlyCard).toHaveBeenCalledTimes(1);
  });
});

describe('BotSession.tickSlg — incomplete backend state', () => {
  it('retries the season join on the next tick when the join comes back without a worldId', async () => {
    // A season boundary (or a worldsvc that accepted the request but has no shard for this account
    // yet) answers `joined` with no worldId. Caching that as the world would send every later tick's
    // build/march to `worldId=undefined`, so the tick has to bail and re-join instead.
    const world: any = {
      getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
      joinSeason: vi.fn().mockResolvedValue({ joined: false }),
      upgradeBuilding: vi.fn().mockResolvedValue(undefined),
    };
    const session = await loggedInSession(world);

    await session.tickSlg();
    await session.tickSlg();

    expect(world.joinSeason).toHaveBeenCalledTimes(2); // nothing was cached, so it tried again
    expect(world.upgradeBuilding).not.toHaveBeenCalled();
  });

  it('skips the siege and upgrades instead when the bot has no base tile yet', async () => {
    const world = siegeWorld({ getWorldMe: vi.fn().mockResolvedValue({ joined: true, troops: 100 }) });
    world.baseCoords = vi.fn().mockReturnValue(null); // no mainBaseTile -> no march origin
    const session = await loggedInSession(world);

    for (let i = 0; i < 4; i++) await session.tickSlg();
    world.upgradeBuilding.mockClear();
    await session.tickSlg();

    expect(world.getWorldMapSparse).not.toHaveBeenCalled(); // bailed before the map scan
    expect(world.startMarchAttack).not.toHaveBeenCalled();
    expect(world.upgradeBuilding).toHaveBeenCalledTimes(1);
  });

  it('skips the siege and upgrades instead when the garrison is empty', async () => {
    // Marching 0 troops is a request worldsvc would reject anyway; more to the point the bot has just
    // been wiped, and spending the tick rebuilding is what a real player does.
    const world = siegeWorld({ getWorldMe: vi.fn().mockResolvedValue({ joined: true, troops: 0, mainBaseTile: 's3-0:5:5' }) });
    const session = await loggedInSession(world);

    for (let i = 0; i < 4; i++) await session.tickSlg();
    world.upgradeBuilding.mockClear();
    await session.tickSlg();

    expect(world.getWorldMapSparse).not.toHaveBeenCalled();
    expect(world.startMarchAttack).not.toHaveBeenCalled();
    expect(world.upgradeBuilding).toHaveBeenCalledTimes(1);
  });

  it('a logout that lands mid-tick stops the rest of the tick from spending a dead token', async () => {
    // The only window where the private guards in upgradeNextBuilding/trySiege can actually fire:
    // logout() clears the token while a world call is already in flight, so the checks at the top of
    // tickSlg passed but the ones further down no longer do. Without them the tick would keep going
    // and issue a POST /world/build/upgrade with a token the fleet has already given up — a real
    // 401 against a real backend, blamed on an account nothing is tracking as online any more.
    const holder: { session?: BotSession } = {};
    const world = siegeWorld({
      getWorldMe: vi.fn(async () => {
        holder.session!.logout();
        return { joined: true, troops: 0, mainBaseTile: 's3-0:5:5' };
      }),
    });
    const session = await loggedInSession(world);
    holder.session = session;

    for (let i = 0; i < 4; i++) await session.tickSlg();
    world.upgradeBuilding.mockClear();
    await session.tickSlg(); // siege-interval tick: getWorldMe logs out mid-flight

    expect(world.startMarchAttack).not.toHaveBeenCalled();
    expect(world.upgradeBuilding).not.toHaveBeenCalled(); // the fallback upgrade is skipped too
    expect(session.state).toBe('offline');
  });
});

describe('BotSession payment-tier bootstrap — no accountId', () => {
  it('skips the purchase when device-login returned a token but no accountId', async () => {
    // commercial's endpoints are keyed by accountId; sending `undefined` would either 400 or, worse,
    // land on some other account's wallet. Login itself still has to succeed — the bot can play.
    const meta: any = { deviceLogin: vi.fn().mockResolvedValue({ token: 't', isNew: false }) };
    const commercial = fakeCommercial();
    const session = new BotSession(
      { deviceId: 'bot-0006', paymentTier: 'monthly_card' },
      meta,
      fakeSocial(),
      commercial,
      fakeWorld(),
      battleOpts,
    );

    await session.login();

    expect(session.state).toBe('lobby_idle');
    expect(commercial.buyMonthlyCard).not.toHaveBeenCalled();
    expect(commercial.buyStarterGrowth).not.toHaveBeenCalled();
  });
});
