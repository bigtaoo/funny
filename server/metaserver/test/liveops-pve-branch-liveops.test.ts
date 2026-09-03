// Branch-coverage backfill for src/service/liveops/{profile,achievements,events,lobbyBadges}.ts
// (2026-09-03 branch-coverage task, group E). The happy paths of these four files are already covered
// by test/liveops-equip.test.ts, test/titles.test.ts, test/skin-unit.test.ts,
// test/liveops-achievements-unit.test.ts and test/liveops-events-lobbybadges-unit.test.ts — this file
// only adds the arms none of them can reach *through fastify*:
//
//  * every guard that the openapi request schema rejects first (a missing `unitType`, a non-boolean
//    flag `value`, `amount !== 60`, a missing `rewardId`): the handler's own 400 return is dead code
//    behind route validation, so these are called as plain functions with a hand-built request/reply,
//    exactly the way test/liveops-achievements-unit.test.ts calls claimAchievementHandler for
//    validateClaim's schema-shadowed BAD_REQUEST arm.
//  * `deps.socialsvc == null`: buildApp defaults that field to `nullMetaSocialsvcClient` (app.ts), so
//    the `?? nullMetaSocialsvcClient` fallbacks inside the handlers are only reachable when ServiceDeps
//    is constructed directly — as MetaCore is here.
//  * absent-field fallbacks on a legacy save document (no `titles`, no `equipped`) — HTTP handlers hand
//    whatever is in Mongo straight to these transforms, and accounts created before those fields
//    existed still lack them.
//  * every lost rev race (mutateSave exhausting its 4 attempts -> REV_CONFLICT): a wrapped saves
//    collection whose findOneAndUpdate never matches, the idiom used by test/economy-service-unit.test.ts
//    and test/cards-fuse-unit.test.ts.
//
// FakeCollection-backed (no real Mongo): the only Mongo touch points reachable here are
// getOrCreateSave/mutateSave/mirrorCoins/grantTitleToPlayer (findOne + findOneAndUpdate with $set) and
// events.ts's `events.findOne` miss.
import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { makeNewSave, type Collections, type SaveData } from '@nw/shared';
import type { CommercialClient } from '../src/commercialClient.js';
import { MetaCore, type ServiceDeps } from '../src/service/base.js';
import { AccountCache } from '../src/accountCache.js';
import { getTitlesHandler, equipTitleHandler, equipAvatarHandler, equipSkinHandler, setFlagHandler } from '../src/service/liveops/profile.js';
import { claimAchievementHandler } from '../src/service/liveops/achievements.js';
import { claimEventRewardHandler } from '../src/service/liveops/events.js';
import { getLobbyBadgesHandler } from '../src/service/liveops/lobbyBadges.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeGateway } from './helpers/fakeClients.js';

const jwt = { secret: 'test-secret' };
const NOW = 1_700_000_000_000;
const ACC = 'acc-grpE-liveops';

interface FakeSaveDoc {
  _id: string;
  save: SaveData;
  rev: number;
}

/** Minimal always-succeeding commercial double (the achievements claim below needs `available` + `grant`). */
function makeCommercial(): CommercialClient {
  return {
    available: true,
    async grant(a: { amount: number }) {
      return { ok: true as const, coinsAfter: a.amount };
    },
  } as unknown as CommercialClient;
}

function makeCols(saveDoc?: FakeSaveDoc) {
  const saves = new FakeCollection<FakeSaveDoc>();
  if (saveDoc) saves.seed(saveDoc);
  const cols = {
    saves,
    accounts: new FakeCollection<{ _id: string }>(),
    cardInstances: new FakeCollection<{ _id: string }>(),
    events: new FakeCollection<{ _id: string }>(),
    eventParticipants: new FakeCollection<{ _id: string }>(),
    materialInstances: new FakeCollection<{ _id: string }>(),
  } as unknown as Collections;
  return { cols, saves };
}

function makeDeps(cols: Collections, overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    cols,
    jwt,
    now: () => NOW,
    commercial: makeCommercial(),
    gatewayPublicUrl: null,
    gateway: fakeGateway(),
    authRateLimit: 0,
    flags: null,
    wordlists: null,
    region: null,
    lokiPushUrl: null,
    // null (not nullMetaSocialsvcClient) — buildApp can never produce this, but ServiceDeps declares it
    // and the handlers' `?? nullMetaSocialsvcClient` fallbacks exist precisely for it.
    socialsvc: null,
    redis: null,
    accountCache: new AccountCache(),
    ...overrides,
  } as ServiceDeps;
}

/** A save document as written before `titles`/`titleGrants`/`equipped` existed (legacy account). */
function legacySaveDoc(): FakeSaveDoc {
  const save = makeNewSave(ACC, NOW);
  const loose = save as unknown as Record<string, unknown>;
  delete loose['titles'];
  delete loose['titleGrants'];
  delete loose['equipped'];
  return { _id: ACC, save, rev: save.rev };
}

/** Wraps a saves handle so every findOneAndUpdate misses — mutateSave burns its 4 attempts and reports REV_CONFLICT. */
function alwaysLosingSaves(saves: FakeCollection<FakeSaveDoc>) {
  return {
    findOne: saves.findOne.bind(saves),
    updateOne: saves.updateOne.bind(saves),
    findOneAndUpdate: async () => null,
  } as unknown as Collections['saves'];
}

function makeReply() {
  const sent: { code?: number; payload?: unknown } = {};
  const reply = {
    code(c: number) {
      sent.code = c;
      return reply;
    },
    send(p: unknown) {
      sent.payload = p;
      return reply;
    },
  };
  return { sent, reply: reply as unknown as FastifyReply };
}

function makeReq(body: unknown, headers: Record<string, string> = {}): FastifyRequest {
  return { accountId: ACC, body, headers, log: { warn() {} } } as unknown as FastifyRequest;
}

const errMessage = (payload: unknown) => (payload as { error: { message: string; code: string } }).error;

describe('liveops profile/achievements/events/lobbyBadges branch backfill (group E)', () => {
  // ── profile.ts ────────────────────────────────────────────────────────────────────────────────
  describe('profile.ts', () => {
    it('legacy save with no titles/equipped: GET /titles answers with an empty list and no equipped title (absent-field fallbacks)', async () => {
      const { cols } = makeCols(legacySaveDoc());
      const r = (await getTitlesHandler(makeDeps(cols), makeReq(null))) as { data: { titles: unknown[]; equipped: string | null } };
      expect(r.data.titles).toEqual([]);
      expect(r.data.equipped).toBeNull();
    });

    it('save with an equipped map that has no title key: GET /titles reports equipped: null', async () => {
      // Distinct from the legacy case above: `equipped` exists (e.g. only an avatar is equipped), so the
      // fallback that has to fire is the missing *title* key, not the missing map.
      const save = { ...makeNewSave(ACC, NOW), equipped: {} as Record<string, string> };
      const { cols } = makeCols({ _id: ACC, save, rev: 0 });
      const r = (await getTitlesHandler(makeDeps(cols), makeReq(null))) as { data: { titles: unknown[]; equipped: string | null } };
      expect(r.data.titles.length).toBe(1); // the starter title is still owned
      expect(r.data.equipped).toBeNull();
    });

    it('unequip title on a legacy save with no equipped map: succeeds, equipped stays empty (not a crash, not NOT_OWNED)', async () => {
      const { cols } = makeCols(legacySaveDoc());
      const core = new MetaCore(makeDeps(cols));
      const { sent, reply } = makeReply();
      // titleId omitted entirely (the client's "clear my title" call) on a save whose `titles` and
      // `equipped` fields do not exist at all.
      const out = (await equipTitleHandler(core, makeReq({}), reply)) as { data: { save: SaveData } };
      expect(sent.code).toBeUndefined();
      expect(out.data.save.equipped).toEqual({});
    });

    it('title equip that loses every rev race -> 409 REV_CONFLICT (the player keeps the title they had)', async () => {
      const save = makeNewSave(ACC, NOW);
      const owned = save.titles![0]!; // the starter title, so the refusal below is the rev race and not NOT_OWNED
      const { cols, saves } = makeCols({ _id: ACC, save, rev: 0 });
      const core = new MetaCore(makeDeps({ ...cols, saves: alwaysLosingSaves(saves) } as Collections));
      const { sent, reply } = makeReply();
      await equipTitleHandler(core, makeReq({ titleId: owned }), reply);
      expect(sent.code).toBe(409);
      expect(errMessage(sent.payload).message).toBe('REV_CONFLICT');
    });

    it('unequip avatar on a legacy save with no equipped map: succeeds with an empty equipped map', async () => {
      const { cols } = makeCols(legacySaveDoc());
      const core = new MetaCore(makeDeps(cols));
      const { sent, reply } = makeReply();
      const out = (await equipAvatarHandler(core, makeReq({ avatarId: '' }), reply)) as { data: { save: SaveData } };
      expect(sent.code).toBeUndefined();
      expect(out.data.save.equipped).toEqual({});
    });

    it('avatar equip that loses every rev race -> 409 REV_CONFLICT', async () => {
      const { cols, saves } = makeCols({ _id: ACC, save: makeNewSave(ACC, NOW), rev: 0 });
      const core = new MetaCore(makeDeps({ ...cols, saves: alwaysLosingSaves(saves) } as Collections));
      const { sent, reply } = makeReply();
      await equipAvatarHandler(core, makeReq({ avatarId: '0' }), reply);
      expect(sent.code).toBe(409);
      expect(errMessage(sent.payload).message).toBe('REV_CONFLICT');
    });

    it('skin equip without unitType -> 400 (guard is shadowed by the route schema, so only reachable as a direct call)', async () => {
      const { cols } = makeCols({ _id: ACC, save: makeNewSave(ACC, NOW), rev: 0 });
      const core = new MetaCore(makeDeps(cols));
      const { sent, reply } = makeReply();
      await equipSkinHandler(core, makeReq({ skinId: 'skin_x' }), reply);
      expect(sent.code).toBe(400);
      expect(errMessage(sent.payload).message).toBe('unitType required');
    });

    it('skin unequip that loses every rev race -> 409 REV_CONFLICT', async () => {
      const { cols, saves } = makeCols({ _id: ACC, save: makeNewSave(ACC, NOW), rev: 0 });
      const core = new MetaCore(makeDeps({ ...cols, saves: alwaysLosingSaves(saves) } as Collections));
      const { sent, reply } = makeReply();
      await equipSkinHandler(core, makeReq({ unitType: 'infantry', skinId: null }), reply);
      expect(sent.code).toBe(409);
      expect(errMessage(sent.payload).message).toBe('REV_CONFLICT');
    });

    it('flag writes with a malformed key/value are refused with 400, never stored (each sub-condition of the guard)', async () => {
      const { cols, saves } = makeCols({ _id: ACC, save: makeNewSave(ACC, NOW), rev: 0 });
      const core = new MetaCore(makeDeps(cols));
      for (const bad of [
        { key: '', value: true }, // empty key
        { key: 'x'.repeat(101), value: true }, // over MAX_FLAG_KEY_LEN
        { key: 'featSeen.shop', value: 'yes' }, // non-boolean value
        { key: 'featSeen.shop' }, // value missing entirely
      ]) {
        const { sent, reply } = makeReply();
        await setFlagHandler(core, makeReq(bad), reply);
        expect(sent.code).toBe(400);
        expect(errMessage(sent.payload).message).toBe('invalid key/value');
      }
      expect((await saves.findOne({ _id: ACC }))?.save.flags).toEqual({});
    });

    it('flag write that loses every rev race -> 409 REV_CONFLICT', async () => {
      const { cols, saves } = makeCols({ _id: ACC, save: makeNewSave(ACC, NOW), rev: 0 });
      const core = new MetaCore(makeDeps({ ...cols, saves: alwaysLosingSaves(saves) } as Collections));
      const { sent, reply } = makeReply();
      await setFlagHandler(core, makeReq({ key: 'featSeen.shop', value: true }), reply);
      expect(sent.code).toBe(409);
      expect(errMessage(sent.payload).message).toBe('REV_CONFLICT');
    });
  });

  // ── achievements.ts ───────────────────────────────────────────────────────────────────────────
  describe('achievements.ts', () => {
    it('achievement claim that loses every rev race -> 409 REV_CONFLICT, no coins granted (tier stays unclaimed)', async () => {
      // Threshold is met, so validateClaim passes and the failure is purely the durable write losing
      // its race — the arm below NOT_REACHED/ALREADY_CLAIMED/BAD_REQUEST that no HTTP test reaches.
      const save = { ...makeNewSave(ACC, NOW), stats: { 'kill.archer': 9999 } };
      const { cols, saves } = makeCols({ _id: ACC, save, rev: 0 });
      let grants = 0;
      const commercial = {
        available: true,
        async grant() {
          grants++;
          return { ok: true as const, coinsAfter: 0 };
        },
      } as unknown as CommercialClient;
      const core = new MetaCore(makeDeps({ ...cols, saves: alwaysLosingSaves(saves) } as Collections, { commercial }));
      const { sent, reply } = makeReply();
      await claimAchievementHandler(core, makeReq({ achId: 'ach.kill.archer', tier: 1 }), reply);
      expect(sent.code).toBe(409);
      expect(errMessage(sent.payload).code).toBe('REV_CONFLICT');
      expect(grants).toBe(0);
      expect((await saves.findOne({ _id: ACC }))?.save.achievements ?? {}).toEqual({});
    });
  });

  // ── events.ts ─────────────────────────────────────────────────────────────────────────────────
  describe('events.ts', () => {
    it('claim with a missing rewardId -> 400 (guard is shadowed by the route schema)', async () => {
      const { cols } = makeCols();
      const { sent, reply } = makeReply();
      await claimEventRewardHandler(makeDeps(cols), makeReq({ eventId: 'ev1' }), reply);
      expect(sent.code).toBe(400);
      expect(errMessage(sent.payload).message).toBe('missing eventId/rewardId');
    });

    it('socialsvc not wired at all (deps.socialsvc === null): claim still answers, falling back to the null client', async () => {
      // buildApp always fills this field with nullMetaSocialsvcClient, so only a directly-constructed
      // ServiceDeps takes the handler's own `?? nullMetaSocialsvcClient` fallback. Unknown event -> 404,
      // which is as far as the claim gets before it would need socialsvc for a material payout.
      const { cols } = makeCols();
      const { sent, reply } = makeReply();
      await claimEventRewardHandler(makeDeps(cols, { socialsvc: null }), makeReq({ eventId: 'nope', rewardId: 'r1' }), reply);
      expect(sent.code).toBe(404);
      expect(errMessage(sent.payload).code).toBe('NOT_FOUND');
    });
  });

  // ── lobbyBadges.ts ────────────────────────────────────────────────────────────────────────────
  describe('lobbyBadges.ts', () => {
    it('request without an authorization header: the social proxy is still called, with an empty auth string', async () => {
      const { cols } = makeCols({ _id: ACC, save: makeNewSave(ACC, NOW), rev: 0 });
      const seenAuth: string[] = [];
      const socialsvc = {
        available: true,
        async proxy(_m: string, _p: string, _b: unknown, authorization: string) {
          seenAuth.push(authorization);
          return { status: 200, data: { ok: true, data: { friendRequests: 1, chat: 0, mail: 0, total: 1 } } };
        },
      };
      const r = (await getLobbyBadgesHandler(
        makeDeps(cols, { socialsvc: socialsvc as unknown as ServiceDeps['socialsvc'] }),
        makeReq(null, {}),
      )) as { data: { social: { total: number } } };
      expect(seenAuth).toEqual(['']);
      expect(r.data.social.total).toBe(1);
    });

    it('every degraded social slice (200 with no payload / 503 / socialsvc absent) yields zeroed counts, never undefined', async () => {
      const { cols } = makeCols({ _id: ACC, save: makeNewSave(ACC, NOW), rev: 0 });
      const ZERO = { friendRequests: 0, chat: 0, mail: 0, total: 0 };
      const degraded: Array<ServiceDeps['socialsvc']> = [
        // 200, but the body carries no `data` (socialsvc answered with a bare envelope).
        { available: true, async proxy() { return { status: 200, data: { ok: true } }; } } as unknown as ServiceDeps['socialsvc'],
        // socialsvc down: the lobby must still render, with the red dots off.
        { available: true, async proxy() { return { status: 503, data: { ok: false } }; } } as unknown as ServiceDeps['socialsvc'],
        null, // not wired at all -> the proxy call is skipped entirely
      ];
      for (const socialsvc of degraded) {
        const r = (await getLobbyBadgesHandler(makeDeps(cols, { socialsvc }), makeReq(null, { authorization: 'Bearer x' }))) as {
          data: { social: unknown; eventsAvailable: boolean };
        };
        expect(r.data.social).toEqual(ZERO);
        expect(r.data.eventsAvailable).toBe(false);
      }
    });
  });
});
