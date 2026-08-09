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
  res.writeHead(status, {
    'content-type': 'application/json',
    // Public-facing surface: CORS aligned with meta (fully open in dev, tightened by reverse proxy in production).
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-internal-key,x-internal-caller,x-nw-platform',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(body));
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
