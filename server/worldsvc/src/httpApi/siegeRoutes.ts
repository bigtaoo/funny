// worldsvc httpApi split — siege replay/list (see ../httpApi.ts for the module overview).
// No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok } from '@nw/shared';
import { send, sendErr, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleSiegeRoutes(ctx: RouteCtx): Promise<boolean> {
  const { res, method, path, q, accountId, svc } = ctx;

  // ── Siege replay spectator view (G3-2c, seed + both-side formations, readable by both attacker and defender) ──
  {
    const m = /^\/world\/siege\/([^/]+)\/replay$/.exec(path);
    if (method === 'GET' && m) {
      const worldId = q.get('worldId');
      if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
      send(res, 200, ok(await svc.getSiegeReplay(worldId, accountId, decodeURIComponent(m[1]!))));
      return true;
    }
  }

  // ── Recent sieges list (replay browser, last-100): the requester's battle reports as attacker or defender ──
  if (method === 'GET' && path === '/world/sieges') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    const limitRaw = q.get('limit');
    const limit = limitRaw != null ? Number(limitRaw) : undefined;
    send(res, 200, ok(await svc.listSieges(worldId, accountId, limit)));
    return true;
  }

  return false;
}
