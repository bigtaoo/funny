// admin httpApi split — wire-level helpers + auth/capability checks + the per-request route context
// every domain handler receives (see ../httpApi.ts for the module overview). No behavior change —
// copied verbatim from the original httpApi.ts.
import type { IncomingMessage, ServerResponse } from 'http';
import { verifyToken, roleHasCapability, type AdminCapability, type InternalAuthVerifier, type JwtConfig } from '@nw/shared';
import { AdminError, type Actor, type AdminService } from '../service';

export function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
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

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  });
  res.end(JSON.stringify(body));
}

export function clientIp(req: IncomingMessage): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? undefined;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const numOpt = (v: string | null): number | undefined => {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Extracts the authenticated actor; throws AdminError(401) on failure. */
export async function authenticate(req: IncomingMessage, jwt: JwtConfig, svc: AdminService): Promise<Actor> {
  const header = req.headers['authorization'];
  const m = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  if (!m) throw new AdminError(401, 'unauthorized', 'missing bearer token');
  let adminId: string;
  try {
    adminId = verifyToken(m[1]!, jwt);
  } catch {
    throw new AdminError(401, 'unauthorized', 'invalid token');
  }
  const doc = await svc.getAccount(adminId);
  if (!doc || doc.disabled) throw new AdminError(401, 'unauthorized', 'account disabled or gone');
  return { adminId: doc._id, username: doc.username, displayName: doc.displayName, role: doc.role };
}

export function requireCap(actor: Actor, cap: AdminCapability): void {
  if (!roleHasCapability(actor.role, cap)) {
    throw new AdminError(403, 'forbidden', `missing capability: ${cap}`);
  }
}

/** Service dependencies threaded into every route handler (assembled once in ../httpApi.ts). */
export interface RouteDeps {
  svc: AdminService;
  jwt: JwtConfig; // admin-specific secret + ttl
  /** Internal service authentication (X-Internal-Key): database-less backends poll GET /admin/internal/flags to fetch raw flag rules. */
  internalAuth: InternalAuthVerifier;
}

/** Context shared by every handler that runs before an admin JWT actor exists (preAuth + login). */
export interface BaseCtx extends RouteDeps {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  url: URL;
}

/**
 * Per-request context passed to every post-authenticate domain route handler (monitor/player/
 * trustSafety/comp/opsConfig/account/slg/commerce routes). Each handler returns `true` once it has
 * matched a route and sent a response, `false` to let the next handler in the chain try — the shell
 * in ../httpApi.ts tries them in the same order the original if-chain did, so route-matching behavior
 * is unchanged (no two groups match the same method+path).
 */
export interface RouteCtx extends BaseCtx {
  actor: Actor;
}
