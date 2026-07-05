// System mail (S6-3, OPS_DESIGN §3.3): admin compensation tickets go through HttpMailDispatcher.
// Funds are credited via commercial/inventory only when the player claims the mail (admin never writes to the wallet directly). dispatchKey is idempotent.
import type { FastifyInstance } from 'fastify';
import { createLogger, type CompTarget, type MailAttachmentDoc } from '@nw/shared';
import { resolveByPublicId } from '../accounts.js';
import { insertSystemMail, bulkInsertSystemMail } from '../mail.js';
import type { InternalCtx } from './context.js';

const log = createLogger('meta:internal');

/** Number of accounts per batch in the server-wide system mail fan-out (ops per bulkWrite). MongoDB single-batch limit is 1000; leaving headroom. */
const MAIL_FANOUT_BATCH = 500;

interface SystemMailBody {
  dispatchKey: string;
  scope?: 'single' | 'global';
  /** Direct-delivery accountId for internal callers (§17.5, e.g. worldsvc) that have no publicId; mutually exclusive with target. */
  accountId?: string;
  target?: CompTarget;
  subject: string;
  body: string;
  // MailAttachmentDoc (not CompAttachment): in addition to OPS compensation coins/item/skin, it also includes worldsvc season-reward
  // 'material' (→ SaveData.materials unified progression pool, SLG8). CompAttachment is a subset of this.
  attachments: MailAttachmentDoc[];
  expireDays: number;
}

export function registerMailRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  const { cols, authed, gateway, socialsvc } = ctx;

  // POST /internal/mail/system/preview → { ok, recipientCount }
  app.post('/internal/mail/system/preview', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const b = req.body as Pick<SystemMailBody, 'scope' | 'target'>;
    if (b.scope === 'global') {
      const recipientCount = await cols.accounts.countDocuments({});
      return reply.send({ ok: true, recipientCount });
    }
    const publicId = b.target && 'publicId' in b.target ? b.target.publicId : '';
    const accountId = await resolveByPublicId(cols, publicId);
    return reply.send({ ok: true, recipientCount: accountId ? 1 : 0 });
  });

  // POST /internal/mail/system/send → { ok, recipientCount }
  app.post('/internal/mail/system/send', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const b = req.body as SystemMailBody;
    if (!b?.dispatchKey || !b.subject) {
      return reply.code(400).send({ ok: false, error: 'dispatchKey + subject required' });
    }
    const content = {
      subject: b.subject,
      body: b.body ?? '',
      attachments: b.attachments ?? [],
      expireDays: b.expireDays ?? 0,
    };

    if (b.scope === 'global') {
      // Server-wide fan-out in batches: each batch of MAIL_FANOUT_BATCH accounts performs one bulkWrite (unordered upsert)
      // on socialsvc's side, reducing O(N) round-trips to O(N/batch). socialsvc pushes mail_new itself to newly inserted
      // recipients in each batch (dispatchKey is idempotent; retries do not duplicate pushes) — meta does not push again.
      let recipientCount = 0;
      let insertedCount = 0;
      let batch: string[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const ids = batch;
        batch = [];
        const r = await bulkInsertSystemMail(socialsvc, b.dispatchKey, ids, content);
        recipientCount += ids.length;
        insertedCount += r.insertedAccountIds.length;
      };
      try {
        const cursor = cols.accounts.find({}, { projection: { _id: 1 } });
        for await (const doc of cursor) {
          batch.push(doc._id);
          if (batch.length >= MAIL_FANOUT_BATCH) await flush();
        }
        await flush();
      } catch (e) {
        log.error('POST /internal/mail/system/send (global) failed', { dispatchKey: b.dispatchKey, err: (e as Error).message });
        return reply.send({ ok: false, recipientCount, error: (e as Error).message });
      }
      log.info('POST /internal/mail/system/send (global)', {
        dispatchKey: b.dispatchKey,
        recipientCount,
        insertedCount,
      });
      return reply.send({ ok: true, recipientCount });
    }

    // Internal direct-delivery path (§17.5): internal callers like worldsvc deliver by accountId (no publicId), bypassing resolution.
    const directAccountId =
      typeof (b as { accountId?: unknown }).accountId === 'string'
        ? (b as { accountId: string }).accountId
        : null;
    const publicId = b.target && 'publicId' in b.target ? b.target.publicId : '';
    const accountId = directAccountId ?? (await resolveByPublicId(cols, publicId));
    if (!accountId) return reply.send({ ok: false, recipientCount: 0, error: 'recipient not found' });
    let r: { mailId: string; inserted: boolean; hasAttachment: boolean };
    try {
      r = await insertSystemMail(socialsvc, b.dispatchKey, accountId, content);
    } catch (e) {
      log.error('POST /internal/mail/system/send (single) failed', { dispatchKey: b.dispatchKey, publicId, err: (e as Error).message });
      return reply.send({ ok: false, recipientCount: 0, error: (e as Error).message });
    }
    if (r.inserted) {
      void gateway.push(accountId, { kind: 'mail_new', mailId: r.mailId, hasAttachment: r.hasAttachment });
    }
    log.info('POST /internal/mail/system/send (single)', { dispatchKey: b.dispatchKey, publicId });
    return reply.send({ ok: true, recipientCount: 1 });
  });
}
