// SE-5: verifies getLeaderboard serves the season Top-100 from a 60s in-process cache while the
// per-caller `me` standing stays live. No Mongo — a fake cols instruments query call counts.
import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { MetaService, type ServiceDeps } from '../src/service.js';

// A saves.find(...).sort().limit().project().toArray() chain that records how many times find() ran.
function makeCols(counters: { topFind: number; countDocs: number }) {
  const chain = {
    sort: () => chain,
    limit: () => chain,
    project: () => chain,
    toArray: async () => [
      { _id: 'a1', save: { pvp: { elo: 1500, rank: 'gold' }, equipped: { title: 't.master' } } },
      { _id: 'a2', save: { pvp: { elo: 1400, rank: 'silver' } } },
    ],
  };
  return {
    ladderSeasons: {
      findOne: async () => ({ _id: 'current', seasonNo: 7, startAt: 0, endAt: 1e12, state: 'active' }),
      updateOne: async () => ({}),
    },
    saves: {
      find: () => {
        counters.topFind++;
        return chain;
      },
      findOne: async () => ({ save: { pvp: { elo: 1450, rank: 'gold' } } }), // caller's own row
      countDocuments: async () => {
        counters.countDocs++;
        return 3; // 3 players above the caller → rank 4
      },
    },
    accounts: {
      find: () => ({
        toArray: async () => [
          { _id: 'a1', displayName: 'Alice', publicId: 'AAAA' },
          { _id: 'a2', displayName: 'Bob', publicId: 'BBBB' },
        ],
      }),
    },
  };
}

function makeService(nowRef: { t: number }, counters: { topFind: number; countDocs: number }) {
  const deps = {
    cols: makeCols(counters),
    now: () => nowRef.t,
    authRateLimit: 0,
    gatewayPublicUrl: null,
    flags: null,
    region: null,
    lokiPushUrl: null,
    socialsvc: null,
  } as unknown as ServiceDeps;
  return new MetaService(deps);
}

const reqOf = (accountId: string) => ({ accountId } as unknown as FastifyRequest);

describe('SE-5 leaderboard 60s process cache', () => {
  it('serves the Top-100 from cache within 60s but always recomputes `me`', async () => {
    const nowRef = { t: 1_000_000 };
    const counters = { topFind: 0, countDocs: 0 };
    const svc = makeService(nowRef, counters);

    const r1 = (await svc.getLeaderboard(reqOf('caller'))) as {
      data: { seasonNo: number; entries: unknown[]; me?: { rank: number } };
    };
    expect(r1.data.seasonNo).toBe(7);
    expect(r1.data.entries).toHaveLength(2);
    expect(r1.data.me).toEqual({ rank: 4, elo: 1450, pvpRank: 'gold' });
    expect(counters.topFind).toBe(1);
    expect(counters.countDocs).toBe(1);

    // Second call 30s later: Top-100 comes from cache (no new saves.find), but `me` is recomputed.
    nowRef.t += 30_000;
    await svc.getLeaderboard(reqOf('caller'));
    expect(counters.topFind).toBe(1); // still cached
    expect(counters.countDocs).toBe(2); // me recomputed

    // Third call past the 60s TTL: Top-100 is rebuilt.
    nowRef.t += 31_000; // 61s since first build
    await svc.getLeaderboard(reqOf('caller'));
    expect(counters.topFind).toBe(2); // cache expired → rebuilt
    expect(counters.countDocs).toBe(3);
  });

  it('rebuilds when the season changes even if the TTL has not elapsed', async () => {
    const nowRef = { t: 5_000_000 };
    const counters = { topFind: 0, countDocs: 0 };
    // Season number returned by ladderSeasons.findOne is mutable for this test.
    const seasonRef = { no: 7 };
    const deps = {
      cols: {
        ladderSeasons: {
          findOne: async () => ({ _id: 'current', seasonNo: seasonRef.no, startAt: 0, endAt: 1e12, state: 'active' }),
          updateOne: async () => ({}),
        },
        saves: {
          find: () => {
            counters.topFind++;
            return { sort: () => ({ limit: () => ({ project: () => ({ toArray: async () => [] }) }) }) };
          },
          findOne: async () => null, // caller has not played → no `me`
          countDocuments: async () => 0,
        },
        accounts: { find: () => ({ toArray: async () => [] }) },
      },
      now: () => nowRef.t,
      authRateLimit: 0,
      gatewayPublicUrl: null,
      flags: null,
      region: null,
      lokiPushUrl: null,
      socialsvc: null,
    } as unknown as ServiceDeps;
    const svc = new MetaService(deps);

    await svc.getLeaderboard(reqOf('caller'));
    expect(counters.topFind).toBe(1);

    // Same instant, but the season rolled → cache key mismatch forces a rebuild.
    seasonRef.no = 8;
    await svc.getLeaderboard(reqOf('caller'));
    expect(counters.topFind).toBe(2);
  });
});
