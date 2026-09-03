// The `!client.available` degrade branches of the thin proxy domains: ladder, gacha, mapTemplates,
// paddleEvents, appeals — plus AdminError's default message and FlagsService's document assembly.
//
// Why this file exists (2026-09-03 branch-coverage pass): these domains sit at or near 100% LINE
// coverage — the route e2e suites drive every method — but their fakes are always
// `available: true`, so the other side of every `available` guard had never run. That is exactly
// the shape promo.test.ts was written for on 2026-08-20 (see its header); this file finishes the
// job for the remaining five domains. What the branches decide is not cosmetic: each domain picks
// deliberately between degrading quietly (a read whose empty result still lets the ops console
// render) and failing loudly with its own 503 code (a write, where "nothing happened" must not look
// like success), and nothing pinned which method does which when a backend URL is unset.
//
// No Mongo: every assertion here returns or throws before touching a collection, except the flags
// group, which stubs the two calls it makes. Same stub-core precedent as promo.test.ts.
import { describe, expect, it } from 'vitest';
import type { FeatureFlagDoc } from '@nw/shared';
import type { AppealsService } from '../src/service/appeals';
import type { FlagsService } from '../src/service/flags';
import type { GachaService } from '../src/service/gacha';
import type { LadderService } from '../src/service/ladder';
import type { MapTemplatesService } from '../src/service/mapTemplates';
import type { PaddleEventsService } from '../src/service/paddleEvents';
import type { Actor } from '../src/service/base';
import { AdminError } from '../src/service/errors';
import { domain, stubDeps, NOW } from './stubDeps';

const ACTOR: Actor = { adminId: 'adm-1', username: 'root', displayName: 'Root', role: 'super' };

/** A client stub that records every call, so "degraded" can be asserted as "never reached the backend". */
function spy(available: boolean, results: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return new Proxy(
    { available },
    {
      get(t, prop: string) {
        if (prop === 'available') return t.available;
        if (prop === 'calls') return calls;
        return async (...args: unknown[]) => {
          calls.push(`${prop}(${args.map((a) => JSON.stringify(a)).join(',')})`);
          return results[prop];
        };
      },
    },
  ) as unknown as { available: boolean } & Record<string, (...a: unknown[]) => Promise<unknown>> & { calls: string[] };
}

describe('AdminError', () => {
  it('falls back to the code as the message when no message was given', () => {
    const e = new AdminError(503, 'unavailable');
    expect(e.message).toBe('unavailable');
    expect(e.name).toBe('AdminError');
    expect(e).toBeInstanceOf(Error);
  });

  it('keeps an explicit message', () => {
    expect(new AdminError(400, 'bad_request', 'reason required').message).toBe('reason required');
  });
});

describe('LadderService with its backends unreachable', () => {
  // Every ladder read degrades to an empty/null value: the anti-cheat and season panels are
  // side-panels on the ops dashboard, and a 503 from any of them would blank the whole page.
  function ladder(available: boolean) {
    const clients = {
      ladder: spy(available, { getCurrentSeason: { seasonNo: 4 }, rollSeason: { seasonNo: 5 } }),
      mismatches: spy(available, { listMismatches: [{ matchId: 'm1' }] }),
      pvpCardStats: spy(available, { listPvpCardStats: [{ cardId: 'c1' }] }),
      suspiciousPve: spy(available, { listSuspiciousPve: [{ accountId: 'a1' }], banAccount: { ok: true }, unbanAccount: { ok: true } }),
    };
    const { deps, audits } = stubDeps(clients);
    return { svc: domain<LadderService>(deps, 'ladder'), audits, clients };
  }

  it('getLadderCurrentSeason returns null and never calls the client', async () => {
    const h = ladder(false);
    expect(await h.svc.getLadderCurrentSeason()).toBeNull();
    expect(h.clients.ladder.calls).toEqual([]);
  });

  it('the three list reads return an empty array and never call their client', async () => {
    const h = ladder(false);
    expect(await h.svc.listMismatches()).toEqual([]);
    expect(await h.svc.listPvpCardStats({})).toEqual([]);
    expect(await h.svc.listSuspiciousPve()).toEqual([]);
    expect(h.clients.mismatches.calls).toEqual([]);
    expect(h.clients.pvpCardStats.calls).toEqual([]);
    expect(h.clients.suspiciousPve.calls).toEqual([]);
  });

  // ban/unban are the one pair here that mutates. They still do not throw — the ops UI reads `ok`
  // and shows "failed" — but `ok: false` must be what an unconfigured backend yields, never `true`.
  it('banAccount/unbanAccount report ok:false rather than claiming success', async () => {
    const h = ladder(false);
    expect(await h.svc.banAccount('acc-1')).toEqual({ ok: false });
    expect(await h.svc.unbanAccount('acc-1')).toEqual({ ok: false });
    expect(h.clients.suspiciousPve.calls).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('passes everything through to the clients once they are available', async () => {
    const h = ladder(true);
    expect(await h.svc.getLadderCurrentSeason()).toEqual({ seasonNo: 4 });
    expect(await h.svc.listMismatches()).toEqual([{ matchId: 'm1' }]);
    expect(await h.svc.listPvpCardStats({ mode: 'ranked', since: '2026-09-01' })).toEqual([{ cardId: 'c1' }]);
    expect(await h.svc.listSuspiciousPve()).toEqual([{ accountId: 'a1' }]);
    expect(await h.svc.banAccount('acc-1')).toEqual({ ok: true });
    expect(await h.svc.unbanAccount('acc-1')).toEqual({ ok: true });
    expect(h.clients.pvpCardStats.calls).toEqual(['listPvpCardStats({"mode":"ranked","since":"2026-09-01"})']);
  });

  // rollSeason is the one ladder method with NO `available` guard — a season roll is an explicit,
  // audited operator action, so a misconfigured deployment must surface the client's own error
  // rather than silently pretending a season was rolled.
  it('rollLadderSeason audits the new season number', async () => {
    const h = ladder(true);
    expect(await h.svc.rollLadderSeason('adm-1')).toEqual({ seasonNo: 5 });
    expect(h.audits).toEqual([
      expect.objectContaining({ actor: 'adm-1', action: 'ladder.season.roll', summary: '→ s5', ts: NOW }),
    ]);
  });
});

describe('GachaService with meta unreachable', () => {
  function gacha(available: boolean) {
    const gachaPools = spy(available, { list: [{ id: 'p1' }], createCustom: { id: 'p2' }, close: { id: 'p1' } });
    const { deps, audits } = stubDeps({ gachaPools });
    return { svc: domain<GachaService>(deps, 'gacha'), audits, gachaPools };
  }

  it('listGachaPools degrades to an empty list', async () => {
    const h = gacha(false);
    expect(await h.svc.listGachaPools()).toEqual([]);
    expect(h.gachaPools.calls).toEqual([]);
  });

  // The two writes fail loudly with `gacha_unavailable` rather than the client's generic 502, so the
  // operator is told the deployment is misconfigured instead of that their pool config was rejected.
  it('createCustomPool and closeGachaPool throw 503 gacha_unavailable, write no audit row, and never call meta', async () => {
    const h = gacha(false);
    for (const call of [
      () => h.svc.createCustomPool(ACTOR, { name: 'spring' } as never),
      () => h.svc.closeGachaPool(ACTOR, 'p1'),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 503, code: 'gacha_unavailable' });
      await expect(call()).rejects.toBeInstanceOf(AdminError);
    }
    expect(h.audits).toEqual([]);
    expect(h.gachaPools.calls).toEqual([]);
  });

  it('gachaCatalog is computed locally and works even with meta down', async () => {
    // comm-audit batch F item 10: the catalogue is a pure function over @nw/shared's static table,
    // so it must NOT inherit the unavailable-503 the two writes get.
    const cat = await gacha(false).svc.gachaCatalog();
    expect(Object.keys(cat).length).toBeGreaterThan(0);
  });

  it('audits pool create/close with the id meta returned', async () => {
    const h = gacha(true);
    await h.svc.createCustomPool(ACTOR, { name: 'spring' } as never);
    await h.svc.closeGachaPool(ACTOR, 'p1');
    expect(h.audits.map((a) => [a.action, a.target, a.summary])).toEqual([
      ['gacha.pool.create', 'p2', 'spring'],
      ['gacha.pool.close', 'p1', undefined],
    ]);
  });
});

describe('MapTemplatesService with worldsvc unreachable', () => {
  function maps(available: boolean) {
    const world = spy(available, {
      listMapTemplates: [{ templateId: 't1' }],
      getMapTemplateTiles: [{ x: 0, y: 0 }],
      getMapTemplateCities: [{ id: 'c1' }],
    });
    const { deps } = stubDeps({ world });
    return { svc: domain<MapTemplatesService>(deps, 'mapTemplates'), world };
  }

  // The three map-editor READS degrade to empty so the editor opens on a blank canvas instead of an
  // error dialog; the mutating methods (generate/save/activate/delete) have no guard at all and let
  // worldsvc's own error surface — an operator must not be told a save succeeded when it did not.
  it('the three reads return an empty array and never call worldsvc', async () => {
    const h = maps(false);
    expect(await h.svc.slgListMapTemplates()).toEqual([]);
    expect(await h.svc.slgGetMapTemplateTiles('t1', 0, 0, 8, 8)).toEqual([]);
    expect(await h.svc.slgGetMapTemplateCities('t1')).toEqual([]);
    expect(h.world.calls).toEqual([]);
  });

  it('passes the viewport bbox through unchanged once worldsvc is available', async () => {
    const h = maps(true);
    expect(await h.svc.slgGetMapTemplateTiles('t1', 4, 5, 8, 9)).toEqual([{ x: 0, y: 0 }]);
    expect(h.world.calls).toEqual(['getMapTemplateTiles("t1",4,5,8,9)']);
  });
});

describe('PaddleEventsService with commercial unreachable', () => {
  it('listPaddleEvents degrades to an empty list instead of throwing', async () => {
    const paddleEvents = spy(false, { list: [{ transactionId: 'txn_1' }] });
    const { deps } = stubDeps({ paddleEvents });
    const svc = domain<PaddleEventsService>(deps, 'paddleEvents');
    expect(await svc.listPaddleEvents({ accountId: 'acc-1' })).toEqual([]);
    expect(paddleEvents.calls).toEqual([]);
  });

  it('forwards the support-lookup filter once commercial is available', async () => {
    const paddleEvents = spy(true, { list: [{ transactionId: 'txn_1' }] });
    const { deps } = stubDeps({ paddleEvents });
    const svc = domain<PaddleEventsService>(deps, 'paddleEvents');
    expect(await svc.listPaddleEvents({ transactionId: 'txn_1', limit: 10 })).toEqual([{ transactionId: 'txn_1' }]);
    expect(paddleEvents.calls).toEqual(['list({"transactionId":"txn_1","limit":10})']);
  });
});

describe('AppealsService with metaserver unreachable', () => {
  function appeals(available: boolean, resolveResult: { ok: boolean } = { ok: true }) {
    const client = spy(available, { listAppeals: [{ _id: 'ap-1' }], resolveAppeal: resolveResult });
    const { deps, audits } = stubDeps({ appeals: client });
    return { svc: domain<AppealsService>(deps, 'appeals'), audits, client };
  }

  // Both appeal methods fail loudly — unlike the ladder/gacha reads. An appeal queue that renders
  // as "no appeals" when the backend is simply unreachable would look like there is nothing to do.
  it('listAppeals and resolveAppeal both throw 503 unavailable and never call meta', async () => {
    const h = appeals(false);
    await expect(h.svc.listAppeals('adm-1')).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    await expect(h.svc.resolveAppeal(ACTOR, 'ap-1', 'approved')).rejects.toMatchObject({ status: 503 });
    expect(h.client.calls).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('defaults the audited status filter to "open" when the caller passed no options', async () => {
    const h = appeals(true);
    await h.svc.listAppeals('adm-1');
    expect(h.audits).toEqual([
      expect.objectContaining({ action: 'appeal.review', summary: '1 appeals (status=open)' }),
    ]);
  });

  it('records the explicit status filter when one was given', async () => {
    const h = appeals(true);
    await h.svc.listAppeals('adm-1', { status: 'denied', limit: 5 });
    expect(h.audits[0]).toMatchObject({ summary: '1 appeals (status=denied)' });
    expect(h.client.calls).toEqual(['listAppeals({"status":"denied","limit":5})']);
  });

  it('maps a resolve miss to 404 and audits only a resolve that actually landed', async () => {
    const miss = appeals(true, { ok: false });
    await expect(miss.svc.resolveAppeal(ACTOR, 'ap-9', 'denied')).rejects.toMatchObject({ status: 404 });
    expect(miss.audits).toEqual([]);

    const hit = appeals(true);
    await hit.svc.resolveAppeal(ACTOR, 'ap-1', 'approved', 'first offence');
    expect(hit.audits[0]).toMatchObject({ target: 'ap-1', summary: 'appeal ap-1 → approved' });
    expect(hit.client.calls).toEqual(['resolveAppeal("ap-1","approved","adm-1","first offence")']);
  });
});

describe('FlagsService.upsertFlag document assembly', () => {
  function flags(before: FeatureFlagDoc | null = null) {
    const written: FeatureFlagDoc[] = [];
    const { deps, audits } = stubDeps({
      cols: {
        featureFlags: {
          findOne: async () => before,
          replaceOne: async (_f: unknown, doc: FeatureFlagDoc) => {
            written.push(doc);
            return { acknowledged: true };
          },
        },
      },
    });
    return { svc: domain<FlagsService>(deps, 'flags'), audits, written };
  }

  it('rejects a key that is not on the allowlist', async () => {
    const h = flags();
    await expect(h.svc.upsertFlag(ACTOR, 'not_a_flag', { enabled: true })).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    });
    expect(h.written).toEqual([]);
  });

  it('omits rollout and desc entirely when neither was supplied', async () => {
    const h = flags();
    const doc = await h.svc.upsertFlag(ACTOR, 'client_log_info', { enabled: false });
    expect(doc).toEqual({ _id: 'client_log_info', enabled: false, updatedAt: NOW, updatedBy: 'adm-1' });
    expect(doc).not.toHaveProperty('rollout');
    expect(doc).not.toHaveProperty('desc');
  });

  it('omits a rollout that validated down to nothing, and a desc that is blank or not a string', async () => {
    const h = flags();
    const doc = await h.svc.upsertFlag(ACTOR, 'client_log_info', { rollout: { regions: [] }, desc: '   ' });
    expect(doc).not.toHaveProperty('rollout');
    expect(doc).not.toHaveProperty('desc');
    const doc2 = await h.svc.upsertFlag(ACTOR, 'client_log_info', { desc: 7 as unknown as string });
    expect(doc2).not.toHaveProperty('desc');
  });

  it('stores a populated rollout and a trimmed desc, and audits the before → after transition', async () => {
    const h = flags({ _id: 'client_log_debug', enabled: false, updatedAt: 1, updatedBy: 'adm-0' });
    const doc = await h.svc.upsertFlag(ACTOR, 'client_log_debug', {
      rollout: { pct: 5, allowPublicIds: ['123456789'] },
      desc: '  targeted debug  ',
    });
    expect(doc).toMatchObject({
      enabled: true, // absent `enabled` defaults to on; only an explicit false turns a flag off
      rollout: { pct: 5, allowPublicIds: ['123456789'] },
      desc: 'targeted debug',
    });
    expect(h.written).toEqual([doc]);
    expect(h.audits[0]).toMatchObject({
      action: 'config.update',
      target: 'client_log_debug',
      summary: 'OFF → on,5%,allowPid=1',
    });
  });
});
