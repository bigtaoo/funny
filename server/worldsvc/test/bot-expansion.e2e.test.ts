// The expansion and training planners against the REAL worldsvc, not against a fake of it (BOTSVC_DESIGN §3.4).
//
// expansion.test.ts pins the planner's rules, but those rules are a mirror of worldsvc's — and the bug
// this replaces was exactly a mirror that disagreed with the server: bots picked targets up to 40 tiles
// away, every `POST /world/march` was rejected as TERRITORY_NOT_CONNECTED, and every botsvc test stayed
// green because each one stubbed the world. Here worldsvc's own WorldService (real Mongo, fake clock)
// answers the map view, validates each march, fights each occupation battle and runs each hold; the
// planner only decides. If the two ever disagree about what is connected, a march throws.
//
// The training planner gets the same treatment: its quantity is posted to the real trainTroops, and one
// more troop than it offers must be refused — a mirror that is merely "not rejected" could still be
// leaving most of the bot's resources on the table.
//
// Lives in worldsvc/test because this suite owns the Mongo harness (globalSetup); the planners are
// imported straight from botsvc/src. Skipped when Mongo is unreachable, like every e2e here.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OCCUPY_MIN_TROOPS, SLG_MAP_H, SLG_MAP_W, TROOP_CAP_BASE, baseFootprintCells, proceduralTile, troopTrainCost } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { EXPAND_TROOP_FLOOR, planExpansion } from '../../botsvc/src/expansion';
import { planTraining } from '../../botsvc/src/training';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_bot_expansion_test';
const W = 's1-bot-expand';
const BOT = 'bot-acct';
const BASE = { x: 40, y: 40 };
/** BotSession's EXPAND_VIEW_RADIUS. */
const VIEW_RADIUS = 8;

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.bot-expansion.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

describe.skipIf(!mongo)('bot expansion against the real worldsvc (BOTSVC_DESIGN §3.4)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  let svc: WorldService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    svc = new WorldService({ cols: m.collections, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => nowMs });
    await svc.joinWorld(W, BOT, BASE.x, BASE.y);
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  /** One expansion pass exactly as BotSession.tryExpand runs it, then the server's own arrival + hold. */
  async function expandOnce(): Promise<{ x: number; y: number } | null> {
    const me = await svc.getMe(W, BOT);
    const { tiles } = await svc.getMap(W, BOT, BASE.x, BASE.y, VIEW_RADIUS);
    const plan = planExpansion(tiles, BASE, me.troops!, nowMs, me.yieldRate);
    if (!plan) return null;
    expect(plan.kind).toBe('occupy'); // nobody else is on this map
    // The assertion that matters: worldsvc accepts the march (connectivity, level, troops) at departure.
    const march = await svc.startMarch(W, BOT, BASE.x, BASE.y, plan.x, plan.y, plan.kind, plan.troops);
    nowMs = march.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const held = await svc.getTile(W, BOT, plan.x, plan.y);
    expect(held.contestedByMe, `the L${held.level} battle at (${plan.x},${plan.y}) was lost`).toBe(true);
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    return { x: plan.x, y: plan.y };
  }

  it('grows a connected, paper/graphite-first territory until the troop floor, every march accepted', async () => {
    expect((await svc.getMe(W, BOT)).troops).toBe(TROOP_CAP_BASE);

    const taken: { x: number; y: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const t = await expandOnce();
      if (!t) break;
      taken.push(t);
    }

    // Each occupation costs exactly OCCUPY_MIN_TROOPS from the pool (the survivors garrison the tile),
    // and the planner stops at the floor: 5000 -> 2000 is six tiles.
    expect(taken).toHaveLength((TROOP_CAP_BASE - EXPAND_TROOP_FLOOR) / OCCUPY_MIN_TROOPS);
    expect((await svc.getMe(W, BOT)).troops).toBe(EXPAND_TROOP_FLOOR);

    // All owned, and each one borders the base or an earlier capture — grown outward, never jumped.
    const land = new Set(baseFootprintCells(BASE.x, BASE.y).map((c) => `${c.x}:${c.y}`));
    for (const t of taken) {
      expect((await svc.getTile(W, BOT, t.x, t.y)).mine).toBe(true);
      const touching = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => land.has(`${t.x + dx}:${t.y + dy}`));
      expect(touching, `(${t.x},${t.y}) does not border earlier land`).toBe(true);
      land.add(`${t.x}:${t.y}`);
      expect(proceduralTile(W, t.x, t.y).level).toBeLessThanOrEqual(2);
    }

    // Preference is real on this map: at least the first capture is paper/graphite when one was on offer.
    const firstType = proceduralTile(W, taken[0]!.x, taken[0]!.y).resType;
    expect(['paper', 'graphite']).toContain(firstType);
  });

  /** Put the bot's pool and balance at exact values; the fake clock stands still, so nothing accrues on top. */
  async function setState(troops: number, resources: Record<string, number>): Promise<void> {
    await m.collections.playerWorld.updateOne(
      { worldId: W, accountId: BOT },
      { $set: { troops, resources, lastTickAt: nowMs }, $inc: { rev: 1 } },
    );
  }
  const PLENTY = { ink: 100_000, paper: 100_000, graphite: 100_000, metal: 100_000, sticker: 100_000 };

  it('trains exactly as many troops as the scarcest resource pays for, and not one more', async () => {
    // Metal for 1234 troops, everything else in excess.
    await setState(EXPAND_TROOP_FLOOR, { ...PLENTY, metal: troopTrainCost(1234).metal! });
    const qty = planTraining(await svc.getMe(W, BOT), nowMs);
    expect(qty).toBe(1234);
    await expect(svc.trainTroops(W, BOT, qty + 1)).rejects.toMatchObject({ code: 'INSUFFICIENT_RESOURCES' });
    const after = await svc.trainTroops(W, BOT, qty);
    expect(after.trainingQueue).toHaveLength(1);
    expect(planTraining(after, nowMs)).toBe(0); // the only slot is now busy
  });

  it('trains up to troopCap, and not one more', async () => {
    await setState(TROOP_CAP_BASE - 1000, PLENTY);
    const qty = planTraining(await svc.getMe(W, BOT), nowMs);
    expect(qty).toBe(1000);
    await expect(svc.trainTroops(W, BOT, qty + 1)).rejects.toMatchObject({ code: 'TROOP_CAP_REACHED' });
    await svc.trainTroops(W, BOT, qty);
  });

  it('a bot stalled at the floor trains back up and marches again', async () => {
    for (let i = 0; i < 20 && (await expandOnce()); i++);
    expect((await svc.getMe(W, BOT)).troops).toBe(EXPAND_TROOP_FLOOR);
    expect(await expandOnce()).toBeNull();

    await setState(EXPAND_TROOP_FLOOR, PLENTY);
    const trained = await svc.trainTroops(W, BOT, planTraining(await svc.getMe(W, BOT), nowMs));
    nowMs = trained.trainingQueue![0]!.completeAt;
    expect(await svc.processCompletedTraining(nowMs)).toBeGreaterThan(0);
    expect((await svc.getMe(W, BOT)).troops).toBe(TROOP_CAP_BASE);

    expect(await expandOnce()).not.toBeNull();
  });

  it('stops at the floor: with nothing spare, no march is even attempted', async () => {
    await m.collections.playerWorld.updateOne({ worldId: W, accountId: BOT }, { $set: { troops: EXPAND_TROOP_FLOOR + OCCUPY_MIN_TROOPS - 1 } });
    expect(await expandOnce()).toBeNull();
    expect(await m.collections.marches.countDocuments({ worldId: W })).toBe(0);
  });
});
