import { describe, it, expect, vi } from 'vitest';
import { BotSession } from '../src/bot';
import type { BotIdentity } from '../src/pool';
import * as battleSession from '../src/battleSession';

vi.mock('../src/battleSession', () => ({ playRankedMatch: vi.fn() }));

const identity: BotIdentity = { deviceId: 'bot-0001', paymentTier: 'free' };

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
