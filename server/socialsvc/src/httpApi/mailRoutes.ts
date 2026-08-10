// socialsvc httpApi split — public /social/mail/* player mail (P2, see ../httpApi.ts for the module
// overview). No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok } from '@nw/shared';
import { send, sendErr, readJson, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleMailRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, accountId, mailSvc } = ctx;

  if (method === 'GET' && path === '/social/mail') {
    send(res, 200, ok(await mailSvc.getMail(accountId)));
    return true;
  }
  {
    const m = /^\/social\/mail\/([^/]+)\/read$/.exec(path);
    if (method === 'POST' && m) {
      const mailId = decodeURIComponent(m[1]!);
      const ok2 = await mailSvc.readMail(accountId, mailId);
      if (!ok2) { sendErr(res, ErrorCode.NOT_FOUND, 'mail not found'); return true; }
      send(res, 200, ok({ ok: true }));
      return true;
    }
  }
  {
    const m = /^\/social\/mail\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && m) {
      const r = await mailSvc.deleteMail(accountId, decodeURIComponent(m[1]!));
      if ('error' in r) {
        sendErr(res, ErrorCode.MAIL_HAS_UNCLAIMED_ATTACHMENT, 'mail has an unclaimed attachment; claim it before deleting');
        return true;
      }
      send(res, 200, ok({ ok: true }));
      return true;
    }
  }
  if (method === 'POST' && path === '/social/mail/send') {
    const body = await readJson(req);
    const toPublicId = typeof body.toPublicId === 'string' ? body.toPublicId : null;
    const subject = typeof body.subject === 'string' ? body.subject : null;
    const mailBody = typeof body.body === 'string' ? body.body : '';
    if (!toPublicId || !subject) { sendErr(res, ErrorCode.BAD_REQUEST, 'toPublicId + subject required'); return true; }
    const r = await mailSvc.sendPlayerMail(accountId, toPublicId, subject, mailBody);
    if (r.kind === 'error') {
      if (r.error === 'NOT_FRIEND') { sendErr(res, ErrorCode.NOT_FRIEND, 'not friends'); return true; }
      if (r.error === 'NOT_FOUND') { sendErr(res, ErrorCode.NOT_FOUND, 'player not found'); return true; }
      sendErr(res, ErrorCode.BAD_REQUEST, 'bad request');
      return true;
    }
    send(res, 200, ok({ mailId: r.mailId }));
    return true;
  }

  return false;
}
