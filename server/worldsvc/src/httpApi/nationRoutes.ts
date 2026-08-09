// worldsvc httpApi split — nation/world public channel + nation naming (B7, §6.4, S8-6.5)
// (see ../httpApi.ts for the module overview). No behavior change — copied verbatim.
import { ErrorCode, ok, regionFromAcceptLanguage } from '@nw/shared';
import { readJson, send, sendErr, sanitizeSenderNameFallback, numQ, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleNationRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, q, accountId, clientPlatform, svc, nationChannelSvc } = ctx;

  // ── Nation/world public channel (B7, §6.4) ────────────────────────────────────
  if (method === 'POST' && path === '/nation/message') {
    const body = await readJson(req);
    const worldId = typeof body.worldId === 'string' ? body.worldId : null;
    const msgBody = typeof body.body === 'string' ? body.body : null;
    const senderName = sanitizeSenderNameFallback(typeof body.senderName === 'string' ? body.senderName : '', accountId);
    if (!worldId || !msgBody) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + body required'); return true; }
    const nationRegion = regionFromAcceptLanguage(req.headers['accept-language']);
    send(res, 200, ok(await nationChannelSvc.sendMessage(worldId, accountId, senderName, msgBody, clientPlatform, nationRegion)));
    return true;
  }
  if (method === 'GET' && path === '/nation/channel') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    const before = q.get('before') ? Number(q.get('before')) : undefined;
    const limit = numQ(q.get('limit'), 30);
    send(res, 200, ok(await nationChannelSvc.getChannel(worldId, accountId, before, limit)));
    return true;
  }

  // ── Nation (S8-6.5, implemented) ──
  if (method === 'GET' && path === '/world/nations') {
    const worldId = q.get('worldId');
    if (!worldId) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required'); return true; }
    send(res, 200, ok(await svc.getNations(worldId)));
    return true;
  }
  {
    const m = /^\/world\/nations\/(\d+)\/name$/.exec(path);
    if (method === 'POST' && m) {
      const body = await readJson(req);
      const worldId = typeof body.worldId === 'string' ? body.worldId : null;
      const name = typeof body.name === 'string' ? body.name : null;
      if (!worldId || !name) { sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + name required'); return true; }
      const nationRegion = regionFromAcceptLanguage(req.headers['accept-language']);
      await svc.setNationName(worldId, accountId, Number(m[1]), name, nationRegion);
      send(res, 200, ok({}));
      return true;
    }
  }

  return false;
}
