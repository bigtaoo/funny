// The siege scan's reach, as a property of the numbers rather than of a stubbed `pickAttackTarget`.
//
// bot.test.ts already covers what `trySiege` does once a target is in hand, and it does so with
// `getWorldMapSparse` / `pickAttackTarget` both mocked — which means the scan RADIUS is invisible to it.
// That is exactly how SIEGE_SCAN_RADIUS could sit at 5 in production while `POST /world/march` stayed
// absent from all 288 worldsvc heartbeats of a 24h window: every one of those tests was green.
//
// So the fakes here are server-faithful instead: `getWorldMapSparse` honours the `r` it is given (the
// same Chebyshev window worldsvc's own query builds, clamped to MAP_VIEW_MAX_RADIUS), and the real
// `WorldClient.pickAttackTarget` / `baseCoords` run. A case then asks the only question that matters —
// at the spacing the live shard actually has, does a march happen?
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotSession } from '../src/bot';
import { WorldClient, type WorldTileSparseView } from '../src/worldClient';
import type { BotIdentity } from '../src/pool';

vi.mock('../src/battleSession', () => ({ playRankedMatch: vi.fn() }));

const HERE = dirname(fileURLToPath(import.meta.url));
const identity: BotIdentity = { deviceId: 'bot-0001', paymentTier: 'free' };
const battleOpts = { gatewayWsUrl: 'ws://unused/gw', chancePerTick: 0 };

/** worldsvc's cap on any map-view radius, read from its source so a change there cannot pass silently. */
function worldsvcViewCap(): number {
  const src = readFileSync(resolve(HERE, '../../worldsvc/src/worldTypes.ts'), 'utf8');
  const m = /export const MAP_VIEW_MAX_RADIUS = (\d+)/.exec(src);
  if (!m) throw new Error('MAP_VIEW_MAX_RADIUS not found in worldsvc/src/worldTypes.ts');
  return Number(m[1]);
}

const BASE = { x: 700, y: 700 };

/**
 * A WorldClient whose sparse view behaves like worldsvc's: one enemy base at `enemyAt`, returned only
 * when it falls inside the requested (server-clamped) window. `pickAttackTarget` and `baseCoords` are
 * the real prototype methods — only the network-facing calls are replaced.
 */
function serverFaithfulWorld(enemyAt: { x: number; y: number }, cap = worldsvcViewCap()) {
  const world = new WorldClient('http://unused');
  const enemy: WorldTileSparseView = { x: enemyAt.x, y: enemyAt.y, type: 'base' };
  const own: WorldTileSparseView = { ...BASE, type: 'base', mine: true };
  const getWorldMapSparse = vi.fn(
    async (_t: string, worldId: string, cx: number, cy: number, r: number) => {
      const rad = Math.min(cap, r);
      const inWindow = (t: WorldTileSparseView) => Math.abs(t.x - cx) <= rad && Math.abs(t.y - cy) <= rad;
      return { worldId, tiles: [own, enemy].filter(inWindow) };
    },
  );
  Object.assign(world, {
    getActiveSeason: vi.fn().mockResolvedValue({ season: 3 }),
    joinSeason: vi.fn().mockResolvedValue({ joined: true, worldId: 's3-0' }),
    upgradeBuilding: vi.fn().mockResolvedValue(undefined),
    getWorldMe: vi.fn().mockResolvedValue({ joined: true, troops: 100, mainBaseTile: `s3-0:${BASE.x}:${BASE.y}` }),
    getWorldMapSparse,
    startMarchAttack: vi.fn().mockResolvedValue(undefined),
  });
  return world as WorldClient & {
    getWorldMapSparse: typeof getWorldMapSparse;
    startMarchAttack: ReturnType<typeof vi.fn>;
    upgradeBuilding: ReturnType<typeof vi.fn>;
  };
}

function fakeMeta(): any {
  return { deviceLogin: vi.fn().mockResolvedValue({ token: 't', accountId: 'a1', isNew: false }) };
}
function fakeSocial(): any {
  return { myFamily: vi.fn().mockResolvedValue(null), searchFamilies: vi.fn().mockResolvedValue([]), joinFamily: vi.fn(), leaveFamily: vi.fn() };
}
function fakeCommercial(): any {
  return { buyMonthlyCard: vi.fn(), buyStarterGrowth: vi.fn() };
}

/** Run the five ticks it takes to reach one siege-interval tick (SIEGE_TICK_INTERVAL = 5). */
async function runToSiegeTick(world: WorldClient): Promise<void> {
  const session = new BotSession(identity, fakeMeta(), fakeSocial(), fakeCommercial(), world, battleOpts);
  await session.login();
  for (let i = 0; i < 5; i++) await session.tickSlg();
}

describe('siege scan radius', () => {
  it('reaches a neighbour at the spacing the live shard has, not just an adjacent one', async () => {
    // 30 tiles: comfortably inside worldsvc's cap, and far outside the 11×11 window the old radius of 5
    // asked for. Live s2-0 on 2026-09-15 measured nearest-neighbour base distance at p50 = 42, p90 = 85.
    const world = serverFaithfulWorld({ x: BASE.x + 30, y: BASE.y - 12 });

    await runToSiegeTick(world);

    expect(world.startMarchAttack).toHaveBeenCalledWith('t', 's3-0', BASE, { x: BASE.x + 30, y: BASE.y - 12 }, 30);
  });

  it('still falls through to an upgrade when the nearest neighbour is past the server view cap', async () => {
    // The honest ceiling: one sparse call cannot see further than MAP_VIEW_MAX_RADIUS, so roughly half
    // the live shard's bots have no reachable target even at the cap. That is a known limit, not a bug —
    // pinned here so a future "why does it sometimes not march" does not get re-diagnosed from scratch.
    const cap = worldsvcViewCap();
    const world = serverFaithfulWorld({ x: BASE.x + cap + 1, y: BASE.y });

    await runToSiegeTick(world);

    expect(world.startMarchAttack).not.toHaveBeenCalled();
    expect(world.upgradeBuilding).toHaveBeenCalledTimes(5);
  });

  it('never asks for a radius worldsvc would silently clamp', async () => {
    const world = serverFaithfulWorld({ x: BASE.x + 30, y: BASE.y });

    await runToSiegeTick(world);

    const asked = world.getWorldMapSparse.mock.calls.map((c) => c[4]);
    expect(asked.length).toBeGreaterThan(0);
    for (const r of asked) expect(r).toBeLessThanOrEqual(worldsvcViewCap());
  });
});
