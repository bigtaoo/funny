// socialsvc httpApi split — public /social/chat/* direct messages (P2, see ../httpApi.ts for the module
// overview). No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok, CHAT_SEND_RATE_PER_MIN, type ChatRegion } from '@nw/shared';
import { send, sendErr, sendSocialErr, readJson, numQ, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleChatRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, q, accountId, friendSvc } = ctx;

  if (method === 'GET' && path === '/social/chat/conversations') {
    send(res, 200, ok({ conversations: await friendSvc.getConversations(accountId) }));
    return true;
  }
  {
    const m = /^\/social\/chat\/([^/]+)\/messages$/.exec(path);
    if (method === 'GET' && m) {
      const convId = decodeURIComponent(m[1]!);
      const before = q.get('before') ? Number(q.get('before')) : undefined;
      const limit = numQ(q.get('limit'), 30);
      const messages = await friendSvc.getMessages(accountId, convId, before, limit);
      if (messages === null) { sendErr(res, ErrorCode.NOT_FOUND, 'conversation not found'); return true; }
      send(res, 200, ok({ messages }));
      return true;
    }
  }
  if (method === 'POST' && path === '/social/chat/send') {
    const body = await readJson(req);
    const toPublicId = typeof body.toPublicId === 'string' ? body.toPublicId : null;
    const msgBody = typeof body.body === 'string' ? body.body : null;
    if (!toPublicId || !msgBody) { sendErr(res, ErrorCode.BAD_REQUEST, 'toPublicId + body required'); return true; }
    if (!friendSvc.allowChat(accountId, Date.now(), CHAT_SEND_RATE_PER_MIN)) {
      sendErr(res, ErrorCode.RATE_LIMITED, 'too many messages');
      return true;
    }
    const region = (req.headers['x-chat-region'] as ChatRegion | undefined) ?? 'global';
    const r = await friendSvc.sendMessage(accountId, toPublicId, msgBody, region);
    if (r.kind === 'error') { sendSocialErr(res, r.error); return true; }
    send(res, 200, ok({ messageId: r.messageId, ts: r.ts }));
    return true;
  }
  if (method === 'POST' && path === '/social/chat/read') {
    const body = await readJson(req);
    const convId = typeof body.convId === 'string' ? body.convId : null;
    if (!convId) { sendErr(res, ErrorCode.BAD_REQUEST, 'convId required'); return true; }
    await friendSvc.markConversationRead(accountId, convId);
    send(res, 200, ok({ ok: true }));
    return true;
  }

  return false;
}
