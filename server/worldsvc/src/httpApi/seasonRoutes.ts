// worldsvc httpApi split — season resolve/join/transfer + world join/enter (see ../httpApi.ts).
// No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok } from '@nw/shared';
import { readJson, send, sendErr, numQ, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleSeasonRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, q, accountId, svc, nationChannelSvc } = ctx;

  // ── Resolve shard by season (G6/§20): resolve only, no base placement; client fetches worldId before entering the map ──
  if (method === 'POST' && path === '/world/season/resolve') {
    const body = await readJson(req);
    const season = Number(body.season);
    if (!Number.isFinite(season)) { sendErr(res, ErrorCode.BAD_REQUEST, 'season required'); return true; }
    send(res, 200, ok(await svc.resolveSeasonShard(season, accountId)));
    return true;
  }

  // ── Season join (G6/§20): server resolves shard and routes automatically (sect > family > solo random, overflow opens a new region) ──
  if (method === 'POST' && path === '/world/season/join') {
    const body = await readJson(req);
    const season = Number(body.season);
    if (!Number.isFinite(season)) { sendErr(res, ErrorCode.BAD_REQUEST, 'season required'); return true; }
    // System auto-places base (§3.4): no coordinates taken from client, server picks the location.
    send(res, 200, ok(await svc.joinSeason(season, accountId)));
    return true;
  }

  // ── Mid-season shard transfer (G6/§27): list candidate destination shards for the player's current shard ──
  if (method === 'GET' && path === '/world/season/transfer/targets') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    send(res, 200, ok(await svc.listTransferTargets(worldId)));
    return true;
  }

  // ── Mid-season shard transfer (G6/§27): forfeit all shard-scoped state in fromWorldId, re-join toWorldId fresh ──
  if (method === 'POST' && path === '/world/season/transfer') {
    const body = await readJson(req);
    const fromWorldId = typeof body.fromWorldId === 'string' ? body.fromWorldId : null;
    const toWorldId = typeof body.toWorldId === 'string' ? body.toWorldId : null;
    if (!fromWorldId || !toWorldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'fromWorldId/toWorldId required'); return true; }
    send(res, 200, ok(await svc.transferShard(accountId, fromWorldId, toWorldId)));
    return true;
  }

  // ── Join world (S8-1): system auto-places base (§3.4), only worldId required, no coordinates ──
  if (method === 'POST' && path === '/world/join') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    send(res, 200, ok(await svc.joinWorld(worldId, accountId)));
    return true;
  }

  // ── Aggregated SLG-entry fetch (P1-5, comm-audit-2026-07-27): one round-trip replacing the
  // 9-request waterfall WorldMapNet.loadData() used to fire on every world-map entry. The
  // composition itself lives in svc.enterWorld (unit/e2e-testable in isolation); this handler
  // just adds the sibling nationChannelSvc read and shapes the HTTP response. ──
  if (method === 'POST' && path === '/world/enter') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    const r = numQ(typeof body.r === 'number' ? String(body.r) : null, 10);
    const zoom = body.zoom === 2 || body.zoom === 3 ? body.zoom : 1;

    const [entry, worldChannel] = await Promise.all([
      svc.enterWorld(worldId, accountId, r, zoom),
      nationChannelSvc.getChannel(worldId, accountId, undefined, 20),
    ]);
    send(res, 200, ok({
      ...entry,
      me: { ...entry.me, serverNow: Date.now() },
      worldChannel,
    }));
    return true;
  }

  return false;
}
