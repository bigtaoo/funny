// auctionsvc public REST (auction task 4): standalone /auction/* surface, decoupled from worldsvc/worldId.
// Auth: reuses the meta JWT; only verifyToken is called to extract accountId (no accounts DB connection, same pattern as worldsvc).
// Uses node:http (no fastify dependency, mirrors worldsvc/analyticsvc). Responses wrapped in @nw/shared ApiResp envelope.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import {
  ErrorCode,
  ERROR_HTTP_STATUS,
  ok,
  err,
  extractBearer,
  verifyToken,
  loadInternalAuth,
  SlgError,
} from '@nw/shared';
import type { AuctionService } from './auctionService';

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
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-internal-key,x-internal-caller',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function sendErr(res: ServerResponse, code: ErrorCode, message: string): void {
  send(res, ERROR_HTTP_STATUS[code] ?? 400, err(code, message));
}

const numQ = (v: string | null, d: number): number => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function startHttpApi(
  opts: { host: string; port: number; jwtSecret: string; internalKey: string },
  auctionSvc: AuctionService,
): Server {
  const internalAuth = loadInternalAuth(opts.internalKey);
  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      if (method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true, service: 'auctionsvc' });
      }
      if (method === 'OPTIONS') {
        return send(res, 204, {});
      }

      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'auction'}`);
      const path = url.pathname;
      const q = url.searchParams;

      // ── Internal ops (G7/§17.7 admin audit pull): X-Internal-Key, no player JWT ──
      if (path === '/internal/audit/anomalies') {
        if (!internalAuth.verify(req.headers).ok) {
          return sendErr(res, ErrorCode.UNAUTHENTICATED, 'internal endpoint requires X-Internal-Key');
        }
        if (method !== 'GET') return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
        const winQ = q.get('windowSec');
        const windowSec = winQ != null && Number.isFinite(Number(winQ)) ? Number(winQ) : undefined;
        return send(res, 200, ok(await auctionSvc.scanAnomalies(windowSec)));
      }

      // ── JWT verification (extract accountId only, no DB connection) ──
      const token = extractBearer(req.headers['authorization']);
      let accountId: string;
      try {
        if (!token) throw new Error('no bearer');
        accountId = verifyToken(token, { secret: opts.jwtSecret });
      } catch {
        return sendErr(res, ErrorCode.UNAUTHENTICATED, 'authentication required');
      }

      try {
        if (method === 'GET' && path === '/auction/list') {
          const itemType = q.get('itemType') ?? undefined;
          const limit = numQ(q.get('limit'), 20);
          return send(res, 200, ok(await auctionSvc.listAuctions(itemType, limit)));
        }
        if (method === 'GET' && path === '/auction/mine') {
          return send(res, 200, ok(await auctionSvc.getMyListings(accountId)));
        }
        if (method === 'POST' && path === '/auction/create') {
          const body = await readJson(req);
          const itemType = typeof body.itemType === 'string' ? body.itemType : null;
          const item = typeof body.item === 'object' && body.item && !Array.isArray(body.item) ? body.item as Record<string, unknown> : null;
          const qty = Number(body.qty);
          const durationSec = Number(body.durationSec);
          const designatedBuyerId = typeof body.designatedBuyerId === 'string' ? body.designatedBuyerId : undefined;
          const saleMode = body.saleMode === 'auction' ? 'auction' : 'fixed';
          if (!itemType || !item || !Number.isFinite(qty) || !Number.isFinite(durationSec)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'itemType + item + qty + durationSec required');
          }
          // fixed → price required; auction → startPrice required, buyoutPrice optional
          const price = body.price != null ? Number(body.price) : undefined;
          const startPrice = body.startPrice != null ? Number(body.startPrice) : undefined;
          const buyoutPrice = body.buyoutPrice != null ? Number(body.buyoutPrice) : undefined;
          if (saleMode === 'fixed' && !Number.isFinite(price ?? NaN)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'price required for fixed sale');
          }
          if (saleMode === 'auction' && !Number.isFinite(startPrice ?? NaN)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'startPrice required for auction sale');
          }
          return send(res, 200, ok(await auctionSvc.createAuction({
            sellerId: accountId, itemType: itemType as 'material' | 'equipment' | 'card' | 'skin',
            item, qty, durationSec, designatedBuyerId, saleMode,
            ...(price != null ? { price } : {}),
            ...(startPrice != null ? { startPrice } : {}),
            ...(buyoutPrice != null ? { buyoutPrice } : {}),
          })));
        }
        {
          const m = /^\/auction\/([^/]+)\/bid$/.exec(path);
          if (method === 'POST' && m) {
            const body = await readJson(req);
            const amount = Number(body.amount);
            if (!Number.isFinite(amount)) return sendErr(res, ErrorCode.BAD_REQUEST, 'amount required');
            return send(res, 200, ok(await auctionSvc.placeBid(accountId, decodeURIComponent(m[1]!), amount)));
          }
        }
        {
          const m = /^\/auction\/([^/]+)\/buy$/.exec(path);
          if (method === 'POST' && m) {
            return send(res, 200, ok(await auctionSvc.buyAuction(accountId, decodeURIComponent(m[1]!))));
          }
        }
        {
          const m = /^\/auction\/([^/]+)\/cancel$/.exec(path);
          if (method === 'POST' && m) {
            return send(res, 200, ok(await auctionSvc.cancelAuction(accountId, decodeURIComponent(m[1]!))));
          }
        }

        return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
      } catch (e) {
        if (e instanceof SlgError) return sendErr(res, e.code, e.message);
        send(res, 500, err(ErrorCode.INTERNAL, (e as Error).message));
      }
    })();
  });
  server.listen(opts.port, opts.host);
  return server;
}
