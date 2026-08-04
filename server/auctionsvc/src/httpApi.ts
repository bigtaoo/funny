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
  createLogger,
} from '@nw/shared';
import type { AuctionService } from './auctionService';

const log = createLogger('auctionsvc');

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return;
      body += c;
      if (body.length > 1 << 20) {
        rejected = true;
        // Stop accumulating and drop the connection — otherwise the "cap" is cosmetic and a
        // caller can force unbounded memory growth by just continuing to send data.
        req.destroy();
        reject(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on('error', (e) => {
      if (!rejected) reject(e);
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-internal-key,x-internal-caller,x-nw-platform',
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

      // ── Internal ops (auction listing lookup): X-Internal-Key, no player JWT ──
      if (path === '/internal/audit/listings') {
        if (!internalAuth.verify(req.headers).ok) {
          return sendErr(res, ErrorCode.UNAUTHENTICATED, 'internal endpoint requires X-Internal-Key');
        }
        if (method !== 'GET') return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
        const sellerId = q.get('sellerId') ?? undefined;
        const itemTypeQ = q.get('itemType') ?? undefined;
        const statusQ = q.get('status') ?? undefined;
        const itemName = q.get('itemName') ?? undefined;
        const limit = numQ(q.get('limit'), 50);
        return send(res, 200, ok(await auctionSvc.queryListings({
          sellerId,
          itemType: itemTypeQ as 'material' | 'equipment' | 'card' | 'skin' | undefined,
          status: statusQ as 'open' | 'sold' | 'cancelled' | 'expired' | undefined,
          itemName,
          limit,
        })));
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
      // X-NW-Platform (ADR-020, comm-audit-internal-2026-07-28 P0-7): which recharged-pool bucket a
      // spend should draw from — auction purchases used to always default to the 'web' bucket.
      const clientPlatformHeader = req.headers['x-nw-platform'];
      const clientPlatform = typeof clientPlatformHeader === 'string' && clientPlatformHeader ? clientPlatformHeader : undefined;

      try {
        if (method === 'GET' && path === '/auction/list') {
          const itemType = q.get('itemType') ?? undefined;
          const limit = numQ(q.get('limit'), 20);
          return send(res, 200, ok(await auctionSvc.listAuctions(itemType, limit, accountId)));
        }
        if (method === 'GET' && path === '/auction/mine') {
          return send(res, 200, ok(await auctionSvc.getMyListings(accountId)));
        }
        if (method === 'GET' && path === '/auction/refprice') {
          const category = q.get('category');
          return send(res, 200, ok(await auctionSvc.getRefBand(category)));
        }
        if (method === 'POST' && path === '/auction/create') {
          const body = await readJson(req);
          const itemType = typeof body.itemType === 'string' ? body.itemType : null;
          const item = typeof body.item === 'object' && body.item && !Array.isArray(body.item) ? body.item as Record<string, unknown> : null;
          const qty = Number(body.qty);
          const durationSec = Number(body.durationSec);
          const designatedBuyerId = typeof body.designatedBuyerId === 'string' ? body.designatedBuyerId : undefined;
          const saleMode = body.saleMode === 'auction' ? 'auction' : 'fixed';
          if (!itemType || !item || !Number.isInteger(qty) || !Number.isFinite(durationSec)) {
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
            return send(res, 200, ok(await auctionSvc.placeBid(accountId, decodeURIComponent(m[1]!), amount, clientPlatform)));
          }
        }
        {
          const m = /^\/auction\/([^/]+)\/buy$/.exec(path);
          if (method === 'POST' && m) {
            return send(res, 200, ok(await auctionSvc.buyAuction(accountId, decodeURIComponent(m[1]!), clientPlatform)));
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
        // Unexpected (non-SlgError) failure: log server-side for diagnosis, but never leak the raw
        // exception message to the client — (e as Error).message can carry internal details (stack
        // traces, file paths, DB error text) that shouldn't reach a player (comm-audit-2026-07-27
        // finding B15; mirrors socialsvc's httpApi.ts equivalent catch-all).
        log.error('unhandled error', { err: e instanceof Error ? e : String(e) });
        send(res, 500, err(ErrorCode.INTERNAL, 'internal server error'));
      }
    })();
  });
  server.listen(opts.port, opts.host);
  return server;
}
