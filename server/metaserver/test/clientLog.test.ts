// 客户端日志定向采集（FEATURE_FLAGS_DESIGN §9）：Loki payload 组装 + 公开 bootstrap「只回 diff」
// + /client/log 定向守卫。纯逻辑，不连库（cols 用 stub）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FeatureFlagCache } from '@nw/shared';
import { buildLokiPayload } from '../src/clientLog';
import { MetaService } from '../src/service';

// ── buildLokiPayload（§9.4 入 Loki 约定）─────────────────────────────────────
describe('buildLokiPayload', () => {
  it('按 level 分流；label 仅 source/level；publicId 入行内（logfmt）', () => {
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
    // ts(ms)→ns：1000ms = 1_000_000_000ns
    expect(err.values[0][0]).toBe('1000000000');
    expect(err.values[0][1]).toContain('publicId=123456789');
    expect(err.values[0][1]).toContain('tag=gateway');
    expect(err.values[0][1]).toContain('msg=boom');
    // 含空格的 msg 走 logfmt 引号转义
    const info = p.streams.find((s) => s.stream.level === 'info')!;
    expect(info.values[0][1]).toContain('msg="hi there"');
  });

  it('非法 level 归入 info；空入 → null', () => {
    const p = buildLokiPayload('1', [{ level: 'bogus', msg: 'x', ts: 5 }], undefined, () => '0')!;
    expect(p.streams[0].stream.level).toBe('info');
    expect(buildLokiPayload('1', [], undefined, () => '0')).toBeNull();
  });
});

// ── MetaService.bootstrap / clientLog（直接构造，cols 等 stub）────────────────
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

describe('MetaService.bootstrap（§9.3 只回与 default 不同的 flag）', () => {
  it('publicId 命中 client_log_debug → flags 含该键 true；非命中 → 空 map', async () => {
    // 单玩家定向的标准配法：pct:0 关给所有人，allowPublicIds 命中即开（仅放行目标，§9.1 备注）。
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

  it('无 flag 源 → 恒空 map', async () => {
    const svc = makeService(null);
    const r = (await svc.bootstrap(req({ query: { publicId: '123456789' } }))) as {
      data: { flags: Record<string, boolean> };
    };
    expect(r.data.flags).toEqual({});
  });
});

describe('MetaService.clientLog（§9.4 定向守卫 + 转发）', () => {
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

  it('未定向的 publicId → accepted 0，且不转发 Loki', async () => {
    const flags = await cacheWith([{ _id: 'client_log_debug', enabled: true, rollout: { allowPublicIds: ['111'] } }]);
    const svc = makeService(flags, 'http://loki/push');
    const out = (await svc.clientLog(
      req({ body: { publicId: '999', logs: [{ level: 'error', msg: 'x', ts: 1 }] } }),
      reply(),
    )) as { data: { accepted: number } };
    expect(out.data.accepted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('被定向 → 转发 Loki，accepted=条数', async () => {
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

  it('缺 publicId / logs → 400', async () => {
    const svc = makeService(await cacheWith([]), 'http://loki/push');
    const rep = reply();
    await svc.clientLog(req({ body: { logs: [] } }), rep);
    expect(rep._code).toBe(400);
  });
});
