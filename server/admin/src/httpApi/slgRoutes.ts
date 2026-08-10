// admin httpApi split — ladder season ops + SLG (worldsvc-proxied) season/audit/map-template ops (see
// ../httpApi.ts for the module overview). No behavior change — copied verbatim from the original httpApi.ts.
import { AdminError } from '../service';
import { send, requireCap, readJson, str, numOpt, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleSlgRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, url, actor, svc } = ctx;

  // ── Ladder season operations (SE-3) ──
  if (method === 'GET' && path === '/admin/ladder/season/current') {
    requireCap(actor, 'ladder.season.manage');
    const season = await svc.getLadderCurrentSeason();
    send(res, 200, { ok: true, season });
    return true;
  }
  if (method === 'POST' && path === '/admin/ladder/season/roll') {
    requireCap(actor, 'ladder.season.manage');
    const season = await svc.rollLadderSeason(actor.adminId);
    send(res, 200, { ok: true, season });
    return true;
  }

  // ── SLG season operations (G7/§17.7) ──
  if (method === 'GET' && path === '/admin/slg/worlds') {
    requireCap(actor, 'slg.season.view');
    const worlds = await svc.slgListWorlds();
    send(res, 200, { ok: true, worlds });
    return true;
  }
  if (method === 'POST' && path === '/admin/slg/season/open') {
    requireCap(actor, 'slg.season.manage');
    const b = await readJson(req);
    await svc.slgOpenSeason(actor.adminId, str(b.worldId), Number(b.season ?? 1), Number(b.shard ?? 1), Number(b.capacity ?? 10000));
    send(res, 200, { ok: true });
    return true;
  }
  if (method === 'POST' && path === '/admin/slg/season/settle') {
    requireCap(actor, 'slg.season.manage');
    const b = await readJson(req);
    const ranking = await svc.slgSettleSeason(actor.adminId, str(b.worldId));
    send(res, 200, { ok: true, ranking });
    return true;
  }
  if (method === 'POST' && path === '/admin/slg/season/reset') {
    requireCap(actor, 'slg.season.manage');
    const b = await readJson(req);
    const result = await svc.slgResetSeason(actor.adminId, str(b.worldId));
    send(res, 200, { ok: true, result });
    return true;
  }
  if (method === 'POST' && path === '/admin/slg/season/close') {
    requireCap(actor, 'slg.season.manage');
    const b = await readJson(req);
    await svc.slgCloseSeason(actor.adminId, str(b.worldId));
    send(res, 200, { ok: true });
    return true;
  }
  if (method === 'POST' && path === '/admin/slg/season/merge') {
    requireCap(actor, 'slg.season.manage');
    const b = await readJson(req);
    const result = await svc.slgMergeShard(actor.adminId, str(b.worldId), str(b.targetWorldId));
    send(res, 200, { ok: true, result });
    return true;
  }

  // ── SLG anomalous transaction audit (G7 anti-RMT, §17.7) ──
  if (method === 'GET' && path === '/admin/slg/audit/anomalies') {
    requireCap(actor, 'slg.audit.view');
    const worldId = url.searchParams.get('worldId') ?? '';
    if (!worldId) throw new AdminError(400, 'bad_request', 'worldId required');
    const anomalies = await svc.slgScanAnomalies(worldId, numOpt(url.searchParams.get('windowSec')));
    send(res, 200, { ok: true, anomalies });
    return true;
  }
  if (method === 'GET' && path === '/admin/slg/audit/listings') {
    requireCap(actor, 'slg.audit.view');
    const sellerId = url.searchParams.get('sellerId') ?? undefined;
    const itemType = url.searchParams.get('itemType') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const itemName = url.searchParams.get('itemName') ?? undefined;
    const listings = await svc.slgQueryAuctionListings({
      sellerId,
      itemType: itemType as never,
      status: status as never,
      itemName,
      limit: numOpt(url.searchParams.get('limit')),
    });
    send(res, 200, { ok: true, listings });
    return true;
  }
  if (method === 'GET' && path === '/admin/slg/audit/tickets') {
    requireCap(actor, 'slg.audit.view');
    const status = url.searchParams.get('status');
    const tickets = await svc.slgListAuditTickets(status ? { status } : {});
    send(res, 200, { ok: true, tickets });
    return true;
  }
  if (method === 'POST' && path === '/admin/slg/audit/tickets') {
    requireCap(actor, 'slg.audit.manage');
    const b = await readJson(req);
    const ticket = await svc.slgFileAuditTicket(actor, b.snapshot as never);
    send(res, 200, { ok: true, ticket });
    return true;
  }
  const auditResolve = /^\/admin\/slg\/audit\/tickets\/([^/]+)\/resolve$/.exec(path);
  if (method === 'POST' && auditResolve) {
    requireCap(actor, 'slg.audit.manage');
    const id = decodeURIComponent(auditResolve[1]!);
    const b = await readJson(req);
    const ticket = await svc.slgResolveAuditTicket(actor, id, str(b.disposition), str(b.note));
    send(res, 200, { ok: true, ticket });
    return true;
  }

  // ── SLG map templates (§24, admin map editor) ──
  if (method === 'GET' && path === '/admin/slg/map-templates') {
    requireCap(actor, 'slg.map.view');
    send(res, 200, { ok: true, templates: await svc.slgListMapTemplates() });
    return true;
  }
  if (method === 'POST' && path === '/admin/slg/map-templates/generate') {
    requireCap(actor, 'slg.map.manage');
    const b = await readJson(req);
    const summary = await svc.slgGenerateMapTemplate(actor.adminId, str(b.templateId), Number(b.width), Number(b.height));
    send(res, 200, { ok: true, template: summary });
    return true;
  }
  const mapTiles = /^\/admin\/slg\/map-templates\/([^/]+)\/tiles$/.exec(path);
  if (method === 'GET' && mapTiles) {
    requireCap(actor, 'slg.map.view');
    const templateId = decodeURIComponent(mapTiles[1]!);
    const tiles = await svc.slgGetMapTemplateTiles(
      templateId,
      Number(url.searchParams.get('x') ?? '0'),
      Number(url.searchParams.get('y') ?? '0'),
      Number(url.searchParams.get('w') ?? '100'),
      Number(url.searchParams.get('h') ?? '100'),
    );
    send(res, 200, { ok: true, tiles });
    return true;
  }
  if (method === 'PUT' && mapTiles) {
    requireCap(actor, 'slg.map.manage');
    const templateId = decodeURIComponent(mapTiles[1]!);
    const b = await readJson(req);
    const result = await svc.slgSaveMapTemplateTiles(actor.adminId, templateId, Array.isArray(b.tiles) ? (b.tiles as never[]) : []);
    send(res, 200, { ok: true, ...result });
    return true;
  }
  const mapActivate = /^\/admin\/slg\/map-templates\/([^/]+)\/activate$/.exec(path);
  if (method === 'POST' && mapActivate) {
    requireCap(actor, 'slg.map.manage');
    await svc.slgActivateMapTemplate(actor.adminId, decodeURIComponent(mapActivate[1]!));
    send(res, 200, { ok: true });
    return true;
  }
  const mapDelete = /^\/admin\/slg\/map-templates\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && mapDelete) {
    requireCap(actor, 'slg.map.manage');
    await svc.slgDeleteMapTemplate(actor.adminId, decodeURIComponent(mapDelete[1]!));
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}
