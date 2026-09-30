// worldsvc httpApi split — internal /internal/* branch: service-to-service calls authenticated by
// X-Internal-Key, checked before JWT (see ../httpApi.ts for the module overview). Same shape as admin.ts —
// a void handler that always sends a response once the caller has matched the `/internal/` prefix.
//
// Today the only caller is metaserver's account-deletion purge job (POST /internal/accounts/:id/purge, see
// ../accountPurge.ts). The job retries until every service answers done, so the handler maps every
// unexpected failure to a plain 500 and never a partial success.
import type { IncomingMessage, ServerResponse } from 'http';
import { ErrorCode, SlgError, createLogger, ok, err, type InternalAuthVerifier } from '@nw/shared';
import { send, sendErr, type RouteDeps } from './helpers';

const log = createLogger('worldsvc');

const PURGE_PATH = /^\/internal\/accounts\/([^/]+)\/purge$/;

export async function handleInternalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  aurl: URL,
  internalAuth: InternalAuthVerifier,
  deps: RouteDeps,
): Promise<void> {
  if (!internalAuth.verify(req.headers).ok) {
    return sendErr(res, ErrorCode.UNAUTHENTICATED, 'internal endpoint requires X-Internal-Key');
  }

  // Account-deletion purge. Body ignored (the account id in the path is the whole request).
  const purge = PURGE_PATH.exec(aurl.pathname);
  if (method === 'POST' && purge) {
    const accountId = decodeURIComponent(purge[1]!);
    try {
      return send(res, 200, ok(await deps.svc.purgeAccount(accountId)));
    } catch (e) {
      if (e instanceof SlgError) return sendErr(res, e.code, e.message);
      // Never leak the raw exception message to the caller (comm-audit-2026-07-27 B15, as in admin.ts).
      log.error('unhandled error (account purge)', { accountId, err: e instanceof Error ? e : String(e) });
      return send(res, 500, err(ErrorCode.INTERNAL, 'internal server error'));
    }
  }
  return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
}
