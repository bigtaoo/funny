// Client log targeted collection (FEATURE_FLAGS_DESIGN §9): Loki payload assembly + public bootstrap "diff-only response"
// + /client/log targeting guard. Pure logic, no database connection (cols uses a stub).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FeatureFlagCache } from '@nw/shared';
import { buildLokiPayload, buildAnomalyLokiPayload } from '../src/clientLog';
import { MetaService } from '../src/service';

// ── buildLokiPayload (§9.4 Loki ingestion convention) ─────────────────────────────────────
describe('buildLokiPayload', () => {
  it('routes by level; labels are source/level only; publicId included inline (logfmt)', () => {
    const p = buildLokiPayload(
      '123456789',
      [
        { level: 'error', msg: 'boom', ts: 1000, tag: 'gateway' },
        { level: 'info', msg: 'hi there', ts: 2000 },
      ],
      'web',
      () => '0',
    )!;
    expect(p.streams).toHaveLength(2);
    const err = p.streams.find((s) => s.stream.level === 'error')!;
    expect(err.stream).toEqual({ source: 'client', level: 'error' });
    // ts(ms)→ns: 1000ms = 1_000_000_000ns
    expect(err.values[0][0]).toBe('1000000000');
    expect(err.values[0][1]).toContain('publicId=123456789');
    expect(err.values[0][1]).toContain('tag=gateway');
    expect(err.values[0][1]).toContain('msg=boom');
    // msg containing spaces is quoted-escaped in logfmt
    const info = p.streams.find((s) => s.stream.level === 'info')!;
    expect(info.values[0][1]).toContain('msg="hi there"');
  });

  it('invalid level falls back to info; empty input → null', () => {
    const p = buildLokiPayload('1', [{ level: 'bogus', msg: 'x', ts: 5 }], undefined, () => '0')!;
    expect(p.streams[0].stream.level).toBe('info');
    expect(buildLokiPayload('1', [], undefined, () => '0')).toBeNull();
  });
});

// ── buildAnomalyLokiPayload (full anomaly reporting: single stream, low-cardinality labels, type/detail inlined) ──────────
describe('buildAnomalyLokiPayload', () => {
  it('single stream label={source,kind=anomaly}; type/publicId/buildVersion/detail/msg included inline (logfmt)', () => {
    const p = buildAnomalyLokiPayload(
      '123456789',
      [{ type: 'webgl_lost', msg: 'context lost', ts: 1000, detail: '{"a":1}' }],
      'web',
      '0861367',
      () => '0',
    )!;
    expect(p.streams).toHaveLength(1);
    expect(p.streams[0].stream).toEqual({ source: 'client', kind: 'anomaly' });
    expect(p.streams[0].values[0][0]).toBe('1000000000'); // ms→ns
    const line = p.streams[0].values[0][1];
    expect(line).toContain('type=webgl_lost');
    expect(line).toContain('publicId=123456789');
    expect(line).toContain('platform=web');
    expect(line).toContain('buildVersion=0861367');
    expect(line).toContain('detail=');
    expect(line).toContain('msg="context lost"');
  });

  it('unknown type falls back to other; empty input → null', () => {
    const p = buildAnomalyLokiPayload('1', [{ type: 'bogus', msg: 'x', ts: 5 }], undefined, undefined, () => '0')!;
    expect(p.streams[0].values[0][1]).toContain('type=other');
    expect(buildAnomalyLokiPayload('1', [], undefined, undefined, () => '0')).toBeNull();
  });
});

// ── MetaService.bootstrap / clientLog (constructed directly; cols and similar are stubs) ────────────────
function makeService(flags: FeatureFlagCache | null, lokiPushUrl: string | null = null): MetaService {
  return new MetaService({
    cols: {} as never,
    jwt: { secret: 'test-secret' },
    now: () => 1_000,
    commercial: {} as never,
    gateway: {} as never,
    gatewayPublicUrl: null,
    authRateLimit: 0,
    flags,
    region: null,
    lokiPushUrl,
  });
}

async function cacheWith(docs: unknown[]): Promise<FeatureFlagCache> {
  const c = new FeatureFlagCache({ fetchAll: async () => docs });
  await c.refresh();
  return c;
}

function req(partial: { query?: unknown; body?: unknown; headers?: Record<string, string> }): FastifyRequest {
  return { query: partial.query ?? {}, body: partial.body ?? {}, headers: partial.headers ?? {} } as unknown as FastifyRequest;
}

describe('MetaService.bootstrap (§9.3 only returns flags that differ from default)', () => {
  it('publicId matches client_log_debug → flags contains that key true; no match → empty map', async () => {
    // Standard per-player targeting configuration: pct:0 disables for everyone, allowPublicIds enables for matched ids only (§9.1 note).
    const flags = await cacheWith([
      { _id: 'client_log_debug', enabled: true, rollout: { pct: 0, allowPublicIds: ['123456789'] } },
    ]);
    const svc = makeService(flags);

    const hit = (await svc.bootstrap(req({ query: { platform: 'web', publicId: '123456789' } }))) as {
      data: { flags: Record<string, boolean> };
    };
    expect(hit.data.flags).toEqual({ client_log_debug: true });

    const miss = (await svc.bootstrap(req({ query: { publicId: '999999999' } }))) as {
      data: { flags: Record<string, boolean> };
    };
    expect(miss.data.flags).toEqual({});
  });

  it('no flag source → always empty map', async () => {
    const svc = makeService(null);
    const r = (await svc.bootstrap(req({ query: { publicId: '123456789' } }))) as {
      data: { flags: Record<string, boolean> };
    };
    expect(r.data.flags).toEqual({});
  });
});

describe('MetaService.clientLog (§9.4 targeting guard + forwarding)', () => {
  const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function reply(): FastifyReply & { _code: number; _body: unknown } {
    const r = { _code: 200, _body: undefined as unknown } as FastifyReply & { _code: number; _body: unknown };
    r.code = ((c: number) => { r._code = c; return r; }) as never;
    r.send = ((b: unknown) => { r._body = b; return r; }) as never;
    return r;
  }

  it('publicId not targeted → accepted 0, Loki not forwarded', async () => {
    const flags = await cacheWith([{ _id: 'client_log_debug', enabled: true, rollout: { allowPublicIds: ['111'] } }]);
    const svc = makeService(flags, 'http://loki/push');
    const out = (await svc.clientLog(
      req({ body: { publicId: '999', logs: [{ level: 'error', msg: 'x', ts: 1 }] } }),
      reply(),
    )) as { data: { accepted: number } };
    expect(out.data.accepted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('targeted publicId → forwarded to Loki, accepted=count', async () => {
    const flags = await cacheWith([{ _id: 'client_log_error', enabled: true, rollout: { allowPublicIds: ['123456789'] } }]);
    const svc = makeService(flags, 'http://loki/push');
    const out = (await svc.clientLog(
      req({ body: { publicId: '123456789', platform: 'web', logs: [{ level: 'error', msg: 'boom', ts: 1 }] } }),
      reply(),
    )) as { data: { accepted: number } };
    expect(out.data.accepted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://loki/push');
  });

  it('missing publicId / logs → 400', async () => {
    const svc = makeService(await cacheWith([]), 'http://loki/push');
    const rep = reply();
    await svc.clientLog(req({ body: { logs: [] } }), rep);
    expect(rep._code).toBe(400);
  });
});

describe('MetaService.clientAnomaly (full reporting: not restricted by targeting allowlist + IP rate limit)', () => {
  const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
  beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  function reply(): FastifyReply & { _code: number; _body: unknown } {
    const r = { _code: 200, _body: undefined as unknown } as FastifyReply & { _code: number; _body: unknown };
    r.code = ((c: number) => { r._code = c; return r; }) as never;
    r.send = ((b: unknown) => { r._body = b; return r; }) as never;
    return r;
  }

  it('no flag source / not targeted still forwards to Loki (full reporting), accepted=count', async () => {
    const svc = makeService(null, 'http://loki/push'); // no flag source = no publicId is targeted
    const out = (await svc.clientAnomaly(
      req({ body: { publicId: '999', platform: 'web', events: [{ type: 'mem', msg: 'over', ts: 1 }] } }),
      reply(),
    )) as { data: { accepted: number } };
    expect(out.data.accepted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://loki/push');
  });

  it('missing publicId → still accepted (recorded as anon)', async () => {
    const svc = makeService(null, 'http://loki/push');
    const out = (await svc.clientAnomaly(
      req({ body: { events: [{ type: 'crash', msg: 'prev crash', ts: 1 }] } }),
      reply(),
    )) as { data: { accepted: number } };
    expect(out.data.accepted).toBe(1);
    expect(fetchMock.mock.calls[0][1]).toBeDefined();
  });

  it('dev-build crash (buildVersion 0.0.0) is dropped; a mem event in the same batch still passes (defense-in-depth dev gate)', async () => {
    const svc = makeService(null, 'http://loki/push');
    const out = (await svc.clientAnomaly(
      req({
        body: {
          publicId: '1',
          buildVersion: '0.0.0',
          events: [
            { type: 'crash', msg: 'prev unclean exit', ts: 1 },
            { type: 'mem', msg: 'heap over', ts: 2 },
          ],
        },
      }),
      reply(),
    )) as { data: { accepted: number } };
    // The crash event is filtered (dev hot-reload noise); only the mem event survives.
    expect(out.data.accepted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = fetchMock.mock.calls[0][1] as { body: string };
    const line = JSON.parse(payload.body).streams[0].values[0][1] as string;
    expect(line).toContain('type=mem');
  });

  it('baked-build crash (real buildVersion) is NOT dropped', async () => {
    const svc = makeService(null, 'http://loki/push');
    const out = (await svc.clientAnomaly(
      req({ body: { publicId: '1', buildVersion: '68b6c7b', events: [{ type: 'crash', msg: 'prev unclean exit', ts: 1 }] } }),
      reply(),
    )) as { data: { accepted: number } };
    expect(out.data.accepted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('missing events → 400', async () => {
    const svc = makeService(null, 'http://loki/push');
    const rep = reply();
    await svc.clientAnomaly(req({ body: {} }), rep);
    expect(rep._code).toBe(400);
  });

  it('same IP exceeds 30 requests/60s → silently dropped (accepted 0, no further forwarding)', async () => {
    const svc = makeService(null, 'http://loki/push'); // now always returns 1000 → all calls fall within the same rate-limit window
    const body = { body: { publicId: '1', events: [{ type: 'anr', msg: 'stall', ts: 1 }] } };
    for (let i = 0; i < 30; i++) await svc.clientAnomaly(req(body), reply());
    expect(fetchMock).toHaveBeenCalledTimes(30);
    const over = (await svc.clientAnomaly(req(body), reply())) as { data: { accepted: number } };
    expect(over.data.accepted).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(30); // 31st call was not forwarded
  });
});
