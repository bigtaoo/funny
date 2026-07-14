import { describe, it, expect, vi } from 'vitest';
import { BotSession } from '../src/bot';
import type { BotIdentity } from '../src/pool';

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

async function loggedInSession(world: any): Promise<BotSession> {
  const session = new BotSession(identity, fakeMeta(), fakeSocial(), fakeCommercial(), world);
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
    const session = new BotSession(identity, fakeMeta(), fakeSocial(), fakeCommercial(), world);

    await session.tickSlg();

    expect(world.getActiveSeason).not.toHaveBeenCalled();
  });
});
