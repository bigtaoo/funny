// socialsvc httpApi split — public /social/friends/* + /social/badges (P2, see ../httpApi.ts for the
// module overview). No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok } from '@nw/shared';
import { send, sendErr, sendSocialErr, readJson, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleFriendRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, accountId, friendSvc } = ctx;

  if (method === 'GET' && path === '/social/friends') {
    send(res, 200, ok({ friends: await friendSvc.getFriends(accountId) }));
    return true;
  }
  if (method === 'GET' && path === '/social/friends/requests') {
    send(res, 200, ok(await friendSvc.listRequests(accountId)));
    return true;
  }
  if (method === 'GET' && path === '/social/badges') {
    send(res, 200, ok(await friendSvc.getSocialBadges(accountId)));
    return true;
  }
  if (method === 'POST' && path === '/social/friends/search') {
    const body = await readJson(req);
    const publicId = typeof body.publicId === 'string' ? body.publicId : null;
    if (!publicId) { sendErr(res, ErrorCode.BAD_REQUEST, 'publicId required'); return true; }
    const found = await friendSvc.searchFriend(publicId);
    if (!found) { sendErr(res, ErrorCode.NOT_FOUND, 'player not found'); return true; }
    send(res, 200, ok(found));
    return true;
  }
  if (method === 'POST' && path === '/social/friends/request') {
    const body = await readJson(req);
    const publicId = typeof body.publicId === 'string' ? body.publicId : null;
    const message = typeof body.message === 'string' ? body.message : undefined;
    if (!publicId) { sendErr(res, ErrorCode.BAD_REQUEST, 'publicId required'); return true; }
    const r2 = await friendSvc.requestFriend(accountId, publicId, message);
    if (r2.kind === 'error') { sendSocialErr(res, r2.error); return true; }
    send(res, 200, ok({ requestId: r2.requestId }));
    return true;
  }
  if (method === 'POST' && path === '/social/friends/respond') {
    const body = await readJson(req);
    const requestId = typeof body.requestId === 'string' ? body.requestId : null;
    const accept = typeof body.accept === 'boolean' ? body.accept : null;
    if (!requestId || accept === null) { sendErr(res, ErrorCode.BAD_REQUEST, 'requestId + accept required'); return true; }
    const r2 = await friendSvc.respondFriend(accountId, requestId, accept);
    if (r2.kind === 'error') { sendSocialErr(res, r2.error); return true; }
    send(res, 200, ok({ ok: true }));
    return true;
  }
  {
    const m = /^\/social\/friends\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && m) {
      await friendSvc.removeFriend(accountId, decodeURIComponent(m[1]!));
      send(res, 200, ok({ ok: true }));
      return true;
    }
  }
  if (method === 'POST' && path === '/social/friends/block') {
    const body = await readJson(req);
    const publicId = typeof body.publicId === 'string' ? body.publicId : null;
    if (!publicId) { sendErr(res, ErrorCode.BAD_REQUEST, 'publicId required'); return true; }
    const ok2 = await friendSvc.blockUser(accountId, publicId);
    if (!ok2) { sendErr(res, ErrorCode.NOT_FOUND, 'player not found'); return true; }
    send(res, 200, ok({ ok: true }));
    return true;
  }
  {
    const m = /^\/social\/friends\/block\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && m) {
      await friendSvc.unblockUser(accountId, decodeURIComponent(m[1]!));
      send(res, 200, ok({ ok: true }));
      return true;
    }
  }
  // UGC report (design-doc-audit-2026-07, COMPLIANCE_GLOBAL.md §7 "测试期最低线" — pairs with block above).
  if (method === 'POST' && path === '/social/friends/report') {
    const body = await readJson(req);
    const publicId = typeof body.publicId === 'string' ? body.publicId : null;
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (!publicId) { sendErr(res, ErrorCode.BAD_REQUEST, 'publicId required'); return true; }
    const ok2 = await friendSvc.reportUser(accountId, publicId, reason);
    if (!ok2) { sendErr(res, ErrorCode.NOT_FOUND, 'player not found'); return true; }
    send(res, 200, ok({ ok: true }));
    return true;
  }

  return false;
}
