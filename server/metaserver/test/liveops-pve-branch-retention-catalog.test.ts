// Branch-coverage backfill for the four catalogue fallbacks in src/service/liveops/retention.ts
// (2026-09-03 branch-coverage task, group E): `(picked && CARD_DEFS[picked.itemId]) || <first def>` in
// settleCheckinReward's card/equipment branches and settleWeeklyChestReward's equipment/card branches.
//
// Why a module mock. Those `||` fallbacks exist because the pre-fix code silently DROPPED the reward
// when the gacha catalogue pick came back without a matching def (see retention.ts's own comment on the
// card branch) — a claimed milestone day that pays out nothing. Nothing a test can put in Mongo makes
// pickRandomCatalogItem miss; only the catalogue tables themselves could, so the pick is stubbed out
// here and the assertion is the point of the fallback: the milestone still delivers a real item.
// Kept in its own file so the mock cannot leak into the other group-E suites.
import { describe, expect, it, vi } from 'vitest';

// A pick that yields nothing at all (empty/misconfigured catalogue) — every other @nw/shared export is
// the real one.
vi.mock('@nw/shared', async () => {
  const actual = await vi.importActual<typeof import('@nw/shared')>('@nw/shared');
  return { ...actual, pickRandomCatalogItem: () => undefined };
});

const { makeNewSave, makeDayKey, makeMonthKey, makeWeekKey } = await import('@nw/shared');
type Collections = import('@nw/shared').Collections;
type SaveData = import('@nw/shared').SaveData;
const { MetaCore } = await import('../src/service/base.js');
type ServiceDeps = import('../src/service/base.js').ServiceDeps;
const { claimCheckinHandler, claimWeeklyChestHandler } = await import('../src/service/liveops/retention.js');
const { FakeCollection } = await import('./helpers/fakeCollection.js');
const { fakeGateway } = await import('./helpers/fakeClients.js');
const { AccountCache } = await import('../src/accountCache.js');
type CommercialClient = import('../src/commercialClient.js').CommercialClient;
type FastifyReply = import('fastify').FastifyReply;
type FastifyRequest = import('fastify').FastifyRequest;

const NOW = new Date('2026-04-20T12:00:00Z').getTime();
const YESTERDAY_KEY = makeDayKey(NOW - 24 * 3600 * 1000);
const ACC = 'acc-grpE-catalog';

interface FakeSaveDoc {
  _id: string;
  save: SaveData;
  rev: number;
}

function makeCore(save: SaveData) {
  const saves = new FakeCollection<FakeSaveDoc>().seed({ _id: ACC, save, rev: save.rev });
  const cols = {
    saves,
    accounts: new FakeCollection<{ _id: string }>(),
    equipmentInstances: new FakeCollection<{ _id: string }>(),
    cardInstances: new FakeCollection<{ _id: string }>(),
    materialInstances: new FakeCollection<{ _id: string }>(),
    equipmentIdem: new FakeCollection<{ _id: string }>(),
  } as unknown as Collections;
  const commercial = {
    available: true,
    async grant(a: { amount: number }) {
      return { ok: true as const, coinsAfter: a.amount };
    },
  } as unknown as CommercialClient;
  const deps = {
    cols, jwt: { secret: 'test-secret' }, now: () => NOW, commercial,
    gatewayPublicUrl: null, gateway: fakeGateway(), authRateLimit: 0,
    flags: null, wordlists: null, region: null, lokiPushUrl: null,
    socialsvc: null, redis: null, accountCache: new AccountCache(),
  } as ServiceDeps;
  return { core: new MetaCore(deps), cols, saves };
}

function makeReply() {
  const sent: { code?: number } = {};
  const reply = {
    code(c: number) { sent.code = c; return reply; },
    send() { return reply; },
  };
  return { sent, reply: reply as unknown as FastifyReply };
}

const req = (body: unknown = {}) => ({ accountId: ACC, body, headers: {}, log: { warn() {} } }) as unknown as FastifyRequest;

describe('retention.ts catalogue fallbacks when the item pick comes back empty (group E)', () => {
  it('check-in day 14 (card milestone) still grants a real card', async () => {
    const save: SaveData = {
      ...makeNewSave(ACC, NOW),
      retention: { checkin: { monthKey: makeMonthKey(NOW), claimedDays: [...Array(13).keys()].map((i) => i + 1), lastClaimedDayKey: YESTERDAY_KEY } },
    };
    const { core, cols } = makeCore(save);
    const { sent, reply } = makeReply();
    const out = (await claimCheckinHandler(core, req(), reply)) as { data: { day: number; reward: { kind: string; id?: string } } };
    expect(sent.code).toBeUndefined();
    expect(out.data.day).toBe(14);
    expect(out.data.reward.kind).toBe('card');
    expect(out.data.reward.id).toBeTruthy(); // a concrete defId, not a dropped reward
    expect((cols.cardInstances as unknown as { docs: Map<string, unknown> }).docs.size).toBe(1);
  });

  it('check-in day 30 (equipment finale) still grants a real equipment instance', async () => {
    const save: SaveData = {
      ...makeNewSave(ACC, NOW),
      retention: { checkin: { monthKey: makeMonthKey(NOW), claimedDays: [...Array(29).keys()].map((i) => i + 1), lastClaimedDayKey: YESTERDAY_KEY } },
    };
    const { core, cols } = makeCore(save);
    const { sent, reply } = makeReply();
    const out = (await claimCheckinHandler(core, req(), reply)) as { data: { day: number; reward: { kind: string; id?: string } } };
    expect(sent.code).toBeUndefined();
    expect(out.data.day).toBe(30);
    expect(out.data.reward.kind).toBe('equipment');
    expect(out.data.reward.id).toBeTruthy();
    expect((cols.equipmentInstances as unknown as { docs: Map<string, unknown> }).docs.size).toBe(1);
  });

  it('weekly chest tier 15 (equipment) still grants a real equipment instance', async () => {
    const save: SaveData = {
      ...makeNewSave(ACC, NOW),
      retention: { weekly: { weekKey: makeWeekKey(NOW), points: 21, claimedTiers: [] } },
    };
    const { core, cols } = makeCore(save);
    const { sent, reply } = makeReply();
    const out = (await claimWeeklyChestHandler(core, req({ threshold: 15 }), reply)) as { data: { reward: { kind: string; id?: string } } };
    expect(sent.code).toBeUndefined();
    expect(out.data.reward.kind).toBe('equipment');
    expect(out.data.reward.id).toBeTruthy();
    expect((cols.equipmentInstances as unknown as { docs: Map<string, unknown> }).docs.size).toBe(1);
  });

  it('weekly chest tier 21 (legendary card) falls back to an Anna-faction card rather than nothing', async () => {
    const save: SaveData = {
      ...makeNewSave(ACC, NOW),
      retention: { weekly: { weekKey: makeWeekKey(NOW), points: 21, claimedTiers: [] } },
    };
    const { core, cols } = makeCore(save);
    const { sent, reply } = makeReply();
    const out = (await claimWeeklyChestHandler(core, req({ threshold: 21 }), reply)) as { data: { reward: { kind: string; id?: string } } };
    expect(sent.code).toBeUndefined();
    expect(out.data.reward.kind).toBe('card');
    expect(out.data.reward.id).toBeTruthy();
    expect((cols.cardInstances as unknown as { docs: Map<string, unknown> }).docs.size).toBe(1);
  });
});
