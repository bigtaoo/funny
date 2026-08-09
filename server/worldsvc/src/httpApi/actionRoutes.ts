// worldsvc httpApi split — tile actions + march dispatch (see ../httpApi.ts for the module overview).
// No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok, type MarchKind } from '@nw/shared';
import { readJson, send, sendErr, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleActionRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, accountId, clientPlatform, svc } = ctx;

  // ── Abandon / relocate / watchtower (S8-1, implemented, requires coordinates) ──
  // NOTE: `occupyTile` (instant, no-combat) is intentionally NOT exposed here — it's
  // internal/test-only (ADR-037 §5.4) and must only be reachable via svc.occupyTile()
  // from e2e test setup, never over the public player-JWT HTTP surface. The real
  // client-facing occupy flow is POST /world/march with kind:'occupy'.
  if (
    method === 'POST' &&
    (path === '/world/abandon' ||
      path === '/world/relocate' || path === '/world/watchtower')
  ) {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const x = Number(body.x);
    const y = Number(body.y);
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      sendErr(res, ErrorCode.BAD_REQUEST, 'x/y required');
      return true;
    }
    if (path === '/world/relocate') {
      send(res, 200, ok(await svc.relocateBase(worldId, accountId, x, y, clientPlatform)));
      return true;
    }
    if (path === '/world/watchtower') {
      // P1-3: attach `me` (resources spent aren't visible on the tile itself) so the client
      // doesn't need a separate GET /world/me round-trip after every watchtower build.
      const tile = await svc.buildWatchtower(worldId, accountId, x, y);
      send(res, 200, ok({ ...tile, me: await svc.getMe(worldId, accountId) }));
      return true;
    }
    send(res, 200, ok(await svc.abandonTile(worldId, accountId, x, y)));
    return true;
  }

  // ── ADR-051 (P5): build / demolish a player structure (arrowTower / blocker) ──
  if (method === 'POST' && path === '/world/structure') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const x = Number(body.x);
    const y = Number(body.y);
    const kind = body.kind === 'arrowTower' || body.kind === 'blocker' ? body.kind : null;
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) { sendErr(res, ErrorCode.BAD_REQUEST, 'x/y required'); return true; }
    if (!kind) { sendErr(res, ErrorCode.BAD_REQUEST, 'kind must be arrowTower or blocker'); return true; }
    // P1-3: attach `me` — same reasoning as /world/watchtower above.
    {
      const tile = await svc.buildStructure(worldId, accountId, x, y, kind);
      send(res, 200, ok({ ...tile, me: await svc.getMe(worldId, accountId) }));
      return true;
    }
  }
  if (method === 'POST' && path === '/world/structure/demolish') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const x = Number(body.x);
    const y = Number(body.y);
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) { sendErr(res, ErrorCode.BAD_REQUEST, 'x/y required'); return true; }
    send(res, 200, ok(await svc.demolishStructure(worldId, accountId, x, y)));
    return true;
  }

  // ── March (S8-2, implemented) ──
  if (method === 'POST' && path === '/world/march') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const fromX = Number(body.fromX);
    const fromY = Number(body.fromY);
    const toX = Number(body.toX);
    const toY = Number(body.toY);
    const kind = typeof body.kind === 'string' ? body.kind : '';
    const troops = Number(body.troops);
    const teamId = typeof body.teamId === 'string' ? body.teamId : undefined;
    // ADR-051 (P3a): 'move' dispatch intent — 'garrison' parks the team as a 驻扎 garrison (defends 9 cells);
    // anything else (default) keeps 停留 idle. Only honored for kind='move'.
    const stationMode = body.stationMode === 'garrison' ? 'garrison' : undefined;
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
      sendErr(res, ErrorCode.BAD_REQUEST, 'fromX/fromY/toX/toY required');
      return true;
    }
    {
      // P1-3: attach `me` (troops/resources committed to the march aren't visible on the march
      // itself) — the client adopts this directly and locally appends the march to its cached
      // list, instead of following up with GET /world/march + GET /world/me.
      const march = await svc.startMarch(worldId, accountId, fromX, fromY, toX, toY, kind as MarchKind, troops, teamId, stationMode);
      send(res, 200, ok({ ...march, me: await svc.getMe(worldId, accountId) }));
      return true;
    }
  }
  {
    const m = /^\/world\/march\/([^/]+)\/recall$/.exec(path);
    if (method === 'POST' && m) {
      const body = await readJson(req);
      const worldId = typeof body.worldId === 'string' ? body.worldId : null;
      if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
      send(res, 200, ok(await svc.recallMarch(worldId, accountId, decodeURIComponent(m[1]!))));
      return true;
    }
  }
  {
    // 2026-08-01 (SLG_DESIGN_LOG §46): pay coins to instantly complete an in-transit 'return' march.
    const m = /^\/world\/march\/([^/]+)\/instant-return$/.exec(path);
    if (method === 'POST' && m) {
      const body = await readJson(req);
      const worldId = typeof body.worldId === 'string' ? body.worldId : null;
      if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
      send(res, 200, ok(await svc.instantReturnMarch(worldId, accountId, decodeURIComponent(m[1]!), clientPlatform)));
      return true;
    }
  }

  // ── Team management "取消指令" (2026-07-15): force an occupation-hold team back to idle ──
  {
    const m = /^\/world\/team\/([^/]+)\/cancel-occupation$/.exec(path);
    if (method === 'POST' && m) {
      const body = await readJson(req);
      const worldId = typeof body.worldId === 'string' ? body.worldId : null;
      if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
      await svc.cancelOccupation(worldId, accountId, decodeURIComponent(m[1]!));
      send(res, 200, ok({}));
      return true;
    }
  }

  // ── Recall a stationed team home (2026-07-23): dispatch a return leg tile→base, freeing the team ──
  {
    const m = /^\/world\/team\/([^/]+)\/recall-stationed$/.exec(path);
    if (method === 'POST' && m) {
      const body = await readJson(req);
      const worldId = typeof body.worldId === 'string' ? body.worldId : null;
      if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
      send(res, 200, ok(await svc.recallStationed(worldId, accountId, decodeURIComponent(m[1]!))));
      return true;
    }
  }

  // ── Sweep (S8-3, §14.6 convenience alias = march kind:'sweep') ──
  if (method === 'POST' && path === '/world/sweep') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const fromX = Number(body.fromX);
    const fromY = Number(body.fromY);
    const toX = Number(body.toX);
    const toY = Number(body.toY);
    const troops = Number(body.troops);
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
      sendErr(res, ErrorCode.BAD_REQUEST, 'fromX/fromY/toX/toY required');
      return true;
    }
    send(res, 200, ok(await svc.startMarch(worldId, accountId, fromX, fromY, toX, toY, 'sweep', troops)));
    return true;
  }

  return false;
}
