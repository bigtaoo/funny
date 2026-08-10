// admin httpApi split — commerce/live-ops content management: Paddle webhook event log, limited-time
// events, custom gacha pools (see ../httpApi.ts for the module overview). No behavior change — copied
// verbatim from the original httpApi.ts.
import type { EventInput, CustomPoolConfig } from '@nw/shared';
import { send, requireCap, readJson, numOpt, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleCommerceRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, url, actor, svc } = ctx;

  // ── Paddle webhook event log (support/CS lookup, paddle.events.view) ──
  if (method === 'GET' && path === '/admin/paddle/events') {
    requireCap(actor, 'paddle.events.view');
    const events = await svc.listPaddleEvents({
      accountId: url.searchParams.get('accountId') ?? undefined,
      transactionId: url.searchParams.get('transactionId') ?? undefined,
      limit: numOpt(url.searchParams.get('limit')),
    });
    send(res, 200, { ok: true, events });
    return true;
  }

  // ── Limited-time event management (B6, events.manage) ──
  if (method === 'GET' && path === '/admin/events') {
    requireCap(actor, 'events.manage');
    send(res, 200, { ok: true, events: await svc.listEvents() });
    return true;
  }
  if (method === 'POST' && path === '/admin/events') {
    requireCap(actor, 'events.manage');
    const b = await readJson(req);
    const event = await svc.createEvent(actor, b as unknown as EventInput);
    send(res, 200, { ok: true, event });
    return true;
  }
  const eventPut = /^\/admin\/events\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && eventPut) {
    requireCap(actor, 'events.manage');
    const id = decodeURIComponent(eventPut[1]!);
    const b = await readJson(req);
    const event = await svc.updateEvent(actor, id, b as unknown as EventInput);
    send(res, 200, { ok: true, event });
    return true;
  }
  const eventDel = /^\/admin\/events\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && eventDel) {
    requireCap(actor, 'events.manage');
    const id = decodeURIComponent(eventDel[1]!);
    await svc.deleteEvent(actor, id);
    send(res, 200, { ok: true });
    return true;
  }

  // ── Custom gacha pool management (GACHA_DESIGN §12, gacha.pools.manage) ──
  if (method === 'GET' && path === '/admin/gacha/pools') {
    requireCap(actor, 'gacha.pools.manage');
    send(res, 200, { ok: true, pools: await svc.listGachaPools() });
    return true;
  }
  if (method === 'GET' && path === '/admin/gacha/catalog') {
    requireCap(actor, 'gacha.pools.manage');
    send(res, 200, { ok: true, catalog: await svc.gachaCatalog() });
    return true;
  }
  if (method === 'POST' && path === '/admin/gacha/pools/custom') {
    requireCap(actor, 'gacha.pools.manage');
    const b = await readJson(req);
    const r = await svc.createCustomPool(actor, b as unknown as CustomPoolConfig);
    send(res, 200, { ok: true, id: r.id });
    return true;
  }
  if (method === 'POST' && path === '/admin/gacha/pools/close') {
    requireCap(actor, 'gacha.pools.manage');
    const b = (await readJson(req)) as { id?: string };
    const r = await svc.closeGachaPool(actor, String(b.id ?? ''));
    send(res, 200, { ok: true, id: r.id });
    return true;
  }

  return false;
}
