// worldsvc httpApi split — map/territory reads (see ../httpApi.ts for the module overview).
// No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok } from '@nw/shared';
import { send, sendErr, numQ, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleMapRoutes(ctx: RouteCtx): Promise<boolean> {
  const { res, method, path, q, accountId, svc } = ctx;

  // ── Map and territory (GET, implemented) ──
  if (method === 'GET' && path === '/world/me') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    // serverNow (P1-1 clock-offset sample): getMe is the highest-frequency SLG round-trip, so
    // it's the natural place for the client to (re-)calibrate against server-issued epoch
    // timestamps (march ETA, build/train queue completeAt, …) — see client/src/net/serverClock.ts.
    send(res, 200, ok({ ...(await svc.getMe(worldId, accountId)), serverNow: Date.now() }));
    return true;
  }
  if (method === 'GET' && path === '/world/map') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    const view = await svc.getMap(
      worldId,
      accountId,
      numQ(q.get('cx'), 0),
      numQ(q.get('cy'), 0),
      numQ(q.get('r'), 10),
    );
    send(res, 200, ok(view));
    return true;
  }
  if (method === 'GET' && path === '/world/map/sparse') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    const lod = q.get('lod') === 'mid' ? 'mid' : 'thin';
    const view = await svc.getMapSparse(
      worldId,
      accountId,
      numQ(q.get('cx'), 0),
      numQ(q.get('cy'), 0),
      numQ(q.get('r'), 10),
      lod,
    );
    send(res, 200, ok(view));
    return true;
  }
  if (method === 'GET' && path.startsWith('/world/tile/')) {
    const tid = decodeURIComponent(path.slice('/world/tile/'.length));
    const parts = tid.split(':');
    if (parts.length !== 3) { sendErr(res, ErrorCode.BAD_REQUEST, 'bad tileId'); return true; }
    const worldId = parts[0]!;
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      sendErr(res, ErrorCode.BAD_REQUEST, 'bad tileId coords');
      return true;
    }
    send(res, 200, ok(await svc.getTile(worldId, accountId, x, y)));
    return true;
  }

  // ── March list (S8-2, implemented) ──
  if (method === 'GET' && path === '/world/march') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    send(res, 200, ok(await svc.getMarches(worldId, accountId)));
    return true;
  }

  // ── Occupation-hold list (2026-07-15, team management status + cancel) ──
  if (method === 'GET' && path === '/world/occupations') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    send(res, 200, ok(await svc.getOccupations(worldId, accountId)));
    return true;
  }

  // ── Stationed-team list (2026-07-23, field-stationing status + recall + idle-sprite rendering) ──
  if (method === 'GET' && path === '/world/stationed') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    send(res, 200, ok(await svc.getStationed(worldId, accountId)));
    return true;
  }

  // ── Wild-city siege state (ADR-074 P1): the ~64 city nodes with live durability / owning sect ──
  // The same payload `POST /world/enter` already embeds. This route exists so the city info panel can
  // REFRESH while it is open (durability regenerates continuously and other sects are hitting the same
  // walls) without re-running the whole map entry. Deliberately not pushed: a durability hit lands up to
  // dozens of times an hour per city, and fanning each one out to ≤900 sect members would be a push
  // faucet — capture, the event that actually matters, announces itself on the sect channel instead.
  if (method === 'GET' && path === '/world/cities') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    send(res, 200, ok(await svc.getCityViews(worldId)));
    return true;
  }

  // ── Territory Overview panel (2026-07-16, SLG_DESIGN_LOG.md §26): full list of owned tiles ──
  if (method === 'GET' && path === '/world/territories') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    send(res, 200, ok(await svc.listTerritories(worldId, accountId)));
    return true;
  }

  return false;
}
