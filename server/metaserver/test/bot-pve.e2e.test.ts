// botsvc PvE against the real metaserver (BOTSVC_DESIGN §3.5): a bot reads its save, enters a level,
// plays it on the real engine (botsvc/src/pve.ts, imported straight from source) and settles it
// through /pve/clear — and, since a first clear is always spot-checked, through /pve/verify with a
// judge that recomputes the run the way a peer client does (client/src/net/judgeRunner.ts
// runPveJudge): from the level's seed, the server's own card snapshot in the judge request, and the
// bot's uploaded frames. An honest bot has to come out verified, never flagged.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import {
  ENGINE_VERSION,
  ReplayInputSource,
  Side,
  buildStarContext,
  computeStars,
  getLevel,
  runHeadless,
} from '@nw/engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { GatewayClient, JudgeReq, JudgeRes } from '../src/gatewayClient.js';
import { fakeGateway } from './helpers/fakeClients.js';
import { pickLevel, playLevel, toEngineCards } from '../../botsvc/src/pve';
import { decodeSideCommands } from '../../botsvc/src/protoCodec';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_bot_pve_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[bot-pve.e2e] Mongo unreachable (${URI}) — skipping.`);

/** runPveJudge without the proto transport, reading only what the server put in the request. */
function peerJudge(req: JudgeReq): JudgeRes {
  const level = getLevel(req.levelId!)!;
  const frames = req.frames.map((f) => ({
    tick: f.frame,
    commands: f.cmds.flatMap((c) => decodeSideCommands(Buffer.from(c.commands, 'base64'), c.side as 0 | 1, f.frame)),
  }));
  const { ok, engine } = runHeadless(
    {
      seed: level.seed,
      players: [{ id: 0 }, { id: 1 }],
      mode: 'campaign',
      level,
      cardInstances: toEngineCards(JSON.parse(req.cardInstancesJson ?? '{}')),
      equipmentInv: JSON.parse(req.equipmentInvJson ?? '{}'),
    },
    new ReplayInputSource({ engineVersion: ENGINE_VERSION, mode: 'campaign', seed: level.seed, frames, endFrame: req.endFrame }),
    req.endFrame + 600,
  );
  if (!ok || engine.state.winner !== Side.Bottom) return { ok, winnerSide: 1, stars: 0 };
  const stats = engine.state.snapshotStats();
  const summary = engine.state.snapshotSummary();
  const stars = computeStars(level.rewards?.starThresholds, buildStarContext(level, {
    damageTakenByBase: stats[0].damageTakenByBase,
    elapsedTicks: summary.elapsedTicks,
    enemyLeaks: summary.enemyLeaks,
    escortMinHpPct: summary.escortMinHpPct,
    unitsKilled: stats[0].unitsKilled,
  }));
  return { ok: true, winnerSide: 0, stars, statsJson: '{}' };
}

describe.skipIf(!mongo)('botsvc PvE run settles on the real metaserver', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  const judged: JudgeReq[] = [];
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const post = async (url: string, payload: unknown) => body(await app.inject({ method: 'POST', url, headers: auth(), payload: payload as object }));

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    judged.length = 0;
    const gateway = fakeGateway({ available: true });
    (gateway as { judge: GatewayClient['judge'] }).judge = async (req) => {
      judged.push(req);
      return peerJudge(req);
    };
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', gateway });
    token = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'bot-pve-e2e' } })).data.token;
  });
  afterAll(async () => { if (app) await app.close(); });

  /** One run exactly as BotSession.runPve does it; returns what the server said at each step. */
  async function botRun(difficulty: 8 | 10 = 10) {
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() })).data.save;
    const levelId = pickLevel(save.progress, () => 0.99)!;
    const enter = await post('/pve/enter', { levelId });
    const run = await playLevel(
      getLevel(levelId)!,
      { cardInstances: toEngineCards(save.cardInv), equipmentInv: save.equipmentInv ?? {} },
      { aiSeed: 7, difficulty },
    );
    if (!run.won) return { levelId, enter, run };
    const clear = await post('/pve/clear', { levelId, stars: run.stars, stats: run.stats });
    const verify = clear.data?.needsReplay
      ? await post('/pve/verify', { verifyId: clear.data.verifyId, endFrame: run.endFrame, frames: run.frames })
      : undefined;
    return { levelId, enter, run, clear, verify };
  }

  it('a fresh bot clears ch1_lv1: stamina spent, first clear spot-checked, the judge agrees, progress written', async () => {
    const r = await botRun();
    expect(r.levelId).toBe('ch1_lv1');
    expect(r.enter.ok).toBe(true);
    expect(r.enter.data.stamina.current).toBe(110);
    expect(r.run.won).toBe(true);
    expect(r.clear!.data.needsReplay).toBe(true);
    // The judge was handed the server's snapshot, not anything the bot sent.
    expect(judged).toHaveLength(1);
    expect(judged[0]!.levelId).toBe('ch1_lv1');
    // A new account holds three starter cards, so the run depends on the snapshot really matching.
    expect(Object.keys(JSON.parse(judged[0]!.cardInstancesJson!))).toHaveLength(3);
    expect(r.verify!.ok).toBe(true);
    expect(r.verify!.data.verified).toBe(true);
    expect(r.verify!.data.save.progress.cleared).toContain('ch1_lv1');
    expect(r.verify!.data.save.progress.stars.ch1_lv1).toBe(r.run.stars);
    const flagged = await m.collections.pveVerifications.find({ status: 'rejected' }).toArray();
    expect(flagged).toEqual([]);
  });

  it('the next run pushes the frontier, and its spot check passes too', async () => {
    await botRun();
    const r = await botRun();
    expect(r.levelId).toBe('ch1_lv2');
    if (r.run.won) {
      expect(r.verify?.data.verified ?? true).toBe(true);
    }
  });
});
