// admin httpApi split — commerce/live-ops content management: promo codes, Paddle webhook event log,
// limited-time events, custom gacha pools (see ../httpApi.ts for the module overview). No behavior
// change — copied verbatim from the original httpApi.ts.
import type { EventInput, CustomPoolConfig } from '@nw/shared';
import { AdminError } from '../service';
import { send, requireCap, readJson, numOpt, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleCommerceRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, url, actor, svc } = ctx;

  // ── Promo code management (B-PROMO, promo.manage) ──
  // Restored 2026-08-20: these two routes existed from B-PROMO's original landing (2026-06-29) and were
  // deleted on 2026-07-28 by the dead-internal-endpoint sweep precisely because no ops page called them
  // ("left in place in case they're wired up later" — the service/client layers below survived). That made
  // the mint side unreachable while /promo/redeem stayed live for players, so codes could only be created
  // by hand-curling meta with the internal key. The ops page (pages/promo.ts) is what closes the loop.
  if (method === 'GET' && path === '/admin/promo/codes') {
    requireCap(actor, 'promo.manage');
    send(res, 200, { ok: true, codes: await svc.listPromoCodes() });
    return true;
  }
  if (method === 'POST' && path === '/admin/promo/codes') {
    requireCap(actor, 'promo.manage');
    const b = await readJson(req);
    const code = typeof b.code === 'string' ? b.code : '';
    const coins = typeof b.coins === 'number' ? b.coins : 0;
    if (!code || coins <= 0) throw new AdminError(400, 'bad_request', 'code + coins required');
    const result = await svc.createPromoCode(actor, {
      code,
      coins,
      ...(typeof b.expiresAt === 'number' ? { expiresAt: b.expiresAt } : {}),
      ...(typeof b.totalLimit === 'number' ? { totalLimit: b.totalLimit } : {}),
      ...(typeof b.note === 'string' && b.note ? { note: b.note } : {}),
    });
    send(res, 200, { ok: true, ...result });
    return true;
  }

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
