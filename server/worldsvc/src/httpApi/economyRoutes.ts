// worldsvc httpApi split — defense/teams/troops/build/season-info/shop (see ../httpApi.ts).
// No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok, BUILDING_KEYS, type BuildingKey } from '@nw/shared';
import type { TeamTemplate } from '../db';
import { readJson, send, sendErr, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleEconomyRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, q, accountId, clientPlatform, svc } = ctx;

  // ── Defense config (S8-4 remnant, implemented) ──
  if (method === 'GET' && path === '/world/defense') {
    const worldId = q.get('worldId');
    const tileKey = q.get('tileKey') ?? 'base';
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    send(res, 200, ok(await svc.getDefense(worldId, accountId, tileKey)));
    return true;
  }
  if (method === 'PUT' && path === '/world/defense') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const tileKey = typeof body.tileKey === 'string' ? body.tileKey : 'base';
    const defenseConfig = typeof body.defenseConfig === 'object' && body.defenseConfig && !Array.isArray(body.defenseConfig)
      ? body.defenseConfig as Record<string, unknown>
      : null;
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (!defenseConfig) { sendErr(res, ErrorCode.BAD_REQUEST, 'defenseConfig required'); return true; }
    await svc.setDefense(worldId, accountId, tileKey, defenseConfig);
    send(res, 200, ok({}));
    return true;
  }

  // ── Offensive formation templates (teams, G3-2c) ──
  if (method === 'GET' && path === '/world/teams') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    send(res, 200, ok(await svc.getTeams(worldId, accountId)));
    return true;
  }
  if (method === 'PUT' && path === '/world/teams') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const teams = Array.isArray(body.teams) ? (body.teams as TeamTemplate[]) : null;
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (!teams) { sendErr(res, ErrorCode.BAD_REQUEST, 'teams required'); return true; }
    await svc.setTeams(worldId, accountId, teams);
    send(res, 200, ok({}));
    return true;
  }

  // ── CC-3: card troop distribution + injury recovery ──
  if (method === 'POST' && path === '/world/troops/distribute') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const allocations = body.allocations && typeof body.allocations === 'object' && !Array.isArray(body.allocations) ? (body.allocations as Record<string, number>) : null;
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (!allocations) { sendErr(res, ErrorCode.BAD_REQUEST, 'allocations required'); return true; }
    await svc.distributeTroops(worldId, accountId, allocations);
    send(res, 200, ok({}));
    return true;
  }
  if (method === 'POST' && path === '/world/troops/recover') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const cardInstanceId = typeof body.cardInstanceId === 'string' ? body.cardInstanceId : null;
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (!cardInstanceId) { sendErr(res, ErrorCode.BAD_REQUEST, 'cardInstanceId required'); return true; }
    await svc.recoverCard(worldId, accountId, cardInstanceId, clientPlatform);
    send(res, 200, ok({}));
    return true;
  }

  // ── Training queue (S8-2, implemented) ──
  if (method === 'POST' && path === '/world/troops/train') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const qty = Number(body.qty);
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (!Number.isFinite(qty) || qty < 1) { sendErr(res, ErrorCode.BAD_REQUEST, 'qty required'); return true; }
    send(res, 200, ok(await svc.trainTroops(worldId, accountId, qty)));
    return true;
  }
  if (method === 'POST' && path === '/world/troops/speedup') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const coins = Number(body.coins);
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (!Number.isFinite(coins) || coins < 1) { sendErr(res, ErrorCode.BAD_REQUEST, 'coins required'); return true; }
    send(res, 200, ok(await svc.speedupTraining(worldId, accountId, coins, clientPlatform)));
    return true;
  }

  // ── Home-city buildings (SLG_CITY_DESIGN P1+P2, implemented) ──
  if (method === 'POST' && path === '/world/build/upgrade') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const key = typeof body.key === 'string' ? body.key : null;
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (!key || !BUILDING_KEYS.includes(key as BuildingKey)) { sendErr(res, ErrorCode.BAD_REQUEST, 'valid building key required'); return true; }
    send(res, 200, ok(await svc.upgradeBuilding(worldId, accountId, key as BuildingKey)));
    return true;
  }
  if (method === 'POST' && path === '/world/build/speedup') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const coins = Number(body.coins);
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    if (!Number.isFinite(coins) || coins < 1) { sendErr(res, ErrorCode.BAD_REQUEST, 'coins required'); return true; }
    send(res, 200, ok(await svc.speedupBuild(worldId, accountId, coins, clientPlatform)));
    return true;
  }

  // ── Season (S8-7, implemented) ──
  if (method === 'GET' && path === '/world/season') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    const season = await svc.getSeason(worldId);
    if (!season) { sendErr(res, ErrorCode.NOT_FOUND, 'world not found'); return true; }
    send(res, 200, ok(season));
    return true;
  }

  // ── SLG shop (S8-8, implemented) ──
  if (method === 'GET' && path === '/world/shop/items') {
    send(res, 200, ok(svc.getSlgShopItems()));
    return true;
  }
  if (method === 'POST' && path === '/world/shop/buy') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const itemId = typeof body.itemId === 'string' ? body.itemId : null;
    if (!worldId || !itemId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + itemId required'); return true; }
    send(res, 200, ok(await svc.buySlgShopItem(worldId, accountId, itemId, clientPlatform)));
    return true;
  }

  return false;
}
