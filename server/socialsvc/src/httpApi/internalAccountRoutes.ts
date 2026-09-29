// socialsvc httpApi split — /internal/accounts/* (account lifecycle, called by metaserver's
// account-deletion purge job after the 7-day grace period). See ../httpApi.ts for the module overview
// and ../accountPurge.ts for what a purge removes and why it is safe to retry.
import { ErrorCode, ok } from '@nw/shared';
import { send, sendErr, readJson, type BaseCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleInternalAccountRoutes(ctx: BaseCtx): Promise<boolean> {
  const { req, res, method, path, accountPurge } = ctx;

  const m = /^\/internal\/accounts\/([^/]+)\/purge$/.exec(path);
  if (method === 'POST' && m) {
    const accountId = decodeURIComponent(m[1]!);
    if (!accountPurge) {
      sendErr(res, ErrorCode.INTERNAL, 'account purge not configured');
      return true;
    }
    // The contract body is `{}`; an optional `publicId` hint saves the metaserver round trip that
    // finding this account's sent player mail otherwise needs (see AccountPurgeService.purgeMail).
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
    const publicId = typeof body.publicId === 'string' && body.publicId ? body.publicId : undefined;
    const result = await accountPurge.purge(accountId, publicId ? { publicId } : {});
    send(res, 200, ok(result));
    return true;
  }

  return false;
}
