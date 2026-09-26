import { describe, it, expect, vi, afterEach } from 'vitest';
import { FAMILY_CAP, SECT_CREATE_COST, SECT_FAMILY_CAP, buildCost } from '@nw/shared';
import { BotSession } from '../src/bot';
import { BotApiError } from '../src/apiError';
import { BOT_FAMILY_ROSTER, BOT_SECT_ROSTER, BotOrgRegistry } from '../src/orgs';
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
    getFamily: vi.fn().mockResolvedValue(null),
    createFamily: vi.fn().mockImplementation(async (_t: string, name: string, tag: string) => ({
      familyId: `fam:${tag}`, name, tag, leaderId: 'a1', memberCount: 1, prosperity: 0,
    })),
    requestJoin: vi.fn().mockResolvedValue({ requestId: 'r' }),
    listJoinRequests: vi.fn().mockResolvedValue([]),
    respondJoinRequest: vi.fn().mockResolvedValue(undefined),
    setRole: vi.fn().mockResolvedValue(undefined),
  };
}
function fakeCommercial(): any {
  return { buyMonthlyCard: vi.fn(), buyStarterGrowth: vi.fn(), grantCoins: vi.fn().mockResolvedValue(undefined) };
}

/** A world fake complete enough to reach trySiege's own checks, so a case can knock out one piece. */
function siegeWorld(over: Record<string, unknown> = {}): any {
  return {
    getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
    joinSeason: vi.fn().mockImplementation(async () => solventMe({ worldId: 's3-0' })),
    upgradeBuilding: vi.fn().mockImplementation(async () => solventMe()),
    getWorldMe: vi.fn().mockImplementation(async () => solventMe()),
    baseCoords: vi.fn().mockReturnValue({ x: 5, y: 5 }),
    getWorldMapSparse: vi.fn().mockResolvedValue({ tiles: [] }),
    pickAttackTarget: vi.fn().mockReturnValue(null),
    startMarchAttack: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const battleOpts = { gatewayWsUrl: 'ws://unused/gw', chancePerTick: 0 };

/** Drive ticks back to back without waiting out DEFAULT_SLG_INTERVAL_MS; pacing has its own cases below. */
const unpacedSlg = { intervalMs: 0 };

/**
 * A `/world/me` for a bot that can pay for anything.
 *
 * Every upgrade case needs this now: tickSlg only posts an upgrade it believes will succeed, so a
 * fake whose player owns nothing produces zero upgrade calls — which is precisely the live behaviour
 * (a one-resource base can never afford a building) that the pre-2026-09-17 fakes hid by never
 * modelling resources at all, while the assertions only ever checked that the REQUEST went out.
 */
function solventMe(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    joined: true,
    troops: 100,
    mainBaseTile: 's3-0:5:5',
    buildings: { desk: 1 },
    buildQueue: [],
    resources: { ink: 1e9, paper: 1e9, graphite: 1e9, metal: 1e9, sticker: 1e9 },
    ...over,
  };
}

async function loggedInSession(world: any): Promise<BotSession> {
  const session = new BotSession(identity, fakeMeta(), fakeSocial(), fakeCommercial(), world, battleOpts, unpacedSlg);
  await session.login();
  return session;
}

describe('BotSession.tickSlg', () => {
  it('joins the active season world on first tick, then upgrades a building', async () => {
    const world: any = {
      getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
      joinSeason: vi.fn().mockImplementation(async () => solventMe({ worldId: 's3-0' })),
      upgradeBuilding: vi.fn().mockImplementation(async () => solventMe()),
    };
    const session = await loggedInSession(world);

    await session.tickSlg();

    expect(world.joinSeason).toHaveBeenCalledWith('t', 3);
    expect(world.upgradeBuilding).toHaveBeenCalledWith('t', 's3-0', 'desk');
  });

  it('only resolves the world once — later ticks reuse the cached worldId', async () => {
    const world: any = {
      getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
      joinSeason: vi.fn().mockImplementation(async () => solventMe({ worldId: 's3-0' })),
      upgradeBuilding: vi.fn().mockImplementation(async () => solventMe()),
    };
    const session = await loggedInSession(world);

    await session.tickSlg();
    await session.tickSlg();

    expect(world.joinSeason).toHaveBeenCalledTimes(1);
  });

  it('rotates through P1 building keys across ticks instead of repeating one', async () => {
    const world: any = {
      getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
      joinSeason: vi.fn().mockImplementation(async () => solventMe({ worldId: 's3-0' })),
      upgradeBuilding: vi.fn().mockImplementation(async () => solventMe()),
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
      joinSeason: vi.fn().mockImplementation(async () => solventMe({ worldId: 's3-0' })),
      upgradeBuilding: vi.fn().mockImplementation(async () => solventMe()),
      getWorldMe: vi.fn().mockImplementation(async () => solventMe()),
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
      joinSeason: vi.fn().mockImplementation(async () => solventMe({ worldId: 's3-0' })),
      upgradeBuilding: vi.fn().mockImplementation(async () => solventMe()),
      getWorldMe: vi.fn().mockImplementation(async () => solventMe()),
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

  // ── Affordability gate + pacing (2026-09-17) ────────────────────────────────────────────────────
  // The regression these pin is not a crash, it is 629,382 consecutive rejected upgrades in 29 hours
  // on live s2-0 — 64% of worldsvc's whole request volume, spent on a call that could never succeed.
  // Note what the pre-existing cases above could NOT have caught: they asserted that the request went
  // out, and their fakes had no resources at all, so "always rejected" and "working" looked identical.

  it('never posts an upgrade a one-resource bot cannot pay for (the live bot shape)', async () => {
    // A bot's base footprint covers exactly one resource tile, so it yields exactly one resource, and
    // `ink` is a pure troop-sustain resource that NO entry in BUILD_COST_BASE charges (city.ts design
    // rule). However rich in ink it gets, nothing is ever buyable.
    const inkOnly = solventMe({ resources: { ink: 1e9, paper: 0, graphite: 0, metal: 0, sticker: 0 } });
    const world = siegeWorld({ getWorldMe: vi.fn().mockImplementation(async () => inkOnly) });
    world.joinSeason = vi.fn().mockImplementation(async () => ({ ...inkOnly, worldId: 's3-0' }));
    const session = await loggedInSession(world);

    for (let i = 0; i < 12; i++) await session.tickSlg();

    expect(world.upgradeBuilding).not.toHaveBeenCalled();
  });

  it('picks a key it can afford over the next one in the rotation', async () => {
    // paperTray is the only building a graphite-only balance can buy (`{ graphite: 1600 }`); the
    // rotation would otherwise open on `desk`, which also wants paper and sticker.
    const graphiteOnly = solventMe({
      resources: { ink: 0, paper: 0, graphite: (buildCost('paperTray', 1).graphite ?? 0) * 2, metal: 0, sticker: 0 },
    });
    const world = siegeWorld({ getWorldMe: vi.fn().mockImplementation(async () => graphiteOnly) });
    world.joinSeason = vi.fn().mockImplementation(async () => ({ ...graphiteOnly, worldId: 's3-0' }));
    const session = await loggedInSession(world);

    await session.tickSlg();

    expect(world.upgradeBuilding).toHaveBeenCalledWith('t', 's3-0', 'paperTray');
  });

  it('respects a full build queue, which worldsvc would reject outright', async () => {
    const queued = solventMe({ buildQueue: [{ key: 'desk', toLevel: 2, startAt: 0, completeAt: 1 }] });
    const world = siegeWorld({ getWorldMe: vi.fn().mockImplementation(async () => queued) });
    world.joinSeason = vi.fn().mockImplementation(async () => ({ ...queued, worldId: 's3-0' }));
    const session = await loggedInSession(world);

    await session.tickSlg();

    expect(world.upgradeBuilding).not.toHaveBeenCalled();
  });

  it('acts once per interval however often the scheduler hands it a pass', async () => {
    const world = siegeWorld();
    const session = new BotSession(
      identity, fakeMeta(), fakeSocial(), fakeCommercial(), world, battleOpts, { intervalMs: 60_000 },
    );
    await session.login();

    for (let i = 0; i < 5; i++) await session.tickSlg();

    expect(world.upgradeBuilding).toHaveBeenCalledTimes(1);
  });

  it('costs no extra round trip: the affordability snapshot rides on the siege tick /world/me', async () => {
    // This is a COST assertion, not a behaviour one — deciding affordability client-side is only a win
    // if the decision is not itself paid for with the request it saves. Over 10 ticks the bot may call
    // `/world/me` only on the two siege-interval ticks (SIEGE_TICK_INTERVAL = 5), same as before.
    const world = siegeWorld();
    const session = await loggedInSession(world);

    for (let i = 0; i < 10; i++) await session.tickSlg();

    expect(world.getWorldMe).toHaveBeenCalledTimes(2);
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
  const MIN = 60_000;
  /** A family as socialsvc returns it; `slot` picks the roster name+TAG so it counts as a bot family. */
  function fam(slot: number, over: Record<string, unknown> = {}): Record<string, unknown> {
    const { name, tag } = BOT_FAMILY_ROSTER[slot]!;
    return { familyId: `fam:${tag}`, name, tag, leaderId: 'lead', memberCount: 5, prosperity: 0, ...over };
  }
  /** getFamily answering from a slot → family map; unknown ids are "not founded yet". */
  function roster(bySlot: Record<number, Record<string, unknown>>): (t: string, id: string) => Promise<unknown> {
    return async (_t, id) => Object.values(bySlot).find((f) => f.familyId === id) ?? null;
  }
  async function session(
    social: any,
    opts: { orgs?: BotOrgRegistry; commercial?: any; world?: any; id?: BotIdentity } = {},
  ): Promise<BotSession> {
    const s = new BotSession(
      opts.id ?? identity, fakeMeta(), social, opts.commercial ?? fakeCommercial(), opts.world ?? fakeWorld(),
      battleOpts, unpacedSlg, opts.orgs ?? new BotOrgRegistry(),
    );
    await s.login();
    return s;
  }
  /** Leader view of `slot`: the bot itself (a1, from fakeMeta) leads, plus the given extra members. */
  function led(slot: number, members: Array<Record<string, unknown>> = [], over: Record<string, unknown> = {}) {
    return fam(slot, { leaderId: 'a1', members: [{ accountId: 'a1', role: 'leader', joinedAt: 0 }, ...members], ...over });
  }
  const bot2: BotIdentity = { deviceId: 'bot-0002', paymentTier: 'free' };

  afterEach(() => { vi.useRealTimers(); });

  it('no token (not logged in) -> no-op, no social calls', async () => {
    const social = fakeSocial();
    const s = new BotSession(identity, fakeMeta(), social, fakeCommercial(), fakeWorld(), battleOpts);
    await s.tickFamily();
    expect(social.myFamily).not.toHaveBeenCalled();
  });

  it('familyless and no bot family exists yet -> founds roster slot 0', async () => {
    const social = fakeSocial();
    await (await session(social)).tickFamily();
    expect(social.getFamily).toHaveBeenCalledWith('t', `fam:${BOT_FAMILY_ROSTER[0]!.tag}`);
    expect(social.createFamily).toHaveBeenCalledWith('t', BOT_FAMILY_ROSTER[0]!.name, BOT_FAMILY_ROSTER[0]!.tag);
    expect(social.requestJoin).not.toHaveBeenCalled();
  });

  it('applies (by family id) to the first bot family with a free seat, skipping full ones', async () => {
    const social = fakeSocial();
    social.getFamily.mockImplementation(roster({ 0: fam(0, { memberCount: FAMILY_CAP }), 1: fam(1) }));
    await (await session(social)).tickFamily();
    expect(social.requestJoin).toHaveBeenCalledWith('t', `fam:${BOT_FAMILY_ROSTER[1]!.tag}`);
    expect(social.createFamily).not.toHaveBeenCalled();
  });

  it('a human family that happens to hold a roster TAG is skipped, not joined', async () => {
    const social = fakeSocial();
    social.getFamily.mockImplementation(roster({ 0: fam(0, { name: 'Someone Else' }), 1: fam(1) }));
    await (await session(social)).tickFamily();
    expect(social.requestJoin).toHaveBeenCalledWith('t', `fam:${BOT_FAMILY_ROSTER[1]!.tag}`);
  });

  it('does not re-apply while its application is pending, then looks again after the recheck window', async () => {
    vi.useFakeTimers({ now: 1e12 });
    const social = fakeSocial();
    social.getFamily.mockImplementation(roster({ 0: fam(0) }));
    const s = await session(social);
    await s.tickFamily();
    vi.setSystemTime(1e12 + 5 * MIN);
    await s.tickFamily();
    expect(social.requestJoin).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1e12 + 11 * MIN);
    await s.tickFamily();
    expect(social.requestJoin).toHaveBeenCalledTimes(2);
  });

  it('ALREADY_REQUESTED (a pending request from before a restart) is waited on, not counted as a failure', async () => {
    const social = fakeSocial();
    social.getFamily.mockImplementation(roster({ 0: fam(0) }));
    social.requestJoin.mockRejectedValue(new BotApiError('ALREADY_REQUESTED', 'x'));
    await expect((await session(social)).tickFamily()).resolves.toBeUndefined();
  });

  it('FAMILY_FULL on apply is an expected race: no throw, and the slot is re-read next time', async () => {
    vi.useFakeTimers({ now: 1e12 });
    const social = fakeSocial();
    social.getFamily.mockImplementation(roster({ 0: fam(0) }));
    social.requestJoin.mockRejectedValueOnce(new BotApiError('FAMILY_FULL', 'x'));
    const s = await session(social);
    await expect(s.tickFamily()).resolves.toBeUndefined();
    vi.setSystemTime(1e12 + MIN);
    await s.tickFamily();
    expect(social.getFamily).toHaveBeenCalledTimes(2); // cache dropped, not served stale
    expect(social.requestJoin).toHaveBeenCalledTimes(2); // and no pending backoff was set
  });

  it('with a shared registry, two familyless bots do not both found the same slot', async () => {
    const orgs = new BotOrgRegistry();
    const a = fakeSocial();
    const b = fakeSocial();
    await (await session(a, { orgs })).tickFamily();
    await (await session(b, { orgs, id: bot2 })).tickFamily();
    expect(a.createFamily).toHaveBeenCalledTimes(1);
    expect(b.createFamily).not.toHaveBeenCalled();
  });

  it("seats held by this process's own pending applications count toward full", async () => {
    const orgs = new BotOrgRegistry();
    const families = roster({ 0: fam(0, { memberCount: FAMILY_CAP - 1 }) });
    const a = fakeSocial();
    const b = fakeSocial();
    a.getFamily.mockImplementation(families);
    b.getFamily.mockImplementation(families);
    await (await session(a, { orgs })).tickFamily();
    await (await session(b, { orgs, id: bot2 })).tickFamily();
    expect(a.requestJoin).toHaveBeenCalledWith('t', `fam:${BOT_FAMILY_ROSTER[0]!.tag}`);
    expect(b.requestJoin).not.toHaveBeenCalled();
    expect(b.createFamily).toHaveBeenCalledWith('t', BOT_FAMILY_ROSTER[1]!.name, BOT_FAMILY_ROSTER[1]!.tag);
  });

  it('plain member -> nothing to do, and it waits 10 minutes before looking again', async () => {
    vi.useFakeTimers({ now: 1e12 });
    const social = fakeSocial();
    social.myFamily.mockResolvedValue(fam(0, { members: [{ accountId: 'a1', role: 'member', joinedAt: 0 }] }));
    const s = await session(social);
    await s.tickFamily();
    vi.setSystemTime(1e12 + 9 * MIN);
    await s.tickFamily();
    expect(social.myFamily).toHaveBeenCalledTimes(1);
    expect(social.listJoinRequests).not.toHaveBeenCalled();
    expect(social.getFamily).not.toHaveBeenCalled();
  });

  it('officer accepts applications; once the family is full the rest are rejected, not left pending', async () => {
    const social = fakeSocial();
    social.myFamily.mockResolvedValue(fam(3, { members: [{ accountId: 'a1', role: 'elder', joinedAt: 0 }] }));
    social.listJoinRequests.mockResolvedValue([
      { requestId: 'r1', accountId: 'x1', createdAt: 1 },
      { requestId: 'r2', accountId: 'x2', createdAt: 2 },
      { requestId: 'r3', accountId: 'x3', createdAt: 3 },
    ]);
    social.respondJoinRequest.mockImplementation(async (_t: string, id: string, accept: boolean) => {
      if (id === 'r2' && accept) throw new BotApiError('FAMILY_FULL', 'full');
    });
    await (await session(social)).tickFamily();
    expect(social.respondJoinRequest.mock.calls.map((c: unknown[]) => [c[1], c[2]])).toEqual([
      ['r1', true],
      ['r2', true],
      ['r3', false],
    ]);
    expect(social.setRole).not.toHaveBeenCalled(); // elders don't appoint elders
  });

  it('leader appoints the longest-serving plain member as elder, one per tick, up to two', async () => {
    const social = fakeSocial();
    social.myFamily.mockResolvedValue(led(3, [
      { accountId: 'late', role: 'member', joinedAt: 20 },
      { accountId: 'early', role: 'member', joinedAt: 10 },
    ]));
    await (await session(social)).tickFamily();
    expect(social.setRole).toHaveBeenCalledTimes(1);
    expect(social.setRole).toHaveBeenCalledWith('t', 'early', 'elder');

    const full = fakeSocial();
    full.myFamily.mockResolvedValue(led(3, [
      { accountId: 'e1', role: 'elder', joinedAt: 1 },
      { accountId: 'e2', role: 'elder', joinedAt: 2 },
      { accountId: 'm', role: 'member', joinedAt: 3 },
    ]));
    await (await session(full)).tickFamily();
    expect(full.setRole).not.toHaveBeenCalled();
  });


  it('a failed found (TAG taken meanwhile) propagates, and drops the claim so the slot is re-read next time', async () => {
    vi.useFakeTimers({ now: 1e12 });
    const social = fakeSocial();
    social.createFamily.mockRejectedValueOnce(new BotApiError('TAG_TAKEN', 'x'));
    const s = await session(social);
    await expect(s.tickFamily()).rejects.toThrow('TAG_TAKEN');
    vi.setSystemTime(1e12 + MIN);
    await s.tickFamily();
    expect(social.getFamily).toHaveBeenCalledTimes(2);
    expect(social.createFamily).toHaveBeenCalledTimes(2);
  });

  it('NOT_FOUND on apply (family disbanded since the lookup) is a race, not a failure; no seat is held', async () => {
    const orgs = new BotOrgRegistry();
    const social = fakeSocial();
    social.getFamily.mockImplementation(roster({ 0: fam(0, { memberCount: FAMILY_CAP - 1 }) }));
    social.requestJoin.mockRejectedValueOnce(new BotApiError('NOT_FOUND', 'x'));
    await expect((await session(social, { orgs })).tickFamily()).resolves.toBeUndefined();
    // Had bot-0001 been counted as pending, the one free seat would look taken and bot-0002 would found slot 1.
    const other = fakeSocial();
    other.getFamily.mockImplementation(roster({ 0: fam(0, { memberCount: FAMILY_CAP - 1 }) }));
    await (await session(other, { orgs, id: bot2 })).tickFamily();
    expect(other.requestJoin).toHaveBeenCalledWith('t', `fam:${BOT_FAMILY_ROSTER[0]!.tag}`);
  });

  it('an unexpected apply error propagates so the fleet failure log counts it', async () => {
    const social = fakeSocial();
    social.getFamily.mockImplementation(roster({ 0: fam(0) }));
    social.requestJoin.mockRejectedValue(new BotApiError('BANNED', 'x'));
    await expect((await session(social)).tickFamily()).rejects.toThrow('BANNED');
  });

  it('joining a family releases the seat this bot was holding in the shared registry', async () => {
    vi.useFakeTimers({ now: 1e12 });
    const orgs = new BotOrgRegistry();
    const families = roster({ 0: fam(0, { memberCount: FAMILY_CAP - 1 }) });
    const a = fakeSocial();
    a.getFamily.mockImplementation(families);
    const s = await session(a, { orgs });
    await s.tickFamily(); // applies, holds the last seat
    a.myFamily.mockResolvedValue(fam(1, { members: [{ accountId: 'a1', role: 'member', joinedAt: 0 }] }));
    vi.setSystemTime(1e12 + MIN);
    await s.tickFamily(); // accepted elsewhere -> seat released
    const b = fakeSocial();
    b.getFamily.mockImplementation(families);
    await (await session(b, { orgs, id: bot2 })).tickFamily();
    expect(b.requestJoin).toHaveBeenCalledWith('t', `fam:${BOT_FAMILY_ROSTER[0]!.tag}`);
  });

  it('an applicant who got into another family first (ALREADY_IN_FAMILY) does not stop the accepting', async () => {
    const social = fakeSocial();
    social.myFamily.mockResolvedValue(led(3));
    social.listJoinRequests.mockResolvedValue([
      { requestId: 'r1', accountId: 'x1', createdAt: 1 },
      { requestId: 'r2', accountId: 'x2', createdAt: 2 },
    ]);
    social.respondJoinRequest.mockImplementation(async (_t: string, id: string) => {
      if (id === 'r1') throw new BotApiError('ALREADY_IN_FAMILY', 'x');
    });
    await (await session(social)).tickFamily();
    expect(social.respondJoinRequest.mock.calls.map((c: unknown[]) => [c[1], c[2]])).toEqual([
      ['r1', true],
      ['r2', true],
    ]);
  });

  it('an unexpected error while approving propagates', async () => {
    const social = fakeSocial();
    social.myFamily.mockResolvedValue(led(3));
    social.listJoinRequests.mockResolvedValue([{ requestId: 'r1', accountId: 'x1', createdAt: 1 }]);
    social.respondJoinRequest.mockRejectedValue(new BotApiError('NO_PERMISSION', 'x'));
    await expect((await session(social)).tickFamily()).rejects.toThrow('NO_PERMISSION');
  });

  it('members without an accountId in the view are never picked as elder', async () => {
    const social = fakeSocial();
    social.myFamily.mockResolvedValue(led(3, [
      { role: 'member', joinedAt: 1 },
      { accountId: 'm2', role: 'member', joinedAt: 2 },
    ]));
    await (await session(social)).tickFamily();
    expect(social.setRole).toHaveBeenCalledWith('t', 'm2', 'elder');
  });

  describe('sects', () => {
    function sectWorld(sects: unknown[]): any {
      return {
        listSects: vi.fn().mockResolvedValue(sects),
        createSect: vi.fn().mockResolvedValue({}),
        joinSect: vi.fn().mockResolvedValue(undefined),
      };
    }
    function sect(slot: number, memberFamilyCount: number): Record<string, unknown> {
      const { name, tag } = BOT_SECT_ROSTER[slot]!;
      return { sectId: `s:s3-0:${tag}`, name, tag, leaderFamilyId: 'f', memberFamilyCount };
    }
    async function leaderIn(worldId: string | undefined, social: any, world: any): Promise<any> {
      const commercial = fakeCommercial();
      const s = await session(social, { world, commercial });
      (s as any).worldId = worldId; // normally set by tickSlg's season join
      await s.tickFamily();
      return commercial;
    }

    it('leader of family slot 0 founds sect 0, after being granted the founding cost (idempotent orderId)', async () => {
      const social = fakeSocial();
      social.myFamily.mockResolvedValue(led(0));
      const world = sectWorld([]);
      const commercial = await leaderIn('s3-0', social, world);
      expect(commercial.grantCoins).toHaveBeenCalledWith('a1', SECT_CREATE_COST, 'bot-sect-bot-0001-s3-0', 'bot_sect_found');
      expect(world.createSect).toHaveBeenCalledWith('t', 's3-0', BOT_SECT_ROSTER[0]!.name, BOT_SECT_ROSTER[0]!.tag);
      expect(world.joinSect).not.toHaveBeenCalled();
    });

    it('other bot-family leaders join the emptiest bot sect with room, never a human one', async () => {
      const social = fakeSocial();
      social.myFamily.mockResolvedValue(led(7));
      const human = { sectId: 's:s3-0:HUM', name: 'Humans', tag: 'HUM', leaderFamilyId: 'h', memberFamilyCount: 0 };
      const world = sectWorld([sect(0, 4), human, sect(1, SECT_FAMILY_CAP), sect(2, 2)]);
      const commercial = await leaderIn('s3-0', social, world);
      expect(world.joinSect).toHaveBeenCalledWith('t', 's3-0', sect(2, 2).sectId);
      expect(world.createSect).not.toHaveBeenCalled();
      expect(commercial.grantCoins).not.toHaveBeenCalled();
    });

    it('a founder whose sect already exists joins like everyone else instead of founding a second', async () => {
      const social = fakeSocial();
      social.myFamily.mockResolvedValue(led(1));
      const world = sectWorld([sect(0, 3), sect(1, 5)]);
      await leaderIn('s3-0', social, world);
      expect(world.createSect).not.toHaveBeenCalled();
      expect(world.joinSect).toHaveBeenCalledWith('t', 's3-0', sect(0, 3).sectId);
    });

    it('no sect step when already in a sect, before the bot has a world, or for a non-bot family', async () => {
      const cases: Array<[string | undefined, Record<string, unknown>]> = [
        ['s3-0', led(4, [], { sectId: 's:s3-0:INKP' })],
        [undefined, led(4)],
        ['s3-0', led(4, [], { name: 'Not A Bot Family' })],
      ];
      for (const [worldId, view] of cases) {
        const social = fakeSocial();
        social.myFamily.mockResolvedValue(view);
        const world = sectWorld([sect(0, 1)]);
        await leaderIn(worldId, social, world);
        expect(world.listSects).not.toHaveBeenCalled();
      }
    });

    it('a failed grant founds nothing: no create without the coins to pay for it', async () => {
      const social = fakeSocial();
      social.myFamily.mockResolvedValue(led(0));
      const world = sectWorld([]);
      const commercial = fakeCommercial();
      commercial.grantCoins.mockRejectedValue(new Error('grant 500'));
      const s = await session(social, { world, commercial });
      (s as any).worldId = 's3-0';
      await expect(s.tickFamily()).rejects.toThrow('grant 500');
      expect(world.createSect).not.toHaveBeenCalled();
    });

    it('a failed create is retried next tick with the SAME grant orderId, so the founder is never paid twice', async () => {
      vi.useFakeTimers({ now: 1e12 });
      const social = fakeSocial();
      social.myFamily.mockResolvedValue(led(0));
      const world = sectWorld([]);
      world.createSect.mockRejectedValueOnce(new BotApiError('NAME_TAKEN', 'x'));
      const commercial = fakeCommercial();
      const s = await session(social, { world, commercial });
      (s as any).worldId = 's3-0';
      await expect(s.tickFamily()).rejects.toThrow('NAME_TAKEN');
      vi.setSystemTime(1e12 + 60_000);
      await s.tickFamily();
      expect(world.createSect).toHaveBeenCalledTimes(2);
      const orderIds = commercial.grantCoins.mock.calls.map((c: unknown[]) => c[2]);
      expect(orderIds).toEqual(['bot-sect-bot-0001-s3-0', 'bot-sect-bot-0001-s3-0']);
    });

    /**
     * A bot's own next sect step is 60s away, when the sect cache has expired anyway; the forgetSects
     * calls exist for the NEXT leader reading the shared registry within that minute. Runs the leader
     * of `firstSlot`, then a slot-9 leader in the same world; resolves/rejects with the FIRST outcome.
     */
    async function twoLeaders(world: any, firstSlot: number): Promise<void> {
      const orgs = new BotOrgRegistry();
      const first = fakeSocial();
      first.myFamily.mockResolvedValue(led(firstSlot));
      const a = await session(first, { world, orgs });
      (a as any).worldId = 's3-0';
      const outcome = a.tickFamily();
      await outcome.catch(() => undefined);
      const second = fakeSocial();
      second.myFamily.mockResolvedValue(led(9));
      const b = await session(second, { world, orgs, id: bot2 });
      (b as any).worldId = 's3-0';
      await b.tickFamily();
      return outcome;
    }

    it('after a leader founds a sect, the next leader re-reads the shared sect list and joins it', async () => {
      const world = sectWorld([]);
      world.listSects.mockResolvedValueOnce([]).mockResolvedValue([sect(0, 1)]);
      await twoLeaders(world, 0);
      expect(world.listSects).toHaveBeenCalledTimes(2);
      expect(world.joinSect).toHaveBeenCalledWith('t', 's3-0', sect(0, 1).sectId);
    });

    it('after a join, the next leader re-reads the shared sect list', async () => {
      const world = sectWorld([sect(0, 1), sect(1, 1)]);
      await twoLeaders(world, 7);
      expect(world.listSects).toHaveBeenCalledTimes(2);
    });

    it('a rejected join (SECT_FULL race) propagates, and the next leader still re-reads the list', async () => {
      const world = sectWorld([sect(0, SECT_FAMILY_CAP - 1)]);
      world.joinSect.mockRejectedValueOnce(new BotApiError('SECT_FULL', 'x'));
      await expect(twoLeaders(world, 7)).rejects.toThrow('SECT_FULL');
      expect(world.listSects).toHaveBeenCalledTimes(2);
    });

    it('a non-founder leader with no bot sect in its world yet waits: no grant, no create, no join', async () => {
      const social = fakeSocial();
      social.myFamily.mockResolvedValue(led(BOT_SECT_ROSTER.length));
      const world = sectWorld([]);
      const commercial = await leaderIn('s3-0', social, world);
      expect(commercial.grantCoins).not.toHaveBeenCalled();
      expect(world.createSect).not.toHaveBeenCalled();
      expect(world.joinSect).not.toHaveBeenCalled();
    });
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
    const world = siegeWorld({ getWorldMe: vi.fn().mockImplementation(async () => solventMe({ mainBaseTile: undefined })) });
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
    const world = siegeWorld({ getWorldMe: vi.fn().mockImplementation(async () => solventMe({ troops: 0 })) });
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
