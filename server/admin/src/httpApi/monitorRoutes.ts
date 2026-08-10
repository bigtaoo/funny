// admin httpApi split — monitoring + analytics + PvP balance reporting (see ../httpApi.ts for the module
// overview). No behavior change — copied verbatim from the original httpApi.ts.
import { send, requireCap, numOpt, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleMonitorRoutes(ctx: RouteCtx): Promise<boolean> {
  const { res, method, path, url, actor, svc } = ctx;

  // ── Monitoring ──
  if (method === 'GET' && path === '/admin/monitor/live') {
    requireCap(actor, 'monitor.view');
    send(res, 200, { ok: true, ...(await svc.liveStats()) });
    return true;
  }
  if (method === 'GET' && path === '/admin/monitor/trend') {
    requireCap(actor, 'monitor.view');
    const points = await svc.trend({
      metric: url.searchParams.get('metric') ?? '',
      from: numOpt(url.searchParams.get('from')),
      to: numOpt(url.searchParams.get('to')),
    });
    send(res, 200, { ok: true, points });
    return true;
  }

  // ── Analytics ──
  if (method === 'GET' && path === '/admin/analytics/summary') {
    requireCap(actor, 'analytics.view');
    send(res, 200, { ok: true, ...(await svc.analyticsSummary()) });
    return true;
  }
  if (method === 'GET' && path === '/admin/analytics/events') {
    requireCap(actor, 'analytics.view');
    const type = url.searchParams.get('type') ?? 'event_counts';
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? '7')));
    const platform = url.searchParams.get('platform') ?? undefined;
    send(res, 200, { ok: true, ...(await svc.analyticsQuery(type, days, platform)) });
    return true;
  }

  // ── PvP card win-rate report (BALANCE data pipeline P1) ──
  if (method === 'GET' && path === '/admin/pvp-card-stats') {
    requireCap(actor, 'analytics.view');
    const mode = url.searchParams.get('mode') ?? undefined;
    const since = url.searchParams.get('since') ?? undefined;
    const cards = await svc.listPvpCardStats({ mode, since });
    send(res, 200, { ok: true, cards });
    return true;
  }

  return false;
}
