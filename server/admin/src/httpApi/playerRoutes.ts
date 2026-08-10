// admin httpApi split — player lookup + account-level enforcement (see ../httpApi.ts for the module
// overview). No behavior change — copied verbatim from the original httpApi.ts.
import { send, requireCap, readJson, str, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handlePlayerRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, url, actor, svc } = ctx;

  // ── Player fuzzy search (nickname / login account / public id / accountId) ──
  if (method === 'GET' && path === '/admin/players/search') {
    requireCap(actor, 'player.lookup');
    const q = url.searchParams.get('q') ?? '';
    send(res, 200, { ok: true, players: await svc.searchPlayers(actor.adminId, q) });
    return true;
  }

  // ── Player detail (by accountId, fetched after clicking a fuzzy search result) ──
  if (method === 'GET' && path.startsWith('/admin/player/account/')) {
    requireCap(actor, 'player.lookup');
    const accountId = decodeURIComponent(path.slice('/admin/player/account/'.length));
    send(res, 200, { ok: true, player: await svc.lookupPlayerByAccountId(accountId) });
    return true;
  }

  // ── Player detail (by 9-digit public id) ──
  if (method === 'GET' && path.startsWith('/admin/player/')) {
    requireCap(actor, 'player.lookup');
    const publicId = decodeURIComponent(path.slice('/admin/player/'.length));
    send(res, 200, { ok: true, player: await svc.lookupPlayer(publicId) });
    return true;
  }

  // ── Player password reset (player.password_reset, super only): support tool for players with no
  // contact method on file, who cannot use self-service /auth/password/change (needs the old password) ──
  const pwResetMatch = path.match(/^\/admin\/players\/([^/]+)\/reset-password$/);
  if (method === 'POST' && pwResetMatch) {
    requireCap(actor, 'player.password_reset');
    const accountId = decodeURIComponent(pwResetMatch[1] ?? '');
    const b = await readJson(req);
    await svc.resetPlayerPassword(actor.adminId, accountId, str(b.password));
    send(res, 200, { ok: true });
    return true;
  }

  // ── Manual ban / unban (S4-4) ──
  const banMatch = path.match(/^\/admin\/accounts\/([^/]+)\/(ban|unban)$/);
  if (method === 'POST' && banMatch) {
    requireCap(actor, 'anticheat.action');
    const accountId = decodeURIComponent(banMatch[1] ?? '');
    const action = (banMatch[2] ?? 'ban') as 'ban' | 'unban';
    const result = action === 'ban' ? await svc.banAccount(accountId) : await svc.unbanAccount(accountId);
    await svc.audit(actor.adminId, action === 'ban' ? 'account.ban' : 'account.unban', { target: accountId });
    send(res, result.ok ? 200 : 502, { ok: result.ok });
    return true;
  }

  return false;
}
