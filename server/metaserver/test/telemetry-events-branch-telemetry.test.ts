// Branch-coverage backfill for src/service/telemetry.ts + src/clientLog.ts (group D, 2026-09-03).
//
// telemetry.ts had no dedicated unit test at all: test/clientLog.test.ts drives a few happy paths
// through MetaService, and the e2e suites import '../dist/app.js' (which v8 coverage cannot attribute
// back to src/*.ts). What was left uncovered is almost entirely the *absent-field* half of every
// `typeof x === 'string' ? ... : fallback` in clientLog/clientAnomaly — and those endpoints forward
// parsed JSON verbatim from an UNAUTHENTICATED client, so the absent-field side is the realistic one:
// an old build, a truncated batch, a hand-rolled request. Each of those fallbacks decides whether a
// line lands in Loki at all (a dropped line is a hole in the anomaly dashboard, and a hole reads as
// "no crashes" rather than "we stopped receiving them"), or lands with a wrong-but-plausible value.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FeatureFlagCache, signToken } from '@nw/shared';
import { buildLokiPayload, buildAnomalyLokiPayload, pushToLoki } from '../src/clientLog.js';
import { TelemetryService } from '../src/service/telemetry.js';
import { MetaCore, type ServiceDeps } from '../src/service/base.js';

const JWT = { secret: 'grpD-telemetry-secret' };
const NOW = 7_000;

interface SvcOpts {
  flags?: FeatureFlagCache | null;
  lokiPushUrl?: string | null;
  region?: string | null;
}

function makeSvc(opts: SvcOpts = {}): TelemetryService {
  const deps = {
    cols: {} as never,
    jwt: JWT,
    now: () => NOW,
    commercial: {} as never,
    gateway: {} as never,
    gatewayPublicUrl: null,
    authRateLimit: 0,
    flags: opts.flags ?? null,
    wordlists: null,
    region: opts.region ?? null,
    lokiPushUrl: opts.lokiPushUrl ?? null,
    socialsvc: null,
    redis: null,
    accountCache: {} as never,
  } as unknown as ServiceDeps;
  return new TelemetryService(new MetaCore(deps));
}

async function cacheWith(docs: unknown[]): Promise<FeatureFlagCache> {
  const c = new FeatureFlagCache({ fetchAll: async () => docs });
  await c.refresh();
  return c;
}

/** Partial FastifyRequest: `query`/`body` are deliberately omitted (not defaulted) when not supplied,
 *  so the `req.query ?? {}` / `req.body ?? {}` fallbacks are actually exercised. */
function req(partial: { query?: unknown; body?: unknown; headers?: Record<string, string>; ip?: string } = {}): FastifyRequest {
  const r: Record<string, unknown> = { headers: partial.headers ?? {}, ip: partial.ip ?? '10.0.0.1' };
  if ('query' in partial) r.query = partial.query;
  if ('body' in partial) r.body = partial.body;
  return r as unknown as FastifyRequest;
}

function reply(): FastifyReply & { _code: number; _body: unknown } {
  const r = { _code: 200, _body: undefined as unknown } as FastifyReply & { _code: number; _body: unknown };
  r.code = ((c: number) => { r._code = c; return r; }) as never;
  r.send = ((b: unknown) => { r._body = b; return r; }) as never;
  return r;
}

/** The single Loki line a one-event/one-entry batch produced (asserting on tokens, not substrings:
 *  these are what a Grafana `| logfmt | key="value"` filter actually matches). */
function pushedLine(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  const init = fetchMock.mock.calls[call]![1] as unknown as { body: string };
  return JSON.parse(init.body).streams[0].values[0][1] as string;
}

// ── bootstrap: the evaluation-context fields nothing had ever populated ────────────────────────────
describe('TelemetryService.bootstrap flag-evaluation context', () => {
  it('missing query string entirely (bare GET /bootstrap) still evaluates instead of throwing', async () => {
    // A client that polls /bootstrap with no query params at all is the anonymous cold-start case;
    // `req.query ?? {}` is the only thing keeping that from being a 500 on the very first call.
    const svc = makeSvc({ flags: await cacheWith([{ _id: 'match_bot_fallback', enabled: true }]) });
    const out = (await svc.bootstrap(req())) as { data: { flags: Record<string, boolean> } };
    expect(out.data.flags).toEqual({ match_bot_fallback: true });
  });

  it('an off-allowlist platform value is ignored rather than passed into evaluation', async () => {
    // Only FLAG_PLATFORMS values may reach ctx.platform; anything else must read as "unknown platform",
    // which for a platforms-scoped rollout means NOT enabled.
    const flags = await cacheWith([{ _id: 'match_bot_fallback', enabled: true, rollout: { platforms: ['web'] } }]);
    const svc = makeSvc({ flags });
    const bogus = (await svc.bootstrap(req({ query: { platform: 'nintendo-64' } }))) as { data: { flags: Record<string, boolean> } };
    expect(bogus.data.flags).toEqual({});
    const real = (await svc.bootstrap(req({ query: { platform: 'web' } }))) as { data: { flags: Record<string, boolean> } };
    expect(real.data.flags).toEqual({ match_bot_fallback: true });
  });

  it('the deployment region is injected, so a region-scoped rollout reaches players in that region only', async () => {
    // deps.region is how an operator's "EU only" rollout is enforced server-side; with it unset the
    // same rule must evaluate to false rather than leaking the flag to every region.
    const docs = [{ _id: 'match_bot_fallback', enabled: true, rollout: { regions: ['eu'] } }];
    const inRegion = (await makeSvc({ flags: await cacheWith(docs), region: 'eu' }).bootstrap(req({ query: {} }))) as { data: { flags: Record<string, boolean> } };
    expect(inRegion.data.flags).toEqual({ match_bot_fallback: true });
    const noRegion = (await makeSvc({ flags: await cacheWith(docs), region: null }).bootstrap(req({ query: {} }))) as { data: { flags: Record<string, boolean> } };
    expect(noRegion.data.flags).toEqual({});
  });

  it('a bearer token supplies accountId, so an allowAccounts rollout resolves for that account', async () => {
    const flags = await cacheWith([{ _id: 'match_bot_fallback', enabled: true, rollout: { pct: 0, allowAccounts: ['acc-vip'] } }]);
    const svc = makeSvc({ flags });
    const authed = (await svc.bootstrap(
      req({ query: {}, headers: { authorization: `Bearer ${signToken('acc-vip', JWT)}` } }),
    )) as { data: { flags: Record<string, boolean> } };
    expect(authed.data.flags).toEqual({ match_bot_fallback: true });
  });

  it('a garbage bearer token is treated as anonymous, not as an error (bootstrap must never 500)', async () => {
    // /bootstrap is the client's first call; a stale/forged token has to degrade to anonymous
    // evaluation, otherwise an expired session bricks the app's cold start.
    const flags = await cacheWith([{ _id: 'match_bot_fallback', enabled: true, rollout: { pct: 0, allowAccounts: ['acc-vip'] } }]);
    const svc = makeSvc({ flags });
    const out = (await svc.bootstrap(
      req({ query: {}, headers: { authorization: 'Bearer not-a-real-jwt' } }),
    )) as { data: { flags: Record<string, boolean> } };
    expect(out.data.flags).toEqual({});
  });

  it('ships the public Paddle client token only when it is configured', async () => {
    // The web client cannot open the checkout overlay without it; when unconfigured the field must be
    // absent rather than present-and-empty (the client branches on presence).
    const svc = makeSvc({ flags: null });
    const before = (await svc.bootstrap(req({ query: {} }))) as { data: Record<string, unknown> };
    expect(before.data).toEqual({ flags: {} });

    process.env.NW_PADDLE_CLIENT_TOKEN = 'ptok_grpD_test';
    try {
      const after = (await svc.bootstrap(req({ query: {} }))) as { data: Record<string, unknown> };
      expect(after.data).toEqual({ flags: {}, paddleClientToken: 'ptok_grpD_test' });
    } finally {
      delete process.env.NW_PADDLE_CLIENT_TOKEN;
    }
  });
});

// ── clientLog: the targeting guard with no flag source, and the entry-shape fallbacks ─────────────
describe('TelemetryService.clientLog input shapes', () => {
  const fetchMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as Response);
  beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('no flag source at all → nobody is targeted, logs are accepted and discarded', async () => {
    // A deployment without admin configured has no way to know who is being collected; the endpoint
    // must still answer 200/accepted:0 (never a 4xx, which would leak "you are not being collected").
    const svc = makeSvc({ flags: null, lokiPushUrl: 'http://loki/push' });
    const out = (await svc.clientLog(
      req({ body: { publicId: '123456789', logs: [{ level: 'error', msg: 'x', ts: 1 }] } }),
      reply(),
    )) as { data: { accepted: number } };
    expect(out.data.accepted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a body that failed to parse (undefined) → 400, not a crash on property access', async () => {
    const svc = makeSvc({ flags: await cacheWith([]), lokiPushUrl: 'http://loki/push' });
    const rep = reply();
    await svc.clientLog(req(), rep);
    expect(rep._code).toBe(400);
  });

  it('drops non-object and msg-less entries but keeps the rest of the batch', async () => {
    // One malformed entry from an old client must not discard the whole upload — that is the
    // difference between "this player's session is missing two lines" and "missing entirely".
    const flags = await cacheWith([{ _id: 'client_log_error', enabled: true, rollout: { allowPublicIds: ['123456789'] } }]);
    const svc = makeSvc({ flags, lokiPushUrl: 'http://loki/push' });
    const out = (await svc.clientLog(
      req({
        body: {
          publicId: '123456789',
          logs: [null, 'a string', 42, { level: 'error' }, { level: 'error', msg: '' }, { level: 'error', msg: 'kept', ts: 1 }],
        },
      }),
      reply(),
    )) as { data: { accepted: number } };
    expect(out.data.accepted).toBe(1);
    expect(pushedLine(fetchMock)).toContain('msg=kept');
  });

  it('a batch where every entry is malformed pushes nothing (no empty Loki request)', async () => {
    const flags = await cacheWith([{ _id: 'client_log_error', enabled: true, rollout: { allowPublicIds: ['123456789'] } }]);
    const svc = makeSvc({ flags, lokiPushUrl: 'http://loki/push' });
    const out = (await svc.clientLog(
      req({ body: { publicId: '123456789', logs: [null, {}] } }),
      reply(),
    )) as { data: { accepted: number } };
    expect(out.data.accepted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('absent level/ts/platform fall back to info / server clock / no platform token', async () => {
    // These three are what make a log line queryable at all. A missing `level` must not become an
    // arbitrary label value, and a missing `ts` must become the server's own clock — otherwise the
    // line sorts to the epoch and never appears in the operator's time range.
    const flags = await cacheWith([{ _id: 'client_log_info', enabled: true, rollout: { allowPublicIds: ['123456789'] } }]);
    const svc = makeSvc({ flags, lokiPushUrl: 'http://loki/push' });
    await svc.clientLog(
      req({ body: { publicId: '123456789', platform: 99, logs: [{ msg: 'levelless', tag: '' }] } }),
      reply(),
    );
    const init = fetchMock.mock.calls[0]![1] as unknown as { body: string };
    const stream = JSON.parse(init.body).streams[0];
    expect(stream.stream).toEqual({ source: 'client', level: 'info' });
    expect(stream.values[0][0]).toBe(String(BigInt(NOW) * 1_000_000n)); // server clock, not epoch 0
    expect(stream.values[0][1]).not.toContain('platform=');
    expect(stream.values[0][1]).not.toContain('tag='); // empty tag is dropped, not sent as tag=""
  });

  it('a non-finite ts also falls back to the server clock', async () => {
    const flags = await cacheWith([{ _id: 'client_log_info', enabled: true, rollout: { allowPublicIds: ['1'] } }]);
    const svc = makeSvc({ flags, lokiPushUrl: 'http://loki/push' });
    await svc.clientLog(req({ body: { publicId: '1', logs: [{ level: 'warn', msg: 'nan ts', ts: Number.NaN }] } }), reply());
    const init = fetchMock.mock.calls[0]![1] as unknown as { body: string };
    expect(JSON.parse(init.body).streams[0].values[0][0]).toBe(String(BigInt(NOW) * 1_000_000n));
  });

  it('caps an oversized tag at 64 chars (it lands inline on every line of the batch)', async () => {
    const flags = await cacheWith([{ _id: 'client_log_info', enabled: true, rollout: { allowPublicIds: ['1'] } }]);
    const svc = makeSvc({ flags, lokiPushUrl: 'http://loki/push' });
    await svc.clientLog(req({ body: { publicId: '1', logs: [{ level: 'info', msg: 'x', ts: 1, tag: 't'.repeat(300) }] } }), reply());
    expect(/tag=(\S+)/.exec(pushedLine(fetchMock))?.[1]?.length).toBe(64);
  });
});

// ── clientAnomaly: the same absent-field half, on the endpoint exempt from the allowlist gate ─────
describe('TelemetryService.clientAnomaly input shapes', () => {
  const fetchMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as Response);
  beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('a body that failed to parse (undefined) → 400', async () => {
    const rep = reply();
    await makeSvc({ lokiPushUrl: 'http://loki/push' }).clientAnomaly(req(), rep);
    expect(rep._code).toBe(400);
  });

  it('drops non-object events and events missing msg or type, keeping the rest', async () => {
    // `type` is the label operators query by and `msg` is the only human-readable payload; an event
    // with either missing is unusable, but it must not take the sibling crash report down with it.
    const svc = makeSvc({ lokiPushUrl: 'http://loki/push' });
    const out = (await svc.clientAnomaly(
      req({
        body: {
          publicId: '1',
          events: [
            null,
            'not an object',
            { type: 'crash' },              // no msg
            { msg: 'typeless anomaly' },    // no type
            { type: 42, msg: 'numeric type' },
            { type: 'anr', msg: 5 },        // numeric msg
            { type: 'webgl_lost', msg: 'context lost', ts: 1 },
          ],
        },
      }),
      reply(),
    )) as { data: { accepted: number } };
    expect(out.data.accepted).toBe(1);
    expect(pushedLine(fetchMock)).toContain('type=webgl_lost');
  });

  it('a batch of only malformed events pushes nothing and still answers 200', async () => {
    const svc = makeSvc({ lokiPushUrl: 'http://loki/push' });
    const out = (await svc.clientAnomaly(req({ body: { events: [null, {}] } }), reply())) as { data: { accepted: number } };
    expect(out.data.accepted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an event with no ts is stamped with the server clock, and a string detail is carried inline', async () => {
    // Anomalies are reported from a client that may have just lost its clock (or never had one, on a
    // crash replay read back from storage); without the server-clock fallback the line lands at the
    // epoch and is invisible in any realistic Grafana time range.
    const svc = makeSvc({ lokiPushUrl: 'http://loki/push' });
    await svc.clientAnomaly(
      req({ body: { publicId: '1', events: [{ type: 'mem', msg: 'heap over', detail: '{"heap":900}' }] } }),
      reply(),
    );
    const init = fetchMock.mock.calls[0]![1] as unknown as { body: string };
    const value = JSON.parse(init.body).streams[0].values[0];
    expect(value[0]).toBe(String(BigInt(NOW) * 1_000_000n));
    expect(value[1]).toContain('detail=');
  });

  it('ignores a non-string detail/orient/vp and a non-numeric sinceRot instead of inlining them', async () => {
    const svc = makeSvc({ lokiPushUrl: 'http://loki/push' });
    await svc.clientAnomaly(
      req({
        body: {
          publicId: '1',
          events: [{ type: 'cpu', msg: 'saturated', ts: 1, detail: 7, orient: '', vp: null, sinceRot: 'soon' }],
        },
      }),
      reply(),
    );
    const line = pushedLine(fetchMock);
    for (const token of ['detail=', 'orient=', 'vp=', 'sinceRot=']) expect(line).not.toContain(token);
  });
});

// ── clientLog.ts assembly helpers: the fallback/failure halves the existing suite never sent ──────
describe('buildLokiPayload / buildAnomalyLokiPayload edge values', () => {
  it('an empty publicId is emitted as publicId="" so the rest of the logfmt line stays parseable', () => {
    // A bare `publicId=` would make Grafana's logfmt parser swallow the following key, silently
    // blanking every other field on the line.
    const p = buildLokiPayload('', [{ level: 'error', msg: 'boom', ts: 1000 }], undefined, () => '0')!;
    expect(p.streams[0]!.values[0]![1]).toContain('publicId=""');
  });

  it('a ts of 0 / negative / NaN falls back to the caller-supplied nanosecond clock', () => {
    // ts is client-supplied; a zeroed clock (fresh WebView, wechat cold start) would otherwise pin the
    // line to 1970 where no dashboard time range will ever show it.
    for (const ts of [0, -5, Number.NaN]) {
      const log = buildLokiPayload('1', [{ level: 'info', msg: 'x', ts }], undefined, () => '4242')!;
      expect(log.streams[0]!.values[0]![0]).toBe('4242');
      const anomaly = buildAnomalyLokiPayload('1', [{ type: 'mem', msg: 'x', ts }], {}, () => '4242')!;
      expect(anomaly.streams[0]!.values[0]![0]).toBe('4242');
    }
  });
});

describe('pushToLoki failure reporting', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a non-2xx Loki response is reported to onError with the status (and never thrown)', () => {
    // Silent by default in production, but this is the hook a debugging operator attaches to find out
    // that Loki has been rejecting every push — the difference between "no client logs" and "no
    // client logs are getting through".
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as Response));
    const errors: unknown[] = [];
    return pushToLoki('http://loki/push', { streams: [] }, (e) => errors.push(e)).then(() => {
      expect((errors[0] as Error).message).toBe('loki push 503');
    });
  });

  it('a network failure is reported to onError, not propagated to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const errors: unknown[] = [];
    await expect(pushToLoki('http://loki/push', { streams: [] }, (e) => errors.push(e))).resolves.toBeUndefined();
    expect((errors[0] as Error).message).toBe('ECONNREFUSED');
  });
});
