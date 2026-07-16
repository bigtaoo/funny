// commercial internal HTTP (S5-1, not publicly exposed). The only caller is meta, authenticated via X-Internal-Key.
// Uses node:http (commercial does not import fastify). Contract: SERVER_API.md §9 / COMMERCIAL_DESIGN §5.
// Protocol errors (auth / method / parsing) → 4xx; business results (including INSUFFICIENT_FUNDS etc.) → 200 + {ok,...} mapped by meta.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { createLogger, type InternalAuthVerifier, type CustomPoolCategory } from '@nw/shared';
import type { CommercialService } from './service';

const log = createLogger('commercial:internal');

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
  opts: { host: string; port: number; internalAuth: InternalAuthVerifier },
  svc: CommercialService,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      // Health probe (no auth required): used by docker healthcheck / CI readiness waits.
      if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, { ok: true, service: 'commercial' });
        return;
      }
      const authz = opts.internalAuth.verify(req.headers);
      if (!authz.ok) {
        log.warn('internal request rejected: bad X-Internal-Key', {
          url: req.url,
          caller: req.headers['x-internal-caller'],
        });
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
        if (req.method === 'GET' && url.pathname === '/internal/promo/codes') {
          const codes = await svc.listPromoCodes();
          return send(res, 200, { ok: true, codes });
        }
        if (req.method === 'GET' && url.pathname === '/internal/gacha/pools') {
          const active = url.searchParams.get('active') === '1';
          const nowMs = Number(url.searchParams.get('now')) || Date.now();
          const pools = active ? await svc.listActiveLimitedPools(nowMs) : await svc.listLimitedPools();
          return send(res, 200, { ok: true, pools });
        }
        if (req.method === 'GET' && url.pathname === '/internal/paddle/events') {
          const events = await svc.listPaddleEvents({
            accountId: url.searchParams.get('accountId') ?? undefined,
            transactionId: url.searchParams.get('transactionId') ?? undefined,
            limit: Number(url.searchParams.get('limit')) || undefined,
          });
          return send(res, 200, { ok: true, events });
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
          case '/internal/spend':
            return send(
              res,
              200,
              await svc.spend({
                accountId: str(b.accountId),
                amount: num(b.amount, 0),
                reason: str(b.reason),
                orderId: str(b.orderId),
              }),
            );
          case '/internal/grant':
            return send(
              res,
              200,
              await svc.grant({
                accountId: str(b.accountId),
                amount: num(b.amount, 0),
                reason: str(b.reason),
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
          case '/internal/victory/credit':
            return send(
              res,
              200,
              await svc.victoryCredit({
                accountId: str(b.accountId),
                amount: num(b.amount, 0),
                dayKey: str(b.dayKey),
              }),
            );
          case '/internal/promo/redeem':
            return send(
              res,
              200,
              await svc.promoRedeem({
                accountId: str(b.accountId),
                code: str(b.code),
              }),
            );
          case '/internal/promo/codes': {
            const expiresAt = typeof b.expiresAt === 'number' ? b.expiresAt : undefined;
            const totalLimit = typeof b.totalLimit === 'number' ? b.totalLimit : undefined;
            return send(
              res,
              200,
              await svc.createPromoCode({
                code: str(b.code),
                coins: num(b.coins, 0),
                expiresAt,
                totalLimit,
                note: typeof b.note === 'string' ? b.note : undefined,
                createdBy: str(b.createdBy),
              }),
            );
          }
          case '/internal/paddle/complete':
            return send(
              res,
              200,
              await svc.paddleComplete({
                accountId: str(b.accountId),
                transactionId: str(b.transactionId),
                coins: num(b.coins, 0),
              }),
            );
          case '/internal/paddle/event':
            await svc.recordPaddleEvent({
              transactionId: str(b.transactionId),
              eventType: str(b.eventType),
              status: typeof b.status === 'string' ? b.status : undefined,
              accountId: typeof b.accountId === 'string' ? b.accountId : undefined,
              rawEvent: str(b.rawEvent),
            });
            return send(res, 200, { ok: true });
          case '/internal/gacha/pool': {
            const cfg = (b.config ?? {}) as Record<string, unknown>;
            return send(
              res,
              200,
              await svc.createLimitedPool({
                config: {
                  id: str(cfg.id),
                  name: str(cfg.name),
                  featuredLegendary: str(cfg.featuredLegendary),
                  startAt: num(cfg.startAt, 0),
                  endAt: num(cfg.endAt, 0),
                  ...(Array.isArray(cfg.fillerLegendaries)
                    ? { fillerLegendaries: (cfg.fillerLegendaries as unknown[]).map((x) => str(x)) }
                    : {}),
                },
                createdBy: str(b.createdBy),
              }),
            );
          }
          case '/internal/gacha/pool/custom': {
            const cfg = (b.config ?? {}) as Record<string, unknown>;
            const categories = Array.isArray(cfg.categories)
              ? (cfg.categories as Record<string, unknown>[]).map((c) => ({
                  category: str(c.category) as CustomPoolCategory['category'],
                  weight: num(c.weight, 0),
                  items: Array.isArray(c.items)
                    ? (c.items as Record<string, unknown>[]).map((it) => ({
                        itemId: str(it.itemId),
                        weight: num(it.weight, 0),
                      }))
                    : [],
                }))
              : [];
            return send(
              res,
              200,
              await svc.createCustomPool({
                config: {
                  id: str(cfg.id),
                  name: str(cfg.name),
                  costSingle: num(cfg.costSingle, 0),
                  ...(typeof cfg.costTen === 'number' ? { costTen: cfg.costTen } : {}),
                  startAt: num(cfg.startAt, 0),
                  endAt: num(cfg.endAt, 0),
                  categories,
                },
                createdBy: str(b.createdBy),
              }),
            );
          }
          case '/internal/gacha/pool/close':
            return send(res, 200, await svc.closeLimitedPool({ id: str(b.id) }));
          case '/internal/fate/redeem':
            return send(
              res,
              200,
              await svc.redeemFate({
                accountId: str(b.accountId),
                itemId: str(b.itemId),
                orderId: str(b.orderId),
              }),
            );
          case '/internal/monthly-card/buy':
            return send(
              res,
              200,
              await svc.monthlyCardBuy({ accountId: str(b.accountId), orderId: str(b.orderId) }),
            );
          case '/internal/year-card/buy':
            return send(
              res,
              200,
              await svc.yearCardBuy({ accountId: str(b.accountId), orderId: str(b.orderId) }),
            );
          case '/internal/monthly-card/claim':
            return send(
              res,
              200,
              await svc.monthlyCardClaim({ accountId: str(b.accountId), dayKey: str(b.dayKey) }),
            );
          case '/internal/starter/buy':
            return send(
              res,
              200,
              await svc.starterBuy({
                accountId: str(b.accountId),
                productId: str(b.productId),
                orderId: str(b.orderId),
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
