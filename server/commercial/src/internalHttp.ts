// commercial 内部 HTTP（S5-1，不暴露公网）。唯一调用方是 meta，鉴权 X-Internal-Key。
// 用 node:http（commercial 不引 fastify）。契约见 SERVER_API.md §9 / COMMERCIAL_DESIGN §5。
// 协议错误（鉴权/方法/解析）→ 4xx；业务结果（含 INSUFFICIENT_FUNDS 等）→ 200 + {ok,...} 由 meta 映射。
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { CommercialService } from './service';

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1 << 20) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);

export function startInternalHttp(
  opts: { host: string; port: number; internalKey: string },
  svc: CommercialService,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers['x-internal-key'] !== opts.internalKey) {
        send(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'internal'}`);
      try {
        // —— GET ——
        if (req.method === 'GET' && url.pathname === '/internal/wallet') {
          const accountId = url.searchParams.get('accountId');
          if (!accountId) return send(res, 400, { ok: false, error: 'accountId required' });
          return send(res, 200, { ok: true, ...(await svc.getWallet(accountId)) });
        }
        if (req.method === 'GET' && url.pathname === '/internal/orders/undelivered') {
          const accountId = url.searchParams.get('accountId');
          if (!accountId) return send(res, 400, { ok: false, error: 'accountId required' });
          const orders = await svc.undeliveredOrders(accountId);
          return send(res, 200, { ok: true, orders });
        }

        if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'not found' });
        const b = await readJson(req);

        switch (url.pathname) {
          case '/internal/shop/charge':
            return send(
              res,
              200,
              await svc.shopCharge({
                accountId: str(b.accountId),
                itemId: str(b.itemId),
                cost: num(b.cost, 0),
                orderId: str(b.orderId),
              }),
            );
          case '/internal/gacha/draw':
            return send(
              res,
              200,
              await svc.gachaDraw({
                accountId: str(b.accountId),
                poolId: str(b.poolId),
                count: num(b.count, 1),
                orderId: str(b.orderId),
              }),
            );
          case '/internal/order/delivered':
            return send(
              res,
              200,
              await svc.orderDelivered({
                orderId: str(b.orderId),
                ...(typeof b.refundCoins === 'number' ? { refundCoins: b.refundCoins } : {}),
              }),
            );
          case '/internal/recharge/verify':
            return send(
              res,
              200,
              await svc.rechargeVerify({
                accountId: str(b.accountId),
                platform: str(b.platform),
                receipt: str(b.receipt),
                receiptId: str(b.receiptId),
              }),
            );
          case '/internal/ads/credit':
            return send(
              res,
              200,
              await svc.adsCredit({
                accountId: str(b.accountId),
                amount: num(b.amount, 0),
                dayKey: str(b.dayKey),
              }),
            );
          default:
            return send(res, 404, { ok: false, error: 'not found' });
        }
      } catch (e) {
        send(res, 400, { ok: false, error: (e as Error).message });
      }
    })();
  });
  server.listen(opts.port, opts.host);
  return server;
}
