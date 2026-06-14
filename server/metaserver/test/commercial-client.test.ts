// HttpCommercialClient 单测（S5-5）：真实 fetch 打一台 canned node:http 服务，验证
//   • X-Internal-Key 头随请求带上；
//   • ok/error 包络解析（getWallet 失败 → null；shopCharge 业务错误透传）；
//   • baseUrl=null → available=false、getWallet/undelivered 不发请求直接回空。
// 无 Mongo 依赖，始终运行。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpCommercialClient } from '../dist/commercialClient.js';

const KEY = 'k-internal';
let lastReq: { url: string; method: string; key: string | undefined; body: string } | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      lastReq = {
        url: req.url ?? '',
        method: req.method ?? '',
        key: req.headers['x-internal-key'] as string | undefined,
        body,
      };
      const send = (o: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const url = new URL(req.url ?? '', 'http://x');
      if (url.pathname === '/internal/wallet') {
        if (url.searchParams.get('accountId') === 'missing') return send({ ok: false, error: 'x' });
        return send({ ok: true, coins: 42, pity: { standard: 3 } });
      }
      if (url.pathname === '/internal/shop/charge') return send({ ok: false, error: 'INSUFFICIENT_FUNDS' });
      if (url.pathname === '/internal/orders/undelivered')
        return send({ ok: true, orders: [{ _id: 'o1', accountId: 'a', kind: 'shop', result: { itemId: 'x' } }] });
      send({ ok: true });
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe('HttpCommercialClient', () => {
  it('available=true 时带 X-Internal-Key + 解析 wallet', async () => {
    const c = new HttpCommercialClient(base, KEY);
    expect(c.available).toBe(true);
    const w = await c.getWallet('a');
    expect(w).toEqual({ coins: 42, pity: { standard: 3 } });
    expect(lastReq?.key).toBe(KEY);
  });

  it('getWallet 收到 ok:false → null', async () => {
    const c = new HttpCommercialClient(base, KEY);
    expect(await c.getWallet('missing')).toBeNull();
  });

  it('业务错误包络透传（shopCharge → INSUFFICIENT_FUNDS）', async () => {
    const c = new HttpCommercialClient(base, KEY);
    const r = await c.shopCharge({ accountId: 'a', itemId: 'i', cost: 1, orderId: 'o' });
    expect(r).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
    expect(lastReq?.method).toBe('POST');
    expect(JSON.parse(lastReq!.body)).toMatchObject({ orderId: 'o', cost: 1 });
  });

  it('undeliveredOrders 解析数组', async () => {
    const c = new HttpCommercialClient(base, KEY);
    const orders = await c.undeliveredOrders('a');
    expect(orders).toHaveLength(1);
    expect(orders[0]!._id).toBe('o1');
  });

  it('baseUrl=null → available=false，getWallet/undelivered 不请求', async () => {
    const c = new HttpCommercialClient(null, KEY);
    expect(c.available).toBe(false);
    expect(await c.getWallet('a')).toBeNull();
    expect(await c.undeliveredOrders('a')).toEqual([]);
  });
});
