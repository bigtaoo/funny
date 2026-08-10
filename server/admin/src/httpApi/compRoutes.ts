// admin httpApi split — compensation ticket flow (create/list/preview/approve/reject/cancel/retry, see
// ../httpApi.ts for the module overview). No behavior change — copied verbatim from the original httpApi.ts.
import type { CompTarget } from '@nw/shared';
import { send, requireCap, readJson, str, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleCompRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, url, actor, svc } = ctx;

  if (method === 'POST' && path === '/admin/comp/tickets') {
    const b = await readJson(req);
    // Initiating capability (single/global) is precisely validated by service based on scope.
    const ticket = await svc.initiateTicket(actor, {
      scope: str(b.scope),
      target: b.target as CompTarget,
      mail: b.mail as never,
      reason: str(b.reason),
    });
    send(res, 200, { ok: true, ticket });
    return true;
  }
  if (method === 'GET' && path === '/admin/comp/tickets') {
    requireCap(actor, 'comp.view');
    const status = url.searchParams.get('status');
    const tickets = await svc.listTickets(status ? { status } : {});
    send(res, 200, { ok: true, tickets });
    return true;
  }
  if (method === 'POST' && path === '/admin/comp/preview') {
    const b = await readJson(req);
    send(res, 200, {
      ok: true,
      ...(await svc.preview(actor, { scope: str(b.scope), target: b.target as CompTarget })),
    });
    return true;
  }
  const ticketAction = /^\/admin\/comp\/tickets\/([^/]+)\/(approve|reject|cancel|retry)$/.exec(path);
  if (method === 'POST' && ticketAction) {
    const id = decodeURIComponent(ticketAction[1]!);
    const action = ticketAction[2]!;
    if (action === 'approve') {
      send(res, 200, { ok: true, ticket: await svc.approveTicket(actor, id) });
      return true;
    }
    if (action === 'reject') {
      const b = await readJson(req);
      send(res, 200, { ok: true, ticket: await svc.rejectTicket(actor, id, str(b.note)) });
      return true;
    }
    if (action === 'cancel') {
      send(res, 200, { ok: true, ticket: await svc.cancelTicket(actor, id) });
      return true;
    }
    // retry
    send(res, 200, { ok: true, ticket: await svc.retryTicket(actor, id) });
    return true;
  }

  return false;
}
