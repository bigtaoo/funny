// MailService end-to-end (SOCIAL_SVC_DESIGN §3.3 P2): real Mongo + fakes.
// Covers player-to-player mail (friend-gated), system mail (idempotent single + bulk upsert),
// read/delete, the atomic attachment claim, and TTL-expiry filtering on read.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_SUBJECT_MAX, MAIL_BODY_MAX, friendEdgeId, type MailAttachmentDoc } from '@nw/shared';
import type { SocialMongo } from '../src/db';
import { MailService } from '../src/mailService';
import { tryConnect, FakeMeta, FakeGateway } from './harness';

const mongo = await tryConnect('nw_social_mail_test');
if (!mongo) console.warn('[socialsvc.mail.e2e] Mongo unreachable — skipping.');

describe.skipIf(!mongo)('socialsvc MailService e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let meta: FakeMeta;
  let gateway: FakeGateway;
  let svc: MailService;

  beforeEach(async () => {
    await Promise.all([
      m.collections.mails.deleteMany({}),
      m.collections.friendEdges.deleteMany({}),
    ]);
    nowMs = 1_000_000;
    meta = new FakeMeta().add('a', 'P-A', 'Alice').add('b', 'P-B', 'Bob');
    gateway = new FakeGateway();
    svc = new MailService({ cols: m.collections, gateway, meta, now });
  });

  afterAll(async () => { await m.close(); });

  /** Make a→b a (directed) friend edge so player mail from a to b passes the friend gate. */
  async function edge(from: string, to: string): Promise<void> {
    await m.collections.friendEdges.insertOne({ _id: friendEdgeId(from, to), owner: from, friend: to, since: nowMs });
  }

  // ── Player mail ──────────────────────────────────────────────────────────────

  it('sendPlayerMail: friend-gated; persists with sender publicId + TTL; pushes mail_new', async () => {
    expect(await svc.sendPlayerMail('a', 'P-B', 'Hi', 'body')).toMatchObject({ error: 'NOT_FRIEND' });
    await edge('a', 'b');
    const res = await svc.sendPlayerMail('a', 'P-B', '  Hi Bob  ', '  hello  ');
    expect(res.kind).toBe('ok');
    const doc = await m.collections.mails.findOne({ to: 'b' });
    expect(doc).toMatchObject({ from: 'P-A', fromName: 'Alice', subject: 'Hi Bob', body: 'hello' });
    expect(doc!.expireAt).toBeInstanceOf(Date);
    expect(gateway.ofKind('mail_new')).toHaveLength(1);
    expect(gateway.ofKind('mail_new')[0]!.hasAttachment).toBe(false);
  });

  it('sendPlayerMail: rejects unknown target, self, and over-long fields', async () => {
    await edge('a', 'b');
    expect(await svc.sendPlayerMail('a', 'P-NOPE', 'Hi', 'b')).toMatchObject({ error: 'NOT_FOUND' });
    expect(await svc.sendPlayerMail('a', 'P-A', 'Hi', 'b')).toMatchObject({ error: 'BAD_REQUEST' }); // self
    expect(await svc.sendPlayerMail('a', 'P-B', '', 'b')).toMatchObject({ error: 'BAD_REQUEST' });   // empty subject
    expect(await svc.sendPlayerMail('a', 'P-B', 'x'.repeat(MAIL_SUBJECT_MAX + 1), 'b')).toMatchObject({ error: 'BAD_REQUEST' });
    expect(await svc.sendPlayerMail('a', 'P-B', 'Hi', 'x'.repeat(MAIL_BODY_MAX + 1))).toMatchObject({ error: 'BAD_REQUEST' });
  });

  // ── System mail ──────────────────────────────────────────────────────────────

  it('insertSystemMail: idempotent per (dispatchKey,to); re-send is a no-op', async () => {
    const first = await svc.insertSystemMail('reward:s1', 'a', { subject: 'Season reward', body: 'gg', expireDays: 7 });
    expect(first.inserted).toBe(true);
    expect(first.mailId).toBe('reward:s1:a');
    const again = await svc.insertSystemMail('reward:s1', 'a', { subject: 'changed', body: 'x', expireDays: 7 });
    expect(again.inserted).toBe(false);
    // Original content preserved ($setOnInsert), not overwritten.
    expect((await m.collections.mails.findOne({ _id: 'reward:s1:a' }))!.subject).toBe('Season reward');
    expect(await m.collections.mails.countDocuments({ to: 'a' })).toBe(1);
  });

  it('insertSystemMail: attachment flag flows through', async () => {
    const res = await svc.insertSystemMail('gift:1', 'a', {
      subject: 'Gift', body: 'enjoy', expireDays: 3,
      attachments: [{ kind: 'coins', count: 100 } satisfies MailAttachmentDoc],
    });
    expect(res.hasAttachment).toBe(true);
    expect((await m.collections.mails.findOne({ _id: 'gift:1:a' }))!.attachments).toHaveLength(1);
  });

  it('bulkInsertSystemMail: upserts many, reports only newly-inserted, idempotent on re-run', async () => {
    const r1 = await svc.bulkInsertSystemMail('blast:1', ['a', 'b'], { subject: 'News', body: 'hi', expireDays: 1 });
    expect(new Set(r1.insertedAccountIds)).toEqual(new Set(['a', 'b']));
    // Re-run with an overlapping set → only the genuinely new recipient is reported.
    const r2 = await svc.bulkInsertSystemMail('blast:1', ['a', 'b', 'c'], { subject: 'News', body: 'hi', expireDays: 1 });
    expect(r2.insertedAccountIds).toEqual(['c']);
    expect(await m.collections.mails.countDocuments({})).toBe(3);
    // Empty list short-circuits.
    expect((await svc.bulkInsertSystemMail('blast:2', [], { subject: 's', body: 'b', expireDays: 1 })).insertedAccountIds).toEqual([]);
  });

  // ── Read / list / delete ──────────────────────────────────────────────────────

  it('getMail: returns unexpired mail newest-first with an unread count; readMail flips the flag', async () => {
    nowMs = 1_000; await svc.insertSystemMail('m1', 'a', { subject: 'one', body: 'b', expireDays: 30 });
    nowMs = 2_000; await svc.insertSystemMail('m2', 'a', { subject: 'two', body: 'b', expireDays: 30 });
    nowMs = 3_000;

    let box = await svc.getMail('a');
    expect(box.mail.map((x) => x.subject)).toEqual(['two', 'one']); // newest-first
    expect(box.unread).toBe(2);

    expect(await svc.readMail('a', 'm2:a')).toBe(true);
    box = await svc.getMail('a');
    expect(box.unread).toBe(1);
    expect(box.mail.find((x) => x.mailId === 'm2:a')!.read).toBe(true);

    // readMail on someone else's / missing mail → false.
    expect(await svc.readMail('a', 'does-not-exist')).toBe(false);
  });

  it('getMail: excludes expired mail (TTL boundary honored in the query, not just via the index)', async () => {
    nowMs = 1_000;
    await svc.insertSystemMail('short', 'a', { subject: 'fleeting', body: 'b', expireDays: 1 }); // expires at 1_000 + 86400_000
    // Jump well past the 1-day expiry.
    nowMs = 1_000 + 2 * 86_400_000;
    const box = await svc.getMail('a');
    expect(box.mail).toHaveLength(0);
  });

  it('deleteMail: removes only the owner\'s mail', async () => {
    await svc.insertSystemMail('d1', 'a', { subject: 'x', body: 'b', expireDays: 30 });
    await svc.deleteMail('b', 'd1:a'); // wrong owner → no-op
    expect(await m.collections.mails.countDocuments({ _id: 'd1:a' })).toBe(1);
    expect(await svc.deleteMail('a', 'd1:a')).toEqual({ ok: true });
    expect(await m.collections.mails.countDocuments({ _id: 'd1:a' })).toBe(0);
  });

  it('deleteMail: rejects mail with an unclaimed attachment; allowed once claimed', async () => {
    await svc.insertSystemMail('gift', 'a', {
      subject: 'Loot', body: 'grab it', expireDays: 30,
      attachments: [{ kind: 'coins', count: 100 } satisfies MailAttachmentDoc],
    });
    expect(await svc.deleteMail('a', 'gift:a')).toMatchObject({ error: 'HAS_UNCLAIMED_ATTACHMENT' });
    expect(await m.collections.mails.countDocuments({ _id: 'gift:a' })).toBe(1);

    await svc.claimMailAtomic('a', 'gift:a', 'order-1');
    expect(await svc.deleteMail('a', 'gift:a')).toEqual({ ok: true });
    expect(await m.collections.mails.countDocuments({ _id: 'gift:a' })).toBe(0);
  });

  // ── Atomic attachment claim ──────────────────────────────────────────────────

  it('claimMailAtomic: single-winner; second claim reports ALREADY_CLAIMED', async () => {
    await svc.insertSystemMail('reward', 'a', {
      subject: 'Loot', body: 'grab it', expireDays: 7,
      attachments: [{ kind: 'coins', count: 500 } satisfies MailAttachmentDoc],
    });
    const first = await svc.claimMailAtomic('a', 'reward:a', 'order-1');
    expect('doc' in first).toBe(true);
    if ('doc' in first) {
      expect(first.doc.claimedAt).toBe(nowMs);
      expect(first.doc.claimOrderId).toBe('order-1');
      expect(first.doc.readAt).toBe(nowMs); // claim implicitly marks read
    }
    // Second claim loses.
    expect(await svc.claimMailAtomic('a', 'reward:a', 'order-2')).toMatchObject({ error: 'ALREADY_CLAIMED' });
  });

  it('claimMailAtomic: NOT_FOUND for missing mail, NO_ATTACHMENT for attachment-less mail', async () => {
    await svc.insertSystemMail('plain', 'a', { subject: 'no loot', body: 'b', expireDays: 7 });
    expect(await svc.claimMailAtomic('a', 'missing:a', 'o')).toMatchObject({ error: 'NOT_FOUND' });
    expect(await svc.claimMailAtomic('a', 'plain:a', 'o')).toMatchObject({ error: 'NO_ATTACHMENT' });
  });

  // ── Atomic claim rollback (comm-audit-internal-2026-07-28 P0-4) ──────────────
  //
  // metaserver calls unclaimMailAtomic when the post-claim attachment delivery (commercial.grant /
  // equipment / cards) fails AFTER claimMailAtomic already marked the mail claimed — without this the
  // attachment would be lost forever (mail stuck claimed-but-never-delivered, never claimable again).

  it('unclaimMailAtomic: rolls back a failed-delivery claim so the mail becomes re-claimable, without granting twice', async () => {
    await svc.insertSystemMail('reward', 'a', {
      subject: 'Loot', body: 'grab it', expireDays: 7,
      attachments: [{ kind: 'coins', count: 500 } satisfies MailAttachmentDoc],
    });
    const claimed = await svc.claimMailAtomic('a', 'reward:a', 'order-1');
    expect('doc' in claimed).toBe(true);

    await svc.unclaimMailAtomic('a', 'reward:a', 'order-1');
    const doc = await m.collections.mails.findOne({ _id: 'reward:a' });
    expect(doc!.claimedAt).toBeUndefined();
    expect(doc!.claimOrderId).toBeUndefined();
    // The view surfaces it as unclaimed again too.
    expect((await svc.getMail('a')).mail.find((x) => x.mailId === 'reward:a')!.claimed).toBe(false);

    // Re-claimable: a fresh order can now win the claim (attachment is granted exactly once downstream,
    // by metaserver, keyed off this second successful claim — not re-granted by the rollback itself).
    const reclaimed = await svc.claimMailAtomic('a', 'reward:a', 'order-2');
    expect('doc' in reclaimed).toBe(true);
    if ('doc' in reclaimed) {
      expect(reclaimed.doc.claimOrderId).toBe('order-2');
    }
  });

  it('unclaimMailAtomic: orderId guard — cannot undo a DIFFERENT (e.g. later-winning) order\'s successful claim', async () => {
    await svc.insertSystemMail('reward2', 'a', {
      subject: 'Loot', body: 'grab it', expireDays: 7,
      attachments: [{ kind: 'coins', count: 500 } satisfies MailAttachmentDoc],
    });
    await svc.claimMailAtomic('a', 'reward2:a', 'order-real');

    // A stale/duplicate retry for a DIFFERENT orderId tries to unclaim — must be a no-op, since it
    // never made this claim (guards against a delayed retry undoing someone else's real claim).
    await svc.unclaimMailAtomic('a', 'reward2:a', 'order-stale');
    const doc = await m.collections.mails.findOne({ _id: 'reward2:a' });
    expect(doc!.claimedAt).toBe(nowMs);
    expect(doc!.claimOrderId).toBe('order-real'); // untouched
  });

  it('unclaimMailAtomic: idempotent no-op on an already-unclaimed or nonexistent mail', async () => {
    await svc.insertSystemMail('plain2', 'a', { subject: 'no loot', body: 'b', expireDays: 7 });
    // Never claimed — unclaiming is a harmless no-op.
    expect(await svc.unclaimMailAtomic('a', 'plain2:a', 'order-x')).toEqual({ ok: true });
    expect(await m.collections.mails.countDocuments({ _id: 'plain2:a' })).toBe(1);
    // Nonexistent mail id — also a harmless no-op, not an error.
    expect(await svc.unclaimMailAtomic('a', 'does-not-exist', 'order-x')).toEqual({ ok: true });
  });
});
