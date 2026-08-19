// HttpWorldGatewayClient / nullWorldGatewayClient unit tests: fixture node:http server for the
// HTTP push path (`postInternal`, never throws — see ../src/gatewayClient.ts), plus a fake
// BroadcastRedis for the Redis-publish fan-out path and its HTTP fallback.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  HttpWorldGatewayClient,
  nullWorldGatewayClient,
  type SlgPushMsg,
  type BroadcastRedis,
} from '../src/gatewayClient';

const KEY = 'k-internal';

interface RecordedReq {
  method: string;
  url: string;
  body: unknown;
}

let server: Server;
let base: string;
let requests: RecordedReq[] = [];
let nextStatus = 200;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(nextStatus, { 'content-type': 'application/json' });
      res.end('{}');
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  requests = [];
  nextStatus = 200;
});

const msg: SlgPushMsg = {
  kind: 'march_update',
  marchId: 'm1',
  marchKind: 'attack',
  fromTile: 't1',
  toTile: 't2',
  arriveAt: 12345,
  status: 'marching',
};

describe('HttpWorldGatewayClient.available', () => {
  it('true when baseUrl is set, false when null', () => {
    expect(new HttpWorldGatewayClient(base, KEY).available).toBe(true);
    expect(new HttpWorldGatewayClient(null, KEY).available).toBe(false);
  });
});

describe('HttpWorldGatewayClient.push', () => {
  it('success → POST /gw/push with { accountId, msg } body', async () => {
    const c = new HttpWorldGatewayClient(base, KEY);
    await expect(c.push('acc1', msg)).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('/gw/push');
    expect(requests[0]!.body).toEqual({ accountId: 'acc1', msg });
  });

  it('non-2xx → does not throw (best-effort)', async () => {
    nextStatus = 500;
    const c = new HttpWorldGatewayClient(base, KEY);
    await expect(c.push('acc1', msg)).resolves.toBeUndefined();
  });

  it('baseUrl null → no-op, no request', async () => {
    const c = new HttpWorldGatewayClient(null, KEY);
    await expect(c.push('acc1', msg)).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });
});

describe('HttpWorldGatewayClient.broadcast', () => {
  it('empty recipients → no-op, no redis publish, no HTTP push', async () => {
    const redis: BroadcastRedis = { publish: vi.fn().mockResolvedValue(undefined) };
    const c = new HttpWorldGatewayClient(base, KEY, redis);
    await expect(c.broadcast([], msg)).resolves.toBeUndefined();
    expect(redis.publish).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it('redis provided → publishes once to GW_PUSH_REDIS_CHANNEL, skips per-recipient HTTP push', async () => {
    const redis: BroadcastRedis = { publish: vi.fn().mockResolvedValue(undefined) };
    const c = new HttpWorldGatewayClient(base, KEY, redis);
    await c.broadcast(['acc1', 'acc2'], msg);
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = (redis.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(channel).toBe('nw:gw:push');
    expect(JSON.parse(payload as string)).toEqual({ recipients: ['acc1', 'acc2'], msg });
    expect(requests).toHaveLength(0);
  });

  it('redis publish throws → falls through to per-recipient HTTP push fallback', async () => {
    const redis: BroadcastRedis = { publish: vi.fn().mockRejectedValue(new Error('redis down')) };
    const c = new HttpWorldGatewayClient(base, KEY, redis);
    await c.broadcast(['acc1', 'acc2'], msg);
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.body)).toEqual(
      expect.arrayContaining([
        { accountId: 'acc1', msg },
        { accountId: 'acc2', msg },
      ]),
    );
  });

  it('no redis configured → falls back straight to per-recipient HTTP push', async () => {
    const c = new HttpWorldGatewayClient(base, KEY);
    await c.broadcast(['acc1', 'acc2', 'acc3'], msg);
    expect(requests).toHaveLength(3);
  });

  it('baseUrl null, no redis → per-recipient push() is a no-op, does not throw', async () => {
    const c = new HttpWorldGatewayClient(null, KEY);
    await expect(c.broadcast(['acc1', 'acc2'], msg)).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });
});

describe('nullWorldGatewayClient', () => {
  it('available is false; push/broadcast are no-ops', async () => {
    expect(nullWorldGatewayClient.available).toBe(false);
    await expect(nullWorldGatewayClient.push('acc1', msg)).resolves.toBeUndefined();
    await expect(nullWorldGatewayClient.broadcast(['acc1'], msg)).resolves.toBeUndefined();
  });
});
