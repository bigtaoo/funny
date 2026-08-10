// socialsvc httpApi split — wire-level helpers + the per-request route context every domain handler
// receives (see ../httpApi.ts for the module overview). No behavior change — copied verbatim from the
// original httpApi.ts.
import type { IncomingMessage, ServerResponse } from 'http';
import { ErrorCode, ERROR_HTTP_STATUS, err } from '@nw/shared';
import type { FamilyService } from '../familyService';
import type { FriendService } from '../friendService';
import type { MailService } from '../mailService';
import type { SocialMetaClient } from '../metaClient';
import type { SocialGatewayClient } from '../gatewayClient';

export function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1 << 20) {
        // Stop reading — a settled promise doesn't stop 'data' events, so without destroy() an
        // oversized body kept accumulating into `body` unbounded (OOM risk, P0-9 — this internal-port
        // fix was applied to gateway/matchsvc in the 2026-07-28 comm audit but missed this public port).
        req.destroy();
        reject(new Error('payload too large'));
      }
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

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-internal-key,x-internal-caller,x-nw-platform,x-chat-region',
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

export function sendErr(res: ServerResponse, code: ErrorCode, message: string): void {
  send(res, ERROR_HTTP_STATUS[code] ?? 400, err(code, message));
}

export type SocialError = 'NOT_FOUND' | 'BAD_REQUEST' | 'ALREADY_FRIEND' | 'FRIEND_CAP_REACHED' | 'NOT_FRIEND' | 'BLOCKED' | 'MUTED';
export function sendSocialErr(res: ServerResponse, e: SocialError): void {
  switch (e) {
    case 'NOT_FOUND': return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
    case 'ALREADY_FRIEND': return sendErr(res, ErrorCode.ALREADY_FRIEND, 'already friends');
    case 'FRIEND_CAP_REACHED': return sendErr(res, ErrorCode.FRIEND_CAP_REACHED, 'friend cap reached');
    case 'NOT_FRIEND': return sendErr(res, ErrorCode.NOT_FRIEND, 'not friends');
    case 'BLOCKED': return sendErr(res, ErrorCode.BLOCKED, 'blocked');
    case 'MUTED': return sendErr(res, ErrorCode.ACCOUNT_MUTED, 'muted');
    default: return sendErr(res, ErrorCode.BAD_REQUEST, 'bad request');
  }
}

export const numQ = (v: string | null, d: number): number => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Service dependencies threaded into every route handler (assembled once in ../httpApi.ts). */
export interface RouteDeps {
  familySvc: FamilyService;
  friendSvc: FriendService;
  mailSvc: MailService;
  gateway: SocialGatewayClient;
  meta: SocialMetaClient;
}

/** Context shared by every /internal/* handler (X-Internal-Key auth, no player JWT/accountId). */
export interface BaseCtx extends RouteDeps {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  url: URL;
  q: URLSearchParams;
}

/**
 * Per-request context passed to every public /social/* domain route handler (family/profile/friends/
 * chat/mail). Each handler returns `true` once it has matched a route and sent a response, `false` to
 * let the next handler in the chain try — the shell in ../httpApi.ts tries them in the same order the
 * original if-chain did, so route-matching behavior is unchanged (no two groups match the same
 * method+path).
 */
export interface RouteCtx extends BaseCtx {
  accountId: string;
}
