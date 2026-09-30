// socialsvc httpApi split — /internal/reports/* (UGC report ops/admin review queue, design-doc-audit-
// 2026-07 COMPLIANCE_GLOBAL.md §7; status filter + resolve added CONTENT_MODERATION_DESIGN.md CM9/P4).
// See ../httpApi.ts for the module overview. No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok } from '@nw/shared';
import { send, sendErr, readJson, numQ, type BaseCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleInternalReportsRoutes(ctx: BaseCtx): Promise<boolean> {
  const { req, res, method, path, q, friendSvc } = ctx;

  if (method === 'GET' && path === '/internal/reports') {
    const limit = numQ(q.get('limit'), 200);
    const statusQ = q.get('status');
    const status = statusQ === 'dismissed' || statusQ === 'upheld' || statusQ === 'open' ? statusQ : 'open';
    send(res, 200, ok({ reports: await friendSvc.listReports(status, limit) }));
    return true;
  }

  // Resolve a report (CM9): admin backend is the sole caller, and separately calls metaserver's
  // penalty endpoint when resolution='upheld' (CM7's single enforcement path — this endpoint never
  // touches reputationScore itself).
  {
    const m = /^\/internal\/reports\/([^/]+)\/resolve$/.exec(path);
    if (method === 'POST' && m) {
      const id = decodeURIComponent(m[1]!);
      const body = await readJson(req);
      const resolution = body.resolution;
      if (resolution !== 'dismissed' && resolution !== 'upheld') {
        sendErr(res, ErrorCode.BAD_REQUEST, 'resolution must be dismissed or upheld');
        return true;
      }
      const resolvedBy = typeof body.resolvedBy === 'string' ? body.resolvedBy : 'unknown';
      const okResolved = await friendSvc.resolveReport(id, resolution, resolvedBy);
      if (!okResolved) { sendErr(res, ErrorCode.NOT_FOUND, 'report not found or already resolved'); return true; }
      send(res, 200, ok({}));
      return true;
    }
  }

  // Staff content removal (App Store Review Guideline 1.2 — remove reported content within 24h). Admin is the
  // sole caller; it routes sect/world content to worldsvc's twin endpoints instead.
  if (method === 'POST' && path === '/internal/moderation/delete-content') {
    const body = await readJson(req);
    const channel = body.channel;
    if (channel !== 'dm' && channel !== 'family' && channel !== 'announcement') {
      sendErr(res, ErrorCode.BAD_REQUEST, 'channel must be dm, family or announcement');
      return true;
    }
    const messageId = typeof body.messageId === 'string' && body.messageId ? body.messageId : undefined;
    const targetId = typeof body.targetId === 'string' && body.targetId ? body.targetId : undefined;
    if (channel === 'announcement' ? !targetId : !messageId) {
      sendErr(res, ErrorCode.BAD_REQUEST, channel === 'announcement' ? 'targetId required' : 'messageId required');
      return true;
    }
    send(res, 200, ok({ deleted: await friendSvc.deleteContent(channel, messageId, targetId) }));
    return true;
  }
  if (method === 'POST' && path === '/internal/moderation/purge-author') {
    const body = await readJson(req);
    const accountId = typeof body.accountId === 'string' && body.accountId ? body.accountId : null;
    if (!accountId) { sendErr(res, ErrorCode.BAD_REQUEST, 'accountId required'); return true; }
    send(res, 200, ok(await friendSvc.purgeAuthor(accountId)));
    return true;
  }

  return false;
}
