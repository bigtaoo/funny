// socialsvc httpApi split — /internal/mail/* (called by metaserver: atomic claim/unclaim + system mail
// send, single and bulk — see ../httpApi.ts for the module overview). No behavior change — copied
// verbatim from the original httpApi.ts.
import { ErrorCode, ok } from '@nw/shared';
import { send, sendErr, readJson, type BaseCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleInternalMailRoutes(ctx: BaseCtx): Promise<boolean> {
  const { req, res, method, path, mailSvc, gateway } = ctx;

  // P2: atomic mail claim (called by metaserver: marks as claimed and returns the attachment list; metaserver then delivers goods)
  {
    const m = /^\/internal\/mail\/([^/]+)\/claim$/.exec(path);
    if (method === 'POST' && m) {
      const mailId = decodeURIComponent(m[1]!);
      const body = await readJson(req);
      const accountId = typeof body.accountId === 'string' ? body.accountId : null;
      const orderId = typeof body.orderId === 'string' ? body.orderId : null;
      if (!accountId || !orderId) { sendErr(res, ErrorCode.BAD_REQUEST, 'accountId + orderId required'); return true; }
      const result = await mailSvc.claimMailAtomic(accountId, mailId, orderId);
      if ('error' in result) {
        const code = result.error === 'NOT_FOUND' ? ErrorCode.NOT_FOUND
          : result.error === 'ALREADY_CLAIMED' ? ErrorCode.ALREADY_CLAIMED
          : ErrorCode.NO_ATTACHMENT;
        sendErr(res, code, result.error);
        return true;
      }
      send(res, 200, ok({ doc: result.doc }));
      return true;
    }
  }

  // comm-audit-internal-2026-07-28 P0-4: roll back a claim when metaserver's post-claim delivery
  // (commercial.grant / equipment / cards) fails, so the attachment isn't lost forever.
  {
    const m = /^\/internal\/mail\/([^/]+)\/unclaim$/.exec(path);
    if (method === 'POST' && m) {
      const mailId = decodeURIComponent(m[1]!);
      const body = await readJson(req);
      const accountId = typeof body.accountId === 'string' ? body.accountId : null;
      const orderId = typeof body.orderId === 'string' ? body.orderId : null;
      if (!accountId || !orderId) { sendErr(res, ErrorCode.BAD_REQUEST, 'accountId + orderId required'); return true; }
      const result = await mailSvc.unclaimMailAtomic(accountId, mailId, orderId);
      send(res, 200, ok(result));
      return true;
    }
  }

  // P2: send a single system mail (called by metaserver admin / season settlement)
  if (method === 'POST' && path === '/internal/mail/system') {
    const body = await readJson(req);
    const { dispatchKey, to, content } = body as {
      dispatchKey: string;
      to: string;
      content: { subject: string; body: string; expireDays: number };
    };
    if (!dispatchKey || !to || !content?.subject) { sendErr(res, ErrorCode.BAD_REQUEST, 'dispatchKey + to + content required'); return true; }
    const r = await mailSvc.insertSystemMail(dispatchKey, to, content);
    send(res, 200, ok(r));
    return true;
  }

  // P2: bulk system mail fan-out (called by metaserver admin / season settlement)
  if (method === 'POST' && path === '/internal/mail/system/bulk') {
    const body = await readJson(req);
    const { dispatchKey, accountIds, content } = body as {
      dispatchKey: string;
      accountIds: string[];
      content: { subject: string; body: string; expireDays: number };
    };
    if (!dispatchKey || !Array.isArray(accountIds) || !content?.subject) {
      sendErr(res, ErrorCode.BAD_REQUEST, 'dispatchKey + accountIds + content required');
      return true;
    }
    const r = await mailSvc.bulkInsertSystemMail(dispatchKey, accountIds, content);
    // Push a notification badge to newly inserted recipients — one /gw/push/batch round trip instead
    // of one /gw/push call per recipient (comm-audit batch F item 5; up to 500 per meta chunk).
    if (r.insertedAccountIds.length > 0) {
      void gateway.pushBatch(r.insertedAccountIds.map((aid) => ({
        accountId: aid,
        msg: { kind: 'mail_new' as const, mailId: `${dispatchKey}:${aid}`, hasAttachment: r.hasAttachment },
      }))); // best-effort, does not affect the current response
    }
    send(res, 200, ok(r));
    return true;
  }

  return false;
}
