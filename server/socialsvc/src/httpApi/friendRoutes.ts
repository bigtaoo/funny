// socialsvc httpApi split — public /social/friends/* + /social/badges (P2, see ../httpApi.ts for the
// module overview). No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok, isReportCategory, isReportChannel, type ChatRegion } from '@nw/shared';
import type { ReportInput } from '../friend/types';
import { send, sendErr, sendSocialErr, readJson, type RouteCtx } from './helpers';

/**
 * Parse the optional Guideline 1.2 report detail shared by /social/friends/report and /social/friends/block.
 * Absent fields are simply omitted; a present-but-invalid category/channel is a client bug → string error (400).
 */
export function parseReportInput(body: Record<string, unknown>): ReportInput | string {
  const out: ReportInput = {};
  if (typeof body.reason === 'string') out.reason = body.reason;
  if (body.category !== undefined) {
    if (!isReportCategory(body.category)) return 'invalid category';
    out.category = body.category;
  }
  if (body.content !== undefined) {
    const c = body.content as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || !isReportChannel(c.channel)) return 'invalid content.channel';
    out.content = {
      channel: c.channel,
      ...(typeof c.messageId === 'string' && c.messageId ? { messageId: c.messageId } : {}),
      ...(typeof c.text === 'string' ? { text: c.text } : {}),
    };
  }
  return out;
}

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
    const region = (req.headers['x-chat-region'] as ChatRegion | undefined) ?? 'global';
    const r2 = await friendSvc.requestFriend(accountId, publicId, message, region);
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
  // Blocked list (Guideline 1.2): the client hides these senders from every chat feed, incl. sect/world.
  if (method === 'GET' && path === '/social/friends/blocked') {
    send(res, 200, ok({ blocked: await friendSvc.listBlocked(accountId) }));
    return true;
  }
  if (method === 'POST' && path === '/social/friends/block') {
    const body = await readJson(req);
    const publicId = typeof body.publicId === 'string' ? body.publicId : null;
    if (!publicId) { sendErr(res, ErrorCode.BAD_REQUEST, 'publicId required'); return true; }
    const input = parseReportInput(body);
    if (typeof input === 'string') { sendErr(res, ErrorCode.BAD_REQUEST, input); return true; }
    const ok2 = await friendSvc.blockUser(accountId, publicId, input);
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
    if (!publicId) { sendErr(res, ErrorCode.BAD_REQUEST, 'publicId required'); return true; }
    const input = parseReportInput(body);
    if (typeof input === 'string') { sendErr(res, ErrorCode.BAD_REQUEST, input); return true; }
    const ok2 = await friendSvc.reportUser(accountId, publicId, input);
    if (!ok2) { sendErr(res, ErrorCode.NOT_FOUND, 'player not found'); return true; }
    send(res, 200, ok({ ok: true }));
    return true;
  }

  return false;
}
