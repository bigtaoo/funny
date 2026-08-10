// admin httpApi split — admin account management, superadmin-only (see ../httpApi.ts for the module
// overview). No behavior change — copied verbatim from the original httpApi.ts.
import { send, requireCap, readJson, str, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleAccountRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, actor, svc } = ctx;

  if (method === 'GET' && path === '/admin/accounts') {
    requireCap(actor, 'admin.manage');
    send(res, 200, { ok: true, accounts: await svc.listAccounts() });
    return true;
  }
  if (method === 'POST' && path === '/admin/accounts') {
    requireCap(actor, 'admin.manage');
    const b = await readJson(req);
    const account = await svc.createAccount(actor, {
      username: str(b.username),
      password: str(b.password),
      role: str(b.role),
      displayName: str(b.displayName),
    });
    send(res, 200, { ok: true, account });
    return true;
  }
  const acctPatch = /^\/admin\/accounts\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && acctPatch) {
    requireCap(actor, 'admin.manage');
    const id = decodeURIComponent(acctPatch[1]!);
    const b = await readJson(req);
    const account = await svc.updateAccount(actor, id, {
      ...(typeof b.role === 'string' ? { role: b.role } : {}),
      ...(typeof b.disabled === 'boolean' ? { disabled: b.disabled } : {}),
      ...(typeof b.displayName === 'string' ? { displayName: b.displayName } : {}),
    });
    send(res, 200, { ok: true, account });
    return true;
  }
  const acctReset = /^\/admin\/accounts\/([^/]+)\/reset-password$/.exec(path);
  if (method === 'POST' && acctReset) {
    requireCap(actor, 'admin.manage');
    const id = decodeURIComponent(acctReset[1]!);
    const b = await readJson(req);
    await svc.resetPassword(actor, id, str(b.password));
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}
