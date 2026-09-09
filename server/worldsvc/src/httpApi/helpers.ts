// worldsvc httpApi split — wire-level helpers + the per-request route context every domain
// handler receives (see ../httpApi.ts for the module overview). No behavior change — copied
// verbatim from the original httpApi.ts.
import type { IncomingMessage, ServerResponse } from 'http';
import { ErrorCode, ERROR_HTTP_STATUS, err, MAX_DISPLAY_NAME_LEN } from '@nw/shared';
import type { WorldService } from '../service';
import type { SectService } from '../sectService';
import type { NationChannelService } from '../nationChannelService';
import type { WorldSocialsvcClient } from '../socialsvcClient';
import type { MapTemplateService } from '../mapTemplateService';

export function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
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

export function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body) ?? 'null', 'utf8');
  const hasBody = status !== 204 && status !== 304; // a 204/304 must not carry one, nor a content-length
  res.writeHead(status, {
    'content-type': 'application/json',
    // Declare the length instead of letting node fall back to chunked framing. This is not about the
    // few bytes of chunk headers — it is what makes the reverse proxy's size threshold
    // (`gzip_min_length` in client/nginx.conf, `encode`'s equivalent in server/Caddyfile) work at all:
    // nginx cannot honour a minimum size on a response whose size it does not know, so with chunked
    // framing it compresses EVERYTHING, and a 31-byte `/world/active-season` reply went out as 51 bytes
    // (measured 2026-09-09 on the local stack, WORLDSVC_CONCURRENCY_AUDIT §8 — gzip's own header is
    // ~20 bytes, so tiny JSON grows). With the length declared, the proxy compresses the map payloads
    // (523KB → 30KB) and leaves the small ones alone.
    ...(hasBody ? { 'content-length': String(payload.byteLength) } : {}),
    // Public-facing surface: CORS aligned with meta (fully open in dev, tightened by reverse proxy in production).
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-internal-key,x-internal-caller,x-nw-platform',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(hasBody ? payload : undefined);
}

export function sendErr(res: ServerResponse, code: ErrorCode, message: string): void {
  send(res, ERROR_HTTP_STATUS[code] ?? 400, err(code, message));
}

export const NOT_IMPL = (res: ServerResponse, what: string): void =>
  sendErr(res, ErrorCode.NOT_IMPLEMENTED, `${what} not implemented (S8-1~5)`);

export const numQ = (v: string | null, d: number): number => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

// Client-supplied `senderName` is only ever used as a fallback when the meta profile lookup is
// degraded/unreachable (the normal path resolves the server-authoritative displayName instead) —
// but a degraded window is still reachable in production, so it must be sanitized before it's
// broadcast into a chat channel: strip control chars, collapse whitespace, cap length.
export function sanitizeSenderNameFallback(raw: string, accountId: string): string {
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_DISPLAY_NAME_LEN);
  return cleaned || accountId;
}

/** Service dependencies threaded into every route handler (assembled once in ../httpApi.ts). */
export interface RouteDeps {
  svc: WorldService;
  sectSvc: SectService;
  nationChannelSvc: NationChannelService;
  socialsvc: WorldSocialsvcClient;
  mapTemplateSvc: MapTemplateService;
}

/**
 * Per-request context passed to every post-JWT domain route handler (mapRoutes/seasonRoutes/
 * actionRoutes/economyRoutes/siegeRoutes/sectRoutes/nationRoutes). Each handler returns `true`
 * once it has matched a route and sent a response, `false` to let the next handler in the chain
 * try — the shell in ../httpApi.ts tries them in the same order the original if-chain did, so
 * route-matching behavior is unchanged (no two groups match the same method+path).
 */
export interface RouteCtx extends RouteDeps {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  q: URLSearchParams;
  accountId: string;
  clientPlatform: string | undefined;
}
