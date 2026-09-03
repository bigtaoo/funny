// MailService branch-coverage gap-fill (2026-09-03 pass): src/mailService.ts was 100% line / 82.53%
// branch — every method had been called, but only ever with the shape metaserver's happy path sends.
// The 11 branches left over are the ones that only run for mail that ISN'T shaped like that:
//
//   * `toMailView` on a doc with no `fromName` (system mail written by an older writer) and on a doc
//     whose `expireAt` is a plain number rather than a BSON Date — the conversion exists precisely
//     because such docs can be in the collection, and `Number(Date)` vs `Date.getTime()` is the
//     difference between a real timestamp and NaN in the client's "expires in N days" line.
//   * `claimMailAtomic` losing its claim CAS: the pre-checks pass, then a concurrent claim gets there
//     first. It must report ALREADY_CLAIMED, because the alternative — returning the doc anyway —
//     hands the same attachment to metaserver twice, i.e. duplicates the reward.
//   * `sendPlayerMail` with `subject`/`body` absent entirely (the route only coerces non-strings for
//     `body`; `subject` arrives as-is from JSON), and with the sender's own profile unresolvable.
//   * `insertSystemMail` / `bulkInsertSystemMail` with `expireDays <= 0` (callers use 0 to mean "use
//     the default TTL", so 0 must NOT become an already-expired mail) and with no attachments at all.
//   * `bulkInsertSystemMail` when the driver's BulkWriteResult carries no `upsertedIds` — every
//     accountId then reports as "not newly inserted", so no duplicate push goes out.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_DEFAULT_TTL_SEC, friendEdgeId, type MailAttachmentDoc, type MailDoc } from '@nw/shared';
import type { SocialMongo } from '../src/db';
import { MailService, toMailView } from '../src/mailService';
import { tryConnect, FakeMeta, FakeGateway } from './harness';
import { withCollection } from './stubCols';

const mongo = await tryConnect('nw_social_mail_branches_test');
if (!mongo) console.warn('[socialsvc.mailServiceBranches.e2e] Mongo unreachable — skipping.');

const ATT: MailAttachmentDoc[] = [{ kind: 'coins', count: 100 }];

describe('toMailView (pure — no DB)', () => {
  const base: MailDoc = {
    _id: 'm1',
    to: 'a',
    from: 'system',
    subject: 'S',
    body: 'B',
    createdAt: 1_000,
    expireAt: new Date(9_000),
  };

  it('omits fromName entirely when the doc has none (rather than fromName: undefined)', () => {
    const v = toMailView(base);
    expect(v).not.toHaveProperty('fromName');
    expect(v).toMatchObject({ mailId: 'm1', from: 'system', expireAt: 9_000, read: false, claimed: false });
  });

  it('omits attachments when the array is present but empty', () => {
    expect(toMailView({ ...base, attachments: [] })).not.toHaveProperty('attachments');
    expect(toMailView({ ...base, attachments: ATT }).attachments).toEqual(ATT);
  });

  it('converts a numeric expireAt (pre-Date writer) instead of yielding NaN', () => {
    // MailDoc types expireAt as Date; a doc written before that convention holds a number, and the
    // conversion in toMailView is what keeps such a doc renderable. Cast to reproduce that doc.
    const legacy = { ...base, expireAt: 9_000 as unknown as Date };
    expect(toMailView(legacy).expireAt).toBe(9_000);
  });

  it('reports read/claimed off the presence of the timestamps', () => {
    const v = toMailView({ ...base, fromName: 'System', readAt: 5, claimedAt: 6 });
    expect(v).toMatchObject({ fromName: 'System', read: true, claimed: true });
  });
});

describe.skipIf(!mongo)('socialsvc MailService branch gaps', () => {
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

  // ── claimMailAtomic: losing the claim CAS ────────────────────────────────────

  it('claimMailAtomic: a claim that passes the pre-checks but loses the CAS reports ALREADY_CLAIMED', async () => {
    await svc.insertSystemMail('gift', 'a', { subject: 'S', body: 'B', attachments: ATT, expireDays: 7 });
    // A concurrent claim landed between the findOne pre-check and this findOneAndUpdate: the guarded
    // update matches nothing and returns null. Handing back the doc here would deliver twice.
    const cols = withCollection(m.collections, 'mails', { findOneAndUpdate: async () => null });
    const raced = new MailService({ cols, gateway, meta, now });
    expect(await raced.claimMailAtomic('a', 'gift:a', 'order-1')).toEqual({ error: 'ALREADY_CLAIMED' });
    // The real doc is untouched — the loser must not have marked anything.
    const doc = await m.collections.mails.findOne({ _id: 'gift:a' });
    expect(doc!.claimedAt).toBeUndefined();
  });

  it('claimMailAtomic: winning the CAS also marks an unread mail read in the same update', async () => {
    await svc.insertSystemMail('gift2', 'a', { subject: 'S', body: 'B', attachments: ATT, expireDays: 7 });
    const r = await svc.claimMailAtomic('a', 'gift2:a', 'order-2');
    expect('doc' in r && r.doc.readAt).toBe(nowMs);
    expect('doc' in r && r.doc.claimOrderId).toBe('order-2');
  });

  // ── sendPlayerMail: absent fields / unresolvable sender ──────────────────────

  it('sendPlayerMail: an absent subject is treated as empty and rejected, not read off undefined', async () => {
    await m.collections.friendEdges.insertOne({ _id: friendEdgeId('a', 'b'), owner: 'a', friend: 'b', since: nowMs });
    // The route hands `subject` straight through from the parsed JSON body, so it can be undefined.
    const r = await svc.sendPlayerMail('a', 'P-B', undefined as unknown as string, 'hello');
    expect(r).toMatchObject({ kind: 'error', error: 'BAD_REQUEST' });
  });

  it('sendPlayerMail: an absent body is treated as empty and accepted (body is optional)', async () => {
    await m.collections.friendEdges.insertOne({ _id: friendEdgeId('a', 'b'), owner: 'a', friend: 'b', since: nowMs });
    const r = await svc.sendPlayerMail('a', 'P-B', 'Hi', undefined as unknown as string);
    expect(r.kind).toBe('ok');
    expect((await m.collections.mails.findOne({ to: 'b' }))!.body).toBe('');
  });

  it('sendPlayerMail: an unresolvable sender profile is BAD_REQUEST, and writes nothing', async () => {
    await m.collections.friendEdges.insertOne({ _id: friendEdgeId('ghost', 'b'), owner: 'ghost', friend: 'b', since: nowMs });
    // 'ghost' passes the friend gate but has no profile in meta — the mail has no from/fromName to
    // stamp, so it must not be written at all.
    const r = await svc.sendPlayerMail('ghost', 'P-B', 'Hi', 'hello');
    expect(r).toMatchObject({ kind: 'error', error: 'BAD_REQUEST' });
    expect(await m.collections.mails.countDocuments({})).toBe(0);
    expect(gateway.pushes).toHaveLength(0);
  });

  // ── system mail TTL + attachment shape ───────────────────────────────────────

  it('insertSystemMail: expireDays 0 falls back to the default TTL (not an instantly-expired mail)', async () => {
    const r = await svc.insertSystemMail('ttl0', 'a', { subject: 'S', body: 'B', expireDays: 0 });
    expect(r).toMatchObject({ inserted: true, hasAttachment: false });
    const doc = await m.collections.mails.findOne({ _id: 'ttl0:a' });
    expect(doc!.expireAt.getTime()).toBe(nowMs + MAIL_DEFAULT_TTL_SEC * 1000);
    expect(doc).not.toHaveProperty('attachments');
  });

  it('insertSystemMail: a positive expireDays wins over the default', async () => {
    await svc.insertSystemMail('ttl7', 'a', { subject: 'S', body: 'B', attachments: ATT, expireDays: 7 });
    const doc = await m.collections.mails.findOne({ _id: 'ttl7:a' });
    expect(doc!.expireAt.getTime()).toBe(nowMs + 7 * 86400 * 1000);
    expect(doc!.attachments).toEqual(ATT);
  });

  it('bulkInsertSystemMail: no attachments + expireDays 0 -> default TTL, attachments field omitted', async () => {
    const r = await svc.bulkInsertSystemMail('bulk0', ['a', 'b'], { subject: 'S', body: 'B', expireDays: 0 });
    expect(r).toMatchObject({ insertedAccountIds: ['a', 'b'], hasAttachment: false });
    const doc = await m.collections.mails.findOne({ _id: 'bulk0:a' });
    expect(doc!.expireAt.getTime()).toBe(nowMs + MAIL_DEFAULT_TTL_SEC * 1000);
    expect(doc).not.toHaveProperty('attachments');
  });

  it('bulkInsertSystemMail: with attachments + a positive expireDays', async () => {
    const r = await svc.bulkInsertSystemMail('bulkAtt', ['a'], { subject: 'S', body: 'B', attachments: ATT, expireDays: 3 });
    expect(r.hasAttachment).toBe(true);
    const doc = await m.collections.mails.findOne({ _id: 'bulkAtt:a' });
    expect(doc!.attachments).toEqual(ATT);
    expect(doc!.expireAt.getTime()).toBe(nowMs + 3 * 86400 * 1000);
  });

  it('bulkInsertSystemMail: a BulkWriteResult with no upsertedIds reports nothing newly inserted', async () => {
    // Nothing new was upserted (every recipient already had this dispatchKey) — the caller uses the
    // returned list to decide who to push to, so an empty list is what stops a duplicate push.
    const cols = withCollection(m.collections, 'mails', {
      bulkWrite: async () => ({ upsertedIds: undefined }),
    });
    const stubbed = new MailService({ cols, gateway, meta, now });
    expect(await stubbed.bulkInsertSystemMail('k', ['a', 'b'], { subject: 'S', body: 'B', expireDays: 1 }))
      .toEqual({ insertedAccountIds: [], hasAttachment: false });
  });

  it('bulkInsertSystemMail: an upsertedIds index with no matching accountId is dropped', async () => {
    // Defensive: the map is index-keyed, so an out-of-range key (a driver/shape change) must not put
    // `undefined` into the push list.
    const cols = withCollection(m.collections, 'mails', {
      bulkWrite: async () => ({ upsertedIds: { 0: 'k:a', 5: 'k:ghost' } }),
    });
    const stubbed = new MailService({ cols, gateway, meta, now });
    expect((await stubbed.bulkInsertSystemMail('k', ['a', 'b'], { subject: 'S', body: 'B', expireDays: 1 })).insertedAccountIds)
      .toEqual(['a']);
  });
});
