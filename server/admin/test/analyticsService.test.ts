// AnalyticsService branches: audit-visibility narrowing, time-range filter assembly, and the
// unavailable/validation guards on the player-lookup and anti-cheat surfaces.
//
// Why this file exists (2026-09-03 branch-coverage pass): analytics.ts printed 86% lines / 65%
// branches with 26 branches never executed — the largest single gap after validators.ts. The route
// e2e suites call every method, but always with a complete query string and always with all
// clients `available: true`, so what had never run was: the capability narrowing that decides
// whether a non-super operator sees other people's audit rows, all four ways a from/to window can
// be specified, the `?? ''` fallbacks on the three id inputs (httpApi forwards query params
// verbatim, so any of them can be absent), every `players`/`antiCheat`/`suspiciousPve`
// unavailable-503, and the ban-then-resolve ordering in resolveAntiCheatReview.
//
// The audit-visibility branch is the one worth having a test for on its own merits: `listAudit` is
// what enforces that an operator without `audit.view.all` can only ever see their own trail, and
// httpApi only checks the weaker `audit.view.self` before calling it.
import { describe, expect, it } from 'vitest';
import type { AnalyticsService } from '../src/service/analytics';
import type { Actor } from '../src/service/base';
import { domain, stubDeps, NOW } from './stubDeps';

const SUPER: Actor = { adminId: 'adm-1', username: 'root', displayName: 'Root', role: 'super' };
const SUPPORT: Actor = { adminId: 'adm-9', username: 'cs', displayName: 'CS', role: 'support' };

/** Minimal cursor supporting both `find(q).sort().limit().toArray()` and `find(q, opts).toArray()`. */
function cursor<T>(rows: T[]) {
  const self = {
    sort: () => self,
    limit: () => self,
    toArray: async () => rows,
  };
  return self;
}

interface Options {
  auditRows?: Array<{ _id: string; actor: string; action: string; target?: string; summary?: string; ip?: string; ts: number }>;
  accountRows?: Array<{ _id: string; displayName?: string; username?: string }>;
  metricRows?: Array<{ ts: number; value: number }>;
  playersAvailable?: boolean;
  antiCheatAvailable?: boolean;
  suspiciousPveAvailable?: boolean;
  analyticsAvailable?: boolean;
  player?: unknown;
  resetResult?: { ok: boolean; error?: string };
  banResult?: { ok: boolean };
  resolveResult?: { ok: boolean };
  live?: Record<string, number>;
}

function harness(o: Options = {}) {
  const queries: { audit?: unknown; metrics?: unknown } = {};
  const calls: string[] = [];
  const inserted: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`);
    switch (name) {
      case 'lookupByPublicId':
      case 'lookupByAccountId':
        return o.player;
      case 'search':
        return [{ accountId: 'acc-1' }];
      case 'resetPassword':
        return o.resetResult ?? { ok: true };
      case 'banAccount':
        return o.banResult ?? { ok: true };
      case 'listReviews':
        return [{ _id: 'r1' }, { _id: 'r2' }];
      case 'resolveReview':
        return o.resolveResult ?? { ok: true };
      case 'query':
        return { rows: [{ day: '2026-09-01' }] };
      default:
        return undefined;
    }
  };
  const { deps, audits } = stubDeps({
    players: {
      available: o.playersAvailable ?? true,
      lookupByPublicId: record('lookupByPublicId'),
      lookupByAccountId: record('lookupByAccountId'),
      search: record('search'),
      resetPassword: record('resetPassword'),
    },
    antiCheat: {
      available: o.antiCheatAvailable ?? true,
      listReviews: record('listReviews'),
      resolveReview: record('resolveReview'),
    },
    suspiciousPve: { available: o.suspiciousPveAvailable ?? true, banAccount: record('banAccount') },
    analytics: { available: o.analyticsAvailable ?? true, query: record('query') },
    stats: {
      available: true,
      fetchLive: async () => o.live ?? { online: 3, queue: 1, rooms: 2, gameInstances: 1, gameLoad: 0.5 },
    },
    cols: {
      auditLog: {
        find: (q: unknown) => {
          queries.audit = q;
          return cursor(o.auditRows ?? []);
        },
      },
      adminAccounts: { find: () => cursor(o.accountRows ?? []) },
      metricSnapshots: {
        find: (q: unknown) => {
          queries.metrics = q;
          return cursor(o.metricRows ?? []);
        },
        insertMany: async (docs: unknown[]) => {
          inserted.push(docs);
          return { acknowledged: true };
        },
      },
    },
  });
  return { svc: domain<AnalyticsService>(deps, 'analytics'), audits, queries, calls, inserted };
}

describe('listAudit visibility', () => {
  const ROWS = [
    { _id: 'a1', actor: 'adm-1', action: 'account.create', ts: 10 },
    { _id: 'a2', actor: 'adm-9', action: 'player.search', ts: 9 },
  ];

  it('a role with audit.view.all and no actor filter queries unrestricted', async () => {
    const h = harness({ auditRows: ROWS });
    await h.svc.listAudit(SUPER, {});
    expect(h.queries.audit).toEqual({});
  });

  it('a role with audit.view.all may filter by another actor', async () => {
    const h = harness({ auditRows: ROWS });
    await h.svc.listAudit(SUPER, { actor: 'adm-9' });
    expect(h.queries.audit).toEqual({ actor: 'adm-9' });
  });

  // The capability check is the whole point: a support operator asking for somebody else's trail
  // must silently get their own, not the one they asked for.
  it('a role without audit.view.all is forced onto its own entries, even when it asks for another actor', async () => {
    const h = harness({ auditRows: ROWS });
    await h.svc.listAudit(SUPPORT, { actor: 'adm-1' });
    expect(h.queries.audit).toEqual({ actor: 'adm-9' });
  });

  it('builds the ts window from whichever bound was supplied', async () => {
    const both = harness();
    await both.svc.listAudit(SUPER, { from: 1, to: 2 });
    expect(both.queries.audit).toEqual({ ts: { $gte: 1, $lte: 2 } });

    const fromOnly = harness();
    await fromOnly.svc.listAudit(SUPER, { from: 1 });
    expect(fromOnly.queries.audit).toEqual({ ts: { $gte: 1 } });

    const toOnly = harness();
    await toOnly.svc.listAudit(SUPER, { to: 2 });
    expect(toOnly.queries.audit).toEqual({ ts: { $lte: 2 } });
  });

  it('attaches actorName only for actors that resolve to an admin account', async () => {
    const h = harness({ auditRows: ROWS, accountRows: [{ _id: 'adm-1', displayName: 'Root' }] });
    const rows = await h.svc.listAudit(SUPER, {});
    expect(rows[0]).toMatchObject({ actor: 'adm-1', actorName: 'Root' });
    // adm-9 has no account document (deleted operator, or an `unknown:` synthetic actor).
    expect(rows[1]).not.toHaveProperty('actorName');
  });

  it('passes target/summary/ip through only when the stored row has them', async () => {
    const h = harness({
      auditRows: [
        { _id: 'a1', actor: 'adm-1', action: 'account.create', target: 'adm-2', summary: 'x (ops)', ip: '1.2.3.4', ts: 10 },
        { _id: 'a2', actor: 'adm-1', action: 'anticheat.view', ts: 9 },
      ],
    });
    const rows = await h.svc.listAudit(SUPER, {});
    expect(rows[0]).toMatchObject({ target: 'adm-2', summary: 'x (ops)', ip: '1.2.3.4' });
    expect(Object.keys(rows[1]!).sort()).toEqual(['action', 'actor', 'id', 'ts']);
  });
});

describe('trend', () => {
  it('rejects a metric that is not in METRIC_KEYS', async () => {
    await expect(harness().svc.trend({ metric: 'cpu' })).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    });
  });

  it('queries by metric alone when no window was given', async () => {
    const h = harness();
    await h.svc.trend({ metric: 'online' });
    expect(h.queries.metrics).toEqual({ metric: 'online' });
  });

  it('builds the ts window from whichever bound was supplied', async () => {
    const both = harness();
    await both.svc.trend({ metric: 'online', from: 1, to: 2 });
    expect(both.queries.metrics).toEqual({ metric: 'online', ts: { $gte: 1, $lte: 2 } });

    const fromOnly = harness();
    await fromOnly.svc.trend({ metric: 'queue', from: 1 });
    expect(fromOnly.queries.metrics).toEqual({ metric: 'queue', ts: { $gte: 1 } });

    const toOnly = harness();
    await toOnly.svc.trend({ metric: 'rooms', to: 2 });
    expect(toOnly.queries.metrics).toEqual({ metric: 'rooms', ts: { $lte: 2 } });
  });

  it('maps snapshots down to ts/value pairs', async () => {
    const h = harness({ metricRows: [{ ts: 1, value: 5 }] });
    expect(await h.svc.trend({ metric: 'online' })).toEqual([{ ts: 1, value: 5 }]);
  });
});

describe('analyticsQuery with analyticsvc unreachable', () => {
  it('reports available:false instead of throwing, and never calls the client', async () => {
    const h = harness({ analyticsAvailable: false });
    expect(await h.svc.analyticsQuery('dau', 7)).toEqual({ available: false });
    expect(h.calls).toEqual([]);
  });

  it('marks a served result available:true and forwards the optional platform', async () => {
    const h = harness();
    expect(await h.svc.analyticsQuery('dau', 7, 'wechat')).toEqual({
      rows: [{ day: '2026-09-01' }],
      available: true,
    });
    expect(h.calls).toEqual(['query("dau",7,"wechat")']);
  });
});

describe('player lookup guards', () => {
  it('lookupPlayer requires exactly 9 digits — a missing id included', async () => {
    const h = harness();
    for (const pid of [undefined as unknown as string, '', '  ', '12345', '1234567890', 'abcdefghi']) {
      await expect(h.svc.lookupPlayer(pid)).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    }
    expect(h.calls).toEqual([]);
  });

  it('lookupPlayer 503s when the player backend is unconfigured, and 404s when nothing matched', async () => {
    await expect(harness({ playersAvailable: false }).svc.lookupPlayer('123456789')).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    });
    await expect(harness({ player: null }).svc.lookupPlayer('123456789')).rejects.toMatchObject({ status: 404 });
  });

  it('lookupPlayer trims and forwards a valid publicId', async () => {
    const h = harness({ player: { accountId: 'acc-1' } });
    expect(await h.svc.lookupPlayer(' 123456789 ')).toEqual({ accountId: 'acc-1' });
    expect(h.calls).toEqual(['lookupByPublicId("123456789")']);
  });

  it('lookupPlayerByAccountId requires a non-blank id, then 503/404 in the same order', async () => {
    const h = harness();
    for (const id of [undefined as unknown as string, '', '   ']) {
      await expect(h.svc.lookupPlayerByAccountId(id)).rejects.toThrowError(/accountId required/);
    }
    await expect(harness({ playersAvailable: false }).svc.lookupPlayerByAccountId('acc-1')).rejects.toMatchObject({
      status: 503,
    });
    await expect(harness({ player: null }).svc.lookupPlayerByAccountId('acc-1')).rejects.toMatchObject({ status: 404 });

    const ok = harness({ player: { accountId: 'acc-1' } });
    expect(await ok.svc.lookupPlayerByAccountId(' acc-1 ')).toEqual({ accountId: 'acc-1' });
    expect(ok.calls).toEqual(['lookupByAccountId("acc-1")']);
  });
});

describe('searchPlayers', () => {
  it('requires at least two characters — a missing query included', async () => {
    const h = harness();
    for (const q of [undefined as unknown as string, '', 'a', ' b ']) {
      await expect(h.svc.searchPlayers('adm-1', q)).rejects.toThrowError(/query too short/);
    }
    expect(h.audits).toEqual([]);
  });

  it('503s on an unconfigured backend before auditing anything', async () => {
    const h = harness({ playersAvailable: false });
    await expect(h.svc.searchPlayers('adm-1', 'tao')).rejects.toMatchObject({ status: 503 });
    expect(h.audits).toEqual([]);
  });

  it('audits the trimmed term and the hit count', async () => {
    const h = harness();
    expect(await h.svc.searchPlayers('adm-1', '  tao  ')).toEqual([{ accountId: 'acc-1' }]);
    expect(h.calls).toEqual(['search("tao",20)']);
    expect(h.audits).toEqual([
      expect.objectContaining({ action: 'player.search', summary: 'q=tao → 1 hits', ts: NOW }),
    ]);
  });
});

describe('resetPlayerPassword', () => {
  it('checks the id, then the password, then the backend — in that order', async () => {
    const h = harness();
    for (const id of [undefined as unknown as string, '', '  ']) {
      await expect(h.svc.resetPlayerPassword('adm-1', id, 'hunter2!')).rejects.toThrowError(/accountId required/);
    }
    await expect(h.svc.resetPlayerPassword('adm-1', 'acc-1', 'abc')).rejects.toMatchObject({
      status: 400,
      message: 'password too short (min 6)',
    });
    await expect(
      harness({ playersAvailable: false }).svc.resetPlayerPassword('adm-1', 'acc-1', 'hunter2!'),
    ).rejects.toMatchObject({ status: 503 });
    expect(h.calls).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('surfaces the backend refusal as 409 reset_failed and writes no audit row', async () => {
    const h = harness({ resetResult: { ok: false, error: 'account is banned' } });
    await expect(h.svc.resetPlayerPassword('adm-1', 'acc-1', 'hunter2!')).rejects.toMatchObject({
      status: 409,
      code: 'reset_failed',
      message: 'account is banned',
    });
    expect(h.audits).toEqual([]);
  });

  it('audits a successful reset against the trimmed accountId', async () => {
    const h = harness();
    await h.svc.resetPlayerPassword('adm-1', ' acc-1 ', 'hunter2!');
    expect(h.calls).toEqual(['resetPassword("acc-1","hunter2!")']);
    expect(h.audits).toEqual([
      expect.objectContaining({ action: 'player.password_reset', target: 'acc-1' }),
    ]);
  });
});

describe('listAntiCheatReviews', () => {
  it('503s when the anti-cheat backend is unconfigured', async () => {
    const h = harness({ antiCheatAvailable: false });
    await expect(h.svc.listAntiCheatReviews('adm-1')).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    expect(h.audits).toEqual([]);
  });

  it('defaults the audited status to "open" and omits target when no accountId was filtered on', async () => {
    const h = harness();
    await h.svc.listAntiCheatReviews('adm-1');
    expect(h.audits[0]).toMatchObject({ action: 'anticheat.view', summary: '2 reviews (status=open)' });
    expect(h.audits[0]).not.toHaveProperty('target');
  });

  it('records the accountId as the audit target and the explicit status', async () => {
    const h = harness();
    await h.svc.listAntiCheatReviews('adm-1', { accountId: 'acc-1', status: 'resolved', limit: 5 });
    expect(h.audits[0]).toMatchObject({ target: 'acc-1', summary: '2 reviews (status=resolved)' });
    expect(h.calls).toEqual(['listReviews({"accountId":"acc-1","status":"resolved","limit":5})']);
  });
});

describe('resolveAntiCheatReview', () => {
  it('503s when the anti-cheat backend is unconfigured', async () => {
    const h = harness({ antiCheatAvailable: false });
    await expect(h.svc.resolveAntiCheatReview('adm-1', 'r1', 'acc-1', 'dismissed')).rejects.toMatchObject({
      status: 503,
    });
    expect(h.calls).toEqual([]);
  });

  // A "banned" resolution needs BOTH backends. Resolving the review while the ban never landed
  // would close the queue item and leave the account playing — so the ban goes first and its
  // failure aborts the whole thing.
  it('a ban resolution 503s when the ban backend is unconfigured, without resolving the review', async () => {
    const h = harness({ suspiciousPveAvailable: false });
    await expect(h.svc.resolveAntiCheatReview('adm-1', 'r1', 'acc-1', 'banned')).rejects.toMatchObject({
      status: 503,
      message: 'ban backend unavailable',
    });
    expect(h.calls).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('a failed ban aborts with 502 before the review is resolved', async () => {
    const h = harness({ banResult: { ok: false } });
    await expect(h.svc.resolveAntiCheatReview('adm-1', 'r1', 'acc-1', 'banned')).rejects.toMatchObject({
      status: 502,
      code: 'ban_failed',
    });
    expect(h.calls).toEqual(['banAccount("acc-1")']);
    expect(h.audits).toEqual([]);
  });

  it('a dismissal never touches the ban backend and audits anticheat.review.resolve', async () => {
    const h = harness();
    await h.svc.resolveAntiCheatReview('adm-1', 'r1', 'acc-1', 'dismissed');
    expect(h.calls).toEqual(['resolveReview("r1","dismissed","adm-1")']);
    expect(h.audits[0]).toMatchObject({
      action: 'anticheat.review.resolve',
      target: 'acc-1',
      summary: 'review r1 → dismissed',
    });
  });

  it('a ban resolution bans first, then resolves, and audits as account.ban', async () => {
    const h = harness();
    await h.svc.resolveAntiCheatReview('adm-1', 'r1', 'acc-1', 'banned');
    expect(h.calls).toEqual(['banAccount("acc-1")', 'resolveReview("r1","banned","adm-1")']);
    expect(h.audits[0]).toMatchObject({ action: 'account.ban', target: 'acc-1' });
  });

  it('404s when the review id no longer exists', async () => {
    const h = harness({ resolveResult: { ok: false } });
    await expect(h.svc.resolveAntiCheatReview('adm-1', 'r9', 'acc-1', 'dismissed')).rejects.toMatchObject({
      status: 404,
    });
    expect(h.audits).toEqual([]);
  });
});

describe('sampleOnce', () => {
  it('writes one snapshot per metric key', async () => {
    const h = harness();
    await h.svc.sampleOnce();
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toEqual([
      { metric: 'online', ts: NOW, value: 3, at: new Date(NOW) },
      { metric: 'queue', ts: NOW, value: 1, at: new Date(NOW) },
      { metric: 'rooms', ts: NOW, value: 2, at: new Date(NOW) },
      { metric: 'gameInstances', ts: NOW, value: 1, at: new Date(NOW) },
      { metric: 'gameLoad', ts: NOW, value: 0.5, at: new Date(NOW) },
    ]);
  });

  // gameLoad is the one optional field on LiveStats — a gameserver that does not report it must
  // sample as 0, not as `undefined`, or the trend chart gets a hole rather than a floor.
  it('records gameLoad as 0 when the live stats omit it', async () => {
    const h = harness({ live: { online: 0, queue: 0, rooms: 0, gameInstances: 0 } });
    await h.svc.sampleOnce();
    expect(h.inserted[0]).toContainEqual({ metric: 'gameLoad', ts: NOW, value: 0, at: new Date(NOW) });
  });
});
