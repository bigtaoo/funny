// admin httpApi split — everything that runs before a domain route needs an authenticated actor (see
// ../httpApi.ts for the module overview). No behavior change — copied verbatim from the original httpApi.ts.
//
// handlePreAuth: CORS preflight, health probe, and the three X-Internal-Key internal endpoints (raw flag
// rules / SLG shop price overrides / moderation wordlist overlays) — all reachable with zero admin JWT,
// so they run BEFORE the shell's authenticate() call, same as worldsvc httpApi's `/admin/world/*` exception.
// handleLogin: the one route reachable with a username/password but no bearer token yet.
// handleSession: logout/me — needs an actor, so it runs inside the authenticated chain like every other
// domain handler, it just happens to be the smallest one (no capability gate beyond "is logged in").
import { createLogger, signToken } from '@nw/shared';
import { AdminError } from '../service';
import { readJson, send, clientIp, str, type BaseCtx, type RouteCtx } from './helpers';

const log = createLogger('admin:http');

/** Returns true once matched + a response was sent; false lets the caller fall through to JWT auth. */
export async function handlePreAuth(ctx: BaseCtx): Promise<boolean> {
  const { req, res, method, path, svc, internalAuth } = ctx;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
    });
    res.end();
    return true;
  }
  // Liveness probe (no auth).
  if (method === 'GET' && path === '/health') {
    send(res, 200, { ok: true, service: 'admin' });
    return true;
  }
  // ── Internal endpoint: raw feature flag rules (X-Internal-Key, not admin JWT; database-less backends poll here) ──
  // A player JWT cannot satisfy X-Internal-Key (structurally rejected), and this endpoint only reads raw rules without evaluating them —
  // consumers fetch the rules and call evaluateFlag in their own process with the current user context.
  if (method === 'GET' && path === '/admin/internal/flags') {
    if (!internalAuth.verify(req.headers).ok) {
      log.warn('internal flags request rejected: bad X-Internal-Key', { caller: req.headers['x-internal-caller'] });
      send(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }
    try {
      send(res, 200, { ok: true, flags: await svc.getInternalFlags() });
    } catch (e) {
      log.error('internal flags fetch failed', { err: (e as Error).message });
      send(res, 500, { ok: false, error: 'internal error' });
    }
    return true;
  }
  // ── Internal endpoint: raw SLG shop price overrides (X-Internal-Key; worldsvc has no DB connection to admin) ──
  // Same shape as the internal flags endpoint above: raw override docs only, worldsvc merges them onto
  // SLG_SHOP_ITEMS locally via resolveSlgShopItem.
  if (method === 'GET' && path === '/admin/internal/slg-shop-prices') {
    if (!internalAuth.verify(req.headers).ok) {
      log.warn('internal slg-shop-prices request rejected: bad X-Internal-Key', { caller: req.headers['x-internal-caller'] });
      send(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }
    try {
      send(res, 200, { ok: true, items: await svc.getInternalShopPrices() });
    } catch (e) {
      log.error('internal slg-shop-prices fetch failed', { err: (e as Error).message });
      send(res, 500, { ok: false, error: 'internal error' });
    }
    return true;
  }
  // ── Internal endpoint: raw content-moderation word list overlays (X-Internal-Key; metaserver/socialsvc/worldsvc have no DB connection to admin) ──
  // Same shape as the internal flags/slg-shop-prices endpoints above: raw overlay docs only, consumers
  // merge them onto REGION_WORDLISTS locally via WordlistCache (CONTENT_MODERATION_DESIGN.md §3.2).
  if (method === 'GET' && path === '/admin/internal/moderation-wordlists') {
    if (!internalAuth.verify(req.headers).ok) {
      log.warn('internal moderation-wordlists request rejected: bad X-Internal-Key', { caller: req.headers['x-internal-caller'] });
      send(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }
    try {
      send(res, 200, { ok: true, items: await svc.getInternalWordlists() });
    } catch (e) {
      log.error('internal moderation-wordlists fetch failed', { err: (e as Error).message });
      send(res, 500, { ok: false, error: 'internal error' });
    }
    return true;
  }
  return false;
}

/** Login (no session required yet — this is what creates one). Runs before authenticate() in the shell. */
export async function handleLogin(ctx: BaseCtx): Promise<boolean> {
  const { req, res, method, path, svc, jwt } = ctx;
  if (method === 'POST' && path === '/admin/login') {
    const b = await readJson(req);
    const doc = await svc.authenticate(str(b.username), str(b.password), clientIp(req));
    const token = signToken(doc._id, jwt);
    const { admin, capabilities } = svc.meView(doc);
    send(res, 200, { ok: true, token, admin, capabilities });
    return true;
  }
  return false;
}

/** logout/me — needs an actor; part of the authenticated chain. */
export async function handleSession(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, actor, svc } = ctx;
  if (method === 'POST' && path === '/admin/logout') {
    await svc.audit(actor.adminId, 'logout', { ip: clientIp(req) });
    send(res, 200, { ok: true });
    return true;
  }
  if (method === 'GET' && path === '/admin/me') {
    const doc = await svc.getAccount(actor.adminId);
    if (!doc) throw new AdminError(401, 'unauthorized', 'gone');
    send(res, 200, { ok: true, ...svc.meView(doc) });
    return true;
  }
  return false;
}
