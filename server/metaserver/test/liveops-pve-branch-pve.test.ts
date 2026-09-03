// Branch-coverage backfill for src/service/pve/{verify,clear}.ts (2026-09-03 branch-coverage task,
// group E). test/pve-service-unit.test.ts already drives both handlers through fastify for every
// happy/refusal path its route schema allows; this file adds the arms it structurally cannot reach:
//
//  * the absent-field fallbacks on data the handler forwards verbatim — a verify submission with no
//    `frames`/`endFrame` and a verification doc with no `cardInv`/`equipmentInv` (a doc written before
//    those snapshots existed). What the judge is asked to re-simulate in that case is the point.
//  * the rejected-clear archive path with those same fields absent: a rejected replay must still be
//    archived (`frames: []`) and kept forever (expireAt unset) for ops review.
//  * `deps.socialsvc === null` — buildApp always fills that field with nullMetaSocialsvcClient, so the
//    `?? nullMetaSocialsvcClient` fallbacks in both files only run when ServiceDeps is built directly.
//  * every lost write: the consolidated reward write and the reject-count write losing their rev races
//    (a wrapped saves collection that never matches, as in test/economy-service-unit.test.ts), which is
//    what decides whether a rejected clear is still recorded and whether a delivery failure is a clean
//    409 or a half-applied reward.
//
// Real Mongo (the shared rs0 instance, own DB) for the same reason pve-service-unit.test.ts uses it:
// grantCards/recordMaterialGrants use $addToSet-with-$each and $push+$slice, which FakeCollection does
// not implement. Handlers are called as plain functions against a directly-constructed MetaCore — the
// route schema would otherwise reject the missing-field bodies before the handler ever sees them.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createMongo, type Collections, type JwtConfig, type MongoHandle, type SaveData } from '@nw/shared';
import type { CommercialClient } from '../src/commercialClient.js';
import type { GatewayClient, JudgeReq, JudgeRes } from '../src/gatewayClient.js';
import { MetaCore, type ServiceDeps } from '../src/service/base.js';
import { AccountCache } from '../src/accountCache.js';
import { pveVerifyHandler } from '../src/service/pve/verify.js';
import { pveClearHandler } from '../src/service/pve/clear.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_grpE_branch_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const NOW = 1_800_000_000_000;
const ACC = 'acc-grpE-pve';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (e) {
    if (process.env.NW_REQUIRE_DB) throw e;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[liveops-pve-branch-pve] Mongo unreachable (${URI}) — skipping.`);

class FakeGateway implements GatewayClient {
  available = true;
  next: JudgeRes = { ok: true, stars: 3 };
  last?: JudgeReq;
  pushes: unknown[] = [];
  async judge(r: JudgeReq): Promise<JudgeRes> {
    this.last = r;
    return this.next;
  }
  async push(_accountId: string, payload: unknown): Promise<void> {
    this.pushes.push(payload);
  }
  async presence(): Promise<Record<string, boolean>> {
    return {};
  }
  async invalidateFriends(): Promise<void> {}
}

const commercial = {
  available: true,
  async grant(a: { amount: number }) {
    return { ok: true as const, coinsAfter: a.amount };
  },
} as unknown as CommercialClient;

function makeReply() {
  const sent: { code?: number; payload?: unknown } = {};
  const reply = {
    code(c: number) { sent.code = c; return reply; },
    send(p: unknown) { sent.payload = p; return reply; },
  };
  return { sent, reply: reply as unknown as FastifyReply };
}

const req = (body: unknown) => ({ accountId: ACC, body, headers: {}, log: { warn() {} } }) as unknown as FastifyRequest;
const errOf = (p: unknown) => (p as { error: { code: string; message: string } }).error;

describe.skipIf(!mongo)('pve verify/clear branch backfill (group E)', () => {
  const m = mongo!;
  const gateway = new FakeGateway();

  /** MetaCore over the real collections; `losingSaves` makes every save write miss (-> REV_CONFLICT). */
  function makeCore(opts: { losingSaves?: boolean } = {}): MetaCore {
    const realSaves = m.collections.saves;
    const saves = opts.losingSaves
      ? ({
          findOne: realSaves.findOne.bind(realSaves),
          updateOne: realSaves.updateOne.bind(realSaves),
          findOneAndUpdate: async () => null,
        } as unknown as Collections['saves'])
      : realSaves;
    return new MetaCore({
      cols: { ...m.collections, saves },
      jwt,
      now: () => NOW,
      commercial,
      gatewayPublicUrl: null,
      gateway,
      authRateLimit: 0,
      flags: null,
      wordlists: null,
      region: null,
      lokiPushUrl: null,
      // Not nullMetaSocialsvcClient: buildApp can never produce a null here, but ServiceDeps declares it
      // and both files carry a `?? nullMetaSocialsvcClient` fallback for exactly this shape.
      socialsvc: null,
      redis: null,
      accountCache: new AccountCache(),
    } as ServiceDeps);
  }

  /** A pending spot-check written the way an older build did: no cardInv/equipmentInv snapshot at all. */
  async function seedPendingVerification(id: string, levelId: string, claimedStars = 3): Promise<void> {
    await m.collections.pveVerifications.insertOne({
      _id: id,
      accountId: ACC,
      levelId,
      claimedStars,
      reason: 'first',
      status: 'pending',
      ts: NOW,
      expireAt: new Date(NOW + 1000),
    } as never);
  }

  async function seedSave(patch: Partial<SaveData> = {}): Promise<void> {
    const { getOrCreateSave } = await import('../src/save.js');
    await getOrCreateSave(m.collections, ACC, NOW);
    if (Object.keys(patch).length > 0) {
      const doc = (await m.collections.saves.findOne({ _id: ACC }))!;
      await m.collections.saves.updateOne(
        { _id: ACC },
        { $set: { save: { ...doc.save, ...patch }, rev: doc.rev } },
      );
    }
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    gateway.available = true;
    gateway.next = { ok: true, stars: 3 };
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  // ── verify.ts ─────────────────────────────────────────────────────────────────────────────────
  describe('pveVerifyHandler', () => {
    it('submission with no frames/endFrame against a doc with no inventory snapshot: the judge still gets a well-formed request', async () => {
      await seedSave();
      await seedPendingVerification('v-empty', 'ch1_lv1');
      gateway.next = { ok: true, stars: 3 }; // no judgeAccountId either
      const { sent, reply } = makeReply();
      const out = (await pveVerifyHandler(makeCore(), req({ verifyId: 'v-empty' }), reply)) as { data: { verified: boolean } };
      expect(sent.code).toBeUndefined();
      expect(out.data.verified).toBe(true);
      expect(gateway.last).toMatchObject({ frames: [], endFrame: 0, cardInstancesJson: '{}', equipmentInvJson: '{}' });
      const doc = await m.collections.pveVerifications.findOne({ _id: 'v-empty' });
      expect(doc?.status).toBe('verified');
      expect(doc?.judgeAccountId).toBeUndefined(); // no judge id reported -> field not written at all
    });

    it('a verdict that names its judge stamps the judge account onto the verification doc', async () => {
      // The counterpart of the test above: pve-service-unit.test.ts always overrides the verdict with one
      // that has no judgeAccountId, so the "record who judged this" arm is never taken there.
      await seedSave();
      await seedPendingVerification('v-judge', 'ch1_lv1');
      gateway.next = { ok: true, stars: 3, judgeAccountId: 'judge-42' };
      const { sent, reply } = makeReply();
      await pveVerifyHandler(makeCore(), req({ verifyId: 'v-judge', frames: [], endFrame: 12 }), reply);
      expect(sent.code).toBeUndefined();
      const doc = await m.collections.pveVerifications.findOne({ _id: 'v-judge' });
      expect(doc?.judgeAccountId).toBe('judge-42');
    });

    it('rejected verdict with no frames submitted: still archived (empty frame list) and kept forever for ops review', async () => {
      await seedSave();
      await seedPendingVerification('v-rejected', 'ch1_lv1');
      gateway.next = { ok: true, stars: 1 }; // below the claimed 3 -> rejected
      const { sent, reply } = makeReply();
      const out = (await pveVerifyHandler(makeCore(), req({ verifyId: 'v-rejected' }), reply)) as { data: { verified: boolean; granted: unknown } };
      expect(sent.code).toBeUndefined();
      expect(out.data.verified).toBe(false);
      expect(out.data.granted).toEqual({});
      const doc = await m.collections.pveVerifications.findOne({ _id: 'v-rejected' });
      expect(doc?.status).toBe('rejected');
      expect(doc?.frames).toEqual([]);
      expect(doc?.endFrame).toBe(0);
      expect(doc?.expireAt).toBeUndefined(); // TTL unset: a rejected doc is kept for review
      // socialsvc is not wired at all, so the warning mail throws and is swallowed — the review ticket
      // and the reject count must land regardless.
      const review = await m.collections.antiCheatReviews.findOne({ _id: 'pve:v-rejected' });
      expect(review).toMatchObject({ kind: 'pve_reject', rejectCountAfter: 1, severity: 'normal', status: 'open' });
      expect(review?.publicId).toBeUndefined(); // no accounts document -> nothing to stamp
      const rejection = await m.collections.pveRejections.findOne({ _id: 'v-rejected' });
      expect(rejection?.judgedStars).toBe(1);
    });

    it('rejected verdict whose reject-count write loses every rev race: the rejection is still filed and the response still answers with the live save', async () => {
      await seedSave();
      await seedPendingVerification('v-rejected-conflict', 'ch1_lv1');
      gateway.next = { ok: true, stars: 0 };
      const { sent, reply } = makeReply();
      const out = (await pveVerifyHandler(makeCore({ losingSaves: true }), req({ verifyId: 'v-rejected-conflict', frames: [], endFrame: 10 }), reply)) as {
        data: { verified: boolean; save: SaveData };
      };
      expect(sent.code).toBeUndefined();
      expect(out.data.verified).toBe(false);
      expect(out.data.save.accountId).toBe(ACC); // re-read from Mongo, not the failed transform's output
      expect(out.data.save.antiCheat?.pveRejectCount ?? 0).toBe(0); // the counter write really did fail
      const review = await m.collections.antiCheatReviews.findOne({ _id: 'pve:v-rejected-conflict' });
      expect(review?.rejectCountAfter).toBe(1); // ops still sees the flag
    });

    it('verified verdict whose consolidated reward write loses every rev race -> 409, nothing delivered', async () => {
      // ch_stress has no material and no card reward, so the card-grant step is skipped entirely and the
      // only write left to fail is the consolidated one inside deliverVerifiedClearReward.
      await seedSave({ progress: { cleared: ['ch1_lv1', 'ch1_lv2', 'ch1_lv3'], stars: {}, best: {} } });
      await seedPendingVerification('v-conflict', 'ch_stress');
      gateway.next = { ok: true, stars: 3, statsJson: '{"kill.archer":2}' };
      const { sent, reply } = makeReply();
      await pveVerifyHandler(makeCore({ losingSaves: true }), req({ verifyId: 'v-conflict', frames: [], endFrame: 5 }), reply);
      expect(sent.code).toBe(409);
      expect(errOf(sent.payload).code).toBe('REV_CONFLICT');
      const save = (await m.collections.saves.findOne({ _id: ACC }))!.save;
      expect(save.stats?.['kill.archer'] ?? 0).toBe(0); // judged stats not accrued either
    });
  });

  // ── clear.ts ──────────────────────────────────────────────────────────────────────────────────
  describe('pveClearHandler', () => {
    it('first-ever clear with socialsvc absent: the welcome mail failure is swallowed and the clear still settles', async () => {
      // socialsvc null -> nullMetaSocialsvcClient -> insertSystemMail throws; the clear must not care.
      await seedSave();
      gateway.available = false; // no judge -> normal settle, no spot check
      const { sent, reply } = makeReply();
      const out = (await pveClearHandler(makeCore(), req({ levelId: 'ch1_lv1', stars: 3 }), reply)) as {
        data: { save: SaveData; granted: Record<string, number> };
      };
      expect(sent.code).toBeUndefined();
      expect(out.data.granted).toEqual({ scrap: 6, lead: 2 });
      expect(out.data.save.progress.cleared).toContain('ch1_lv1');
      expect(gateway.pushes).toEqual([]); // no mail was inserted, so no mail_new push either
    });

    it('spot-checked clear WITH client stats records them on the verification doc as an audit baseline', async () => {
      await seedSave();
      const { sent, reply } = makeReply();
      const out = (await pveClearHandler(makeCore(), req({ levelId: 'ch1_lv1', stars: 3, stats: { 'kill.archer': 2 } }), reply)) as {
        data: { needsReplay: boolean; verifyId: string };
      };
      expect(sent.code).toBeUndefined();
      expect(out.data.needsReplay).toBe(true);
      const doc = await m.collections.pveVerifications.findOne({ _id: out.data.verifyId });
      expect(doc?.reportedStats).toEqual({ 'kill.archer': 2 });
    });

    it('spot-checked clear whose progress write loses every rev race -> 409, no verification recorded', async () => {
      await seedSave();
      const { sent, reply } = makeReply();
      await pveClearHandler(makeCore({ losingSaves: true }), req({ levelId: 'ch1_lv1', stars: 3 }), reply);
      expect(sent.code).toBe(409);
      expect(errOf(sent.payload).code).toBe('REV_CONFLICT');
      expect(await m.collections.pveVerifications.countDocuments({})).toBe(0);
      const save = (await m.collections.saves.findOne({ _id: ACC }))!.save;
      expect(save.progress.cleared).toEqual([]); // the level did not unlock
    });

    it('normal-settle clear whose consolidated write loses every rev race -> 409, progress unchanged', async () => {
      // ch_stress again: no reward at all, so the spot check is skipped and settleNormalClear's single
      // consolidated write is the only thing that can fail.
      await seedSave({ progress: { cleared: ['ch1_lv1', 'ch1_lv2', 'ch1_lv3'], stars: {}, best: {} } });
      const { sent, reply } = makeReply();
      await pveClearHandler(makeCore({ losingSaves: true }), req({ levelId: 'ch_stress', stars: 3 }), reply);
      expect(sent.code).toBe(409);
      expect(errOf(sent.payload).code).toBe('REV_CONFLICT');
      const save = (await m.collections.saves.findOne({ _id: ACC }))!.save;
      expect(save.progress.cleared).not.toContain('ch_stress');
    });
  });
});
