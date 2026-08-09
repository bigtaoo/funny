// worldsvc httpApi split — sect (S8-4b, see ../httpApi.ts for the module overview).
// No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok, regionFromAcceptLanguage } from '@nw/shared';
import { readJson, send, sendErr, sanitizeSenderNameFallback, numQ, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleSectRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, q, accountId, clientPlatform, sectSvc } = ctx;

  if (method === 'GET' && path === '/sect/list') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    send(res, 200, ok(await sectSvc.listSects(worldId)));
    return true;
  }
  {
    const m = /^\/sect\/([^/]+)$/.exec(path);
    if (method === 'GET' && m && path !== '/sect/list' && path !== '/sect/channel') {
      send(res, 200, ok(await sectSvc.getSect(decodeURIComponent(m[1]!))));
      return true;
    }
  }
  if (method === 'POST' && path === '/sect/create') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const name = typeof body.name === 'string' ? body.name : null;
    const tag = typeof body.tag === 'string' ? body.tag : null;
    if (!worldId || !name || !tag) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + name + tag required'); return true; }
    const sectRegion = regionFromAcceptLanguage(req.headers['accept-language']);
    send(res, 200, ok(await sectSvc.createSect(worldId, accountId, name, tag, clientPlatform, sectRegion)));
    return true;
  }
  if (method === 'POST' && path === '/sect/join') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const sectId = typeof body.sectId === 'string' ? body.sectId : null;
    if (!worldId || !sectId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + sectId required'); return true; }
    await sectSvc.joinSect(worldId, accountId, sectId);
    send(res, 200, ok({}));
    return true;
  }
  if (method === 'POST' && path === '/sect/leave') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    await sectSvc.leaveSect(worldId, accountId);
    send(res, 200, ok({}));
    return true;
  }
  if (method === 'POST' && path === '/sect/dissolve') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    await sectSvc.dissolveSect(worldId, accountId);
    send(res, 200, ok({}));
    return true;
  }
  if (method === 'POST' && path === '/sect/ally') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const targetSectId = typeof body.targetSectId === 'string' ? body.targetSectId : null;
    if (!worldId || !targetSectId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + targetSectId required'); return true; }
    await sectSvc.allySect(worldId, accountId, targetSectId);
    send(res, 200, ok({}));
    return true;
  }
  if (method === 'POST' && path === '/sect/unally') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const targetSectId = typeof body.targetSectId === 'string' ? body.targetSectId : null;
    if (!worldId || !targetSectId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + targetSectId required'); return true; }
    await sectSvc.unallySect(worldId, accountId, targetSectId);
    send(res, 200, ok({}));
    return true;
  }
  if (method === 'POST' && path === '/sect/vote-remove-leader') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const nomineeFamilyId = typeof body.nomineeFamilyId === 'string' ? body.nomineeFamilyId : null;
    if (!worldId || !nomineeFamilyId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + nomineeFamilyId required'); return true; }
    send(res, 200, ok(await sectSvc.voteRemoveLeader(worldId, accountId, nomineeFamilyId)));
    return true;
  }
  if (method === 'POST' && path === '/sect/message') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const msgBody = typeof body.body === 'string' ? body.body : null;
    const senderName = sanitizeSenderNameFallback(typeof body.senderName === 'string' ? body.senderName : '', accountId);
    if (!worldId || !msgBody) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + body required'); return true; }
    const sectRegion = regionFromAcceptLanguage(req.headers['accept-language']);
    send(res, 200, ok(await sectSvc.sendMessage(worldId, accountId, senderName, msgBody, sectRegion)));
    return true;
  }
  if (method === 'GET' && path === '/sect/channel') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    const before = q.get('before') ? Number(q.get('before')) : undefined;
    const limit = numQ(q.get('limit'), 30);
    send(res, 200, ok(await sectSvc.getChannel(worldId, accountId, before, limit)));
    return true;
  }

  return false;
}
