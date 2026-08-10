// socialsvc httpApi split — public /social/family/* (see ../httpApi.ts for the module overview). No
// behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok, type ChatRegion } from '@nw/shared';
import { send, sendErr, readJson, numQ, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleFamilyRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, q, accountId, familySvc } = ctx;

  if (method === 'GET' && path === '/social/family/mine') {
    send(res, 200, ok(await familySvc.getMyFamily(accountId)));
    return true;
  }

  if (method === 'GET' && path === '/social/family/search') {
    const tag = q.get('tag');
    if (!tag) { sendErr(res, ErrorCode.BAD_REQUEST, 'tag required'); return true; }
    send(res, 200, ok(await familySvc.searchByTag(tag)));
    return true;
  }

  if (method === 'GET' && path === '/social/family/browse') {
    const query = q.get('q') ?? undefined;
    const limitRaw = q.get('limit');
    const limit = limitRaw ? Number(limitRaw) : 10;
    send(res, 200, ok(await familySvc.browseFamilies(query, limit)));
    return true;
  }

  if (method === 'POST' && path === '/social/family') {
    const body = await readJson(req);
    const name = typeof body.name === 'string' ? body.name : null;
    const tag = typeof body.tag === 'string' ? body.tag : null;
    if (!name || !tag) { sendErr(res, ErrorCode.BAD_REQUEST, 'name + tag required'); return true; }
    const familyRegion = (req.headers['x-chat-region'] as ChatRegion | undefined) ?? 'global';
    send(res, 201, ok(await familySvc.createFamily(accountId, name, tag, familyRegion)));
    return true;
  }

  // Must be checked before the generic GET /social/family/:id route below, since "requests"
  // would otherwise be captured as a familyId by that route's [^/]+ pattern.
  if (method === 'GET' && path === '/social/family/requests') {
    send(res, 200, ok({ requests: await familySvc.listJoinRequests(accountId) }));
    return true;
  }

  {
    const m = /^\/social\/family\/requests\/([^/]+)\/respond$/.exec(path);
    if (method === 'POST' && m) {
      const body = await readJson(req);
      const accept = body.accept === true;
      await familySvc.respondJoinRequest(accountId, decodeURIComponent(m[1]!), accept);
      send(res, 200, ok({}));
      return true;
    }
  }

  {
    const m = /^\/social\/family\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      // Pass the caller's own accountId (2026-08-04 fix): a non-member querying an arbitrary family
      // id gets accountId stripped from the member list (see getFamily's doc comment).
      send(res, 200, ok(await familySvc.getFamily(decodeURIComponent(m[1]!), accountId)));
      return true;
    }
  }

  {
    const m = /^\/social\/family\/([^/]+)\/join$/.exec(path);
    if (method === 'POST' && m) {
      send(res, 200, ok(await familySvc.requestJoin(accountId, decodeURIComponent(m[1]!))));
      return true;
    }
  }

  if (method === 'POST' && path === '/social/family/leave') {
    await familySvc.leaveFamily(accountId);
    send(res, 200, ok({}));
    return true;
  }

  if (method === 'POST' && path === '/social/family/kick') {
    const body = await readJson(req);
    const targetId = typeof body.targetId === 'string' ? body.targetId : null;
    if (!targetId) { sendErr(res, ErrorCode.BAD_REQUEST, 'targetId required'); return true; }
    await familySvc.kickMember(accountId, targetId);
    send(res, 200, ok({}));
    return true;
  }

  if (method === 'POST' && path === '/social/family/role') {
    const body = await readJson(req);
    const targetId = typeof body.targetId === 'string' ? body.targetId : null;
    const role = typeof body.role === 'string' ? body.role : null;
    if (!targetId || !role) { sendErr(res, ErrorCode.BAD_REQUEST, 'targetId + role required'); return true; }
    await familySvc.setRole(accountId, targetId, role as import('@nw/shared').FamilyRole);
    send(res, 200, ok({}));
    return true;
  }

  if (method === 'POST' && path === '/social/family/disband') {
    await familySvc.dissolveFamily(accountId);
    send(res, 200, ok({}));
    return true;
  }

  if (method === 'POST' && path === '/social/family/announcement') {
    const body = await readJson(req);
    const announcement = typeof body.announcement === 'string' ? body.announcement : null;
    if (announcement == null) { sendErr(res, ErrorCode.BAD_REQUEST, 'announcement required'); return true; }
    await familySvc.setAnnouncement(accountId, announcement);
    send(res, 200, ok({}));
    return true;
  }

  {
    const m = /^\/social\/family\/([^/]+)\/messages$/.exec(path);
    if (m) {
      const familyId = decodeURIComponent(m[1]!);
      if (method === 'GET') {
        // Fetch channel history: caller must be a member of the family (validated internally by familyService.getChannel)
        const before = q.get('before') ? Number(q.get('before')) : undefined;
        const limit = numQ(q.get('limit'), 30);
        send(res, 200, ok(await familySvc.getChannel(accountId, before, limit)));
        return true;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const msgBody = typeof body.body === 'string' ? body.body : null;
        const senderName = typeof body.senderName === 'string' ? body.senderName : accountId;
        if (!msgBody) { sendErr(res, ErrorCode.BAD_REQUEST, 'body required'); return true; }
        const familyChatRegion = (req.headers['x-chat-region'] as ChatRegion | undefined) ?? 'global';
        send(res, 200, ok(await familySvc.sendMessage(accountId, senderName, msgBody, familyChatRegion)));
        return true;
      }
      void familyId; // suppress unused var
    }
  }

  return false;
}
