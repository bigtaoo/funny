// FamilyService end-to-end (SOCIAL_SVC_DESIGN §3/§4): real Mongo + fake clock/meta/gateway.
// Covers the family lifecycle (create/join/leave/kick/setRole/dissolve), permission tiers,
// the 30-member cap, the family chat channel, and the worldsvc-facing internal API
// (membership lookup, activity bump, sect mirror, prosperity refresh, season reset).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FAMILY_CAP, FAMILY_MSG_BODY_MAX, familyProsperity, type ErrorCode } from '@nw/shared';
import type { SocialMongo } from '../src/db';
import { FamilyService } from '../src/familyService';
import { MailService } from '../src/mailService';
import { tryConnect, FakeMeta, FakeGateway } from './harness';

const mongo = await tryConnect('nw_social_family_test');
if (!mongo) console.warn('[socialsvc.family.e2e] Mongo unreachable — skipping.');

/** Assert an async call rejects with a SlgError carrying the given code. */
async function expectErr(p: Promise<unknown>, code: keyof typeof ErrorCode): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

describe.skipIf(!mongo)('socialsvc FamilyService e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let meta: FakeMeta;
  let gateway: FakeGateway;
  let svc: FamilyService;
  let mailSvc: MailService;

  beforeEach(async () => {
    await m.collections.families.deleteMany({});
    await m.collections.familyMembers.deleteMany({});
    await m.collections.familyMessages.deleteMany({});
    await m.collections.familyJoinRequests.deleteMany({});
    await m.collections.mails.deleteMany({});
    nowMs = 1_000_000;
    meta = new FakeMeta().add('leader', 'P-LEAD').add('m1', 'P-M1').add('m2', 'P-M2');
    gateway = new FakeGateway();
    mailSvc = new MailService({ cols: m.collections, gateway, meta, now });
    svc = new FamilyService({ cols: m.collections, now, gateway, meta, mail: mailSvc });
  });

  afterAll(async () => { await m.close(); });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  it('createFamily: leader added as sole member, resolved profile attached', async () => {
    const fam = await svc.createFamily('leader', 'The Inklords', 'ink');
    expect(fam.familyId).toBe('fam:INK'); // tag uppercased
    expect(fam.tag).toBe('INK');
    expect(fam.leaderId).toBe('leader');
    expect(fam.memberCount).toBe(1);
    expect(fam.members).toHaveLength(1);
    expect(fam.members[0]).toMatchObject({ accountId: 'leader', role: 'leader', publicId: 'P-LEAD' });
  });

  it('createFamily: rejects bad tag / bad name / double-membership / duplicate tag', async () => {
    await expectErr(svc.createFamily('leader', 'Valid Name', 'a'), 'BAD_REQUEST');       // tag too short
    await expectErr(svc.createFamily('leader', 'Valid Name', 'toolong'), 'BAD_REQUEST'); // tag too long
    await expectErr(svc.createFamily('leader', 'x', 'ABC'), 'BAD_REQUEST');              // name too short (width 1 < 2)
    await expectErr(svc.createFamily('leader', '七个汉字超限了', 'CJK'), 'BAD_REQUEST');   // name too long (7 汉字 = width 14 > 12)
    await expectErr(svc.createFamily('leader', 'abcdefghijklm', 'LAT'), 'BAD_REQUEST');  // name too long (13 letters > 12)
    await svc.createFamily('leader', 'First Family', 'AAA');
    await expectErr(svc.createFamily('leader', 'Second Family', 'BBB'), 'ALREADY_IN_FAMILY'); // already in a family
    await expectErr(svc.createFamily('m1', 'Tag Clash', 'AAA'), 'ALREADY_IN_FAMILY');         // duplicate tag → unique index
  });

  it('createFamily: rejects a name that hits the sensitive-word filter (CONTENT_MODERATION_DESIGN.md CM5)', async () => {
    // 'shit' is in chatFilter.ts's global word list — family name is long-lived/public like a
    // displayName, so a hit rejects creation outright rather than persisting a masked name.
    await expectErr(svc.createFamily('leader', 'Shit Family', 'BAD1'), 'BAD_REQUEST');
    // Rejected creation must not have left the caller "in a family" — a clean retry succeeds.
    const fam = await svc.createFamily('leader', 'Clean Family', 'CLN1');
    expect(fam.name).toBe('Clean Family');
  });

  it('createFamily: accepts a name exactly at the width cap (6 汉字 = width 12)', async () => {
    const fam = await svc.createFamily('leader', '六个汉字上限', 'CAP6');
    expect(fam.name).toBe('六个汉字上限');
  });

  it('joinFamily: member added, memberCount incremented, role=member', async () => {
    const fam = await svc.createFamily('leader', 'Joiners', 'JOIN');
    await svc.joinFamily('m1', fam.familyId);
    const detail = await svc.getFamily(fam.familyId);
    expect(detail!.memberCount).toBe(2);
    expect(detail!.members.find((x) => x.accountId === 'm1')?.role).toBe('member');
  });

  it('regression: getFamily strips accountId for a non-member caller, keeps it for a member/internal caller', async () => {
    // Root cause: getFamily took no caller/membership parameter and returned the full member list
    // (including raw accountId, not just publicId) for ANY family id — GET /social/family/:id is a public
    // route reachable for any family id (discoverable via browse/search), so a non-member could look up
    // any family's roster and get every member's real internal accountId, unlike every other
    // externally-facing view in this service (which deliberately exposes only publicId/displayName).
    const fam = await svc.createFamily('leader', 'Private Club', 'PRIV');
    await svc.joinFamily('m1', fam.familyId);

    // Non-member caller ('outsider') → accountId stripped from every member.
    const asOutsider = await svc.getFamily(fam.familyId, 'outsider');
    expect(asOutsider!.members).toHaveLength(2);
    for (const mem of asOutsider!.members) {
      expect(mem.accountId).toBeUndefined();
      expect(mem.role).toBeDefined(); // other fields still present
    }

    // Member caller ('m1') → full view, accountId present.
    const asMember = await svc.getFamily(fam.familyId, 'm1');
    expect(asMember!.members.map((mm) => mm.accountId).sort()).toEqual(['leader', 'm1']);

    // No callerId (trusted internal caller, e.g. /internal/push) → full view, unchanged behavior.
    const asInternal = await svc.getFamily(fam.familyId);
    expect(asInternal!.members.map((mm) => mm.accountId).sort()).toEqual(['leader', 'm1']);
  });

  it('joinFamily: rejects unknown family and double-membership', async () => {
    await expectErr(svc.joinFamily('m1', 'fam:NOPE'), 'NOT_FOUND');
    const fam = await svc.createFamily('leader', 'Full House', 'FULL');
    await svc.joinFamily('m1', fam.familyId);
    await expectErr(svc.joinFamily('m1', fam.familyId), 'ALREADY_IN_FAMILY');
  });

  it('joinFamily: enforces the 30-member cap', async () => {
    const fam = await svc.createFamily('leader', 'Capped', 'CAP');
    // leader already counts as 1 → add FAMILY_CAP-1 more to fill it.
    for (let i = 1; i < FAMILY_CAP; i++) await svc.joinFamily(`filler${i}`, fam.familyId);
    const full = await svc.getFamily(fam.familyId);
    expect(full!.memberCount).toBe(FAMILY_CAP);
    await expectErr(svc.joinFamily('overflow', fam.familyId), 'FAMILY_FULL');
    // memberCount not corrupted by the rejected join.
    expect((await svc.getFamily(fam.familyId))!.memberCount).toBe(FAMILY_CAP);
    expect(await m.collections.familyMembers.findOne({ _id: 'overflow' })).toBeNull();
  });

  // ── Join-request approval (SS3.x) ────────────────────────────────────────────

  it('requestJoin: creates a pending request without adding membership', async () => {
    const fam = await svc.createFamily('leader', 'Requesters', 'REQ');
    const { requestId } = await svc.requestJoin('m1', fam.familyId);
    expect(requestId).toBeTruthy();
    expect((await svc.getFamily(fam.familyId))!.memberCount).toBe(1); // still just the leader
    expect(await svc.getFamilyIdByAccount('m1')).toBeNull();
  });

  it('requestJoin: rejects unknown family, double-membership, full family, and duplicate pending request', async () => {
    await expectErr(svc.requestJoin('m1', 'fam:NOPE'), 'NOT_FOUND');

    const fam = await svc.createFamily('leader', 'Requesters2', 'REQ2');
    await expectErr(svc.requestJoin('leader', fam.familyId), 'ALREADY_IN_FAMILY');

    await svc.requestJoin('m1', fam.familyId);
    await expectErr(svc.requestJoin('m1', fam.familyId), 'ALREADY_REQUESTED');

    const full = await svc.createFamily('leader2', 'Full Reqs', 'FREQ');
    meta.add('leader2', 'P-LEAD2');
    for (let i = 1; i < FAMILY_CAP; i++) await svc.joinFamily(`filler${i}`, full.familyId);
    await expectErr(svc.requestJoin('overflow', full.familyId), 'FAMILY_FULL');
  });

  it('regression: joinFamily loses a race against itself (same account, two families) without leaving memberCount drift', async () => {
    // Root cause: familyMembers._id is the accountId itself (one doc per account, globally), but
    // joinFamily's "already in a family" check was a plain findOne before insertOne — not atomic with the
    // memberCount $inc. Two concurrent joinFamily calls for the SAME account (e.g. two of their pending
    // join requests, to different families, both accepted around the same time) could both pass the
    // check, both bump memberCount on their respective families, and then only one insertOne could ever
    // win (accountId is the doc's _id) — the loser used to surface as an uncaught E11000 (500), leaving
    // its family's memberCount permanently incremented above the real roster size.
    const famA = await svc.createFamily('leader', 'Race A', 'RACA');
    const famB = await svc.createFamily('leader2', 'Race B', 'RACB');
    meta.add('leader2', 'P-LEAD2');

    const results = await Promise.allSettled([
      svc.joinFamily('m1', famA.familyId),
      svc.joinFamily('m1', famB.familyId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'ALREADY_IN_FAMILY' });

    // Whichever family lost must have its memberCount rolled back to just the leader (1), not left at 2
    // with no corresponding member.
    const [detailA, detailB] = await Promise.all([svc.getFamily(famA.familyId), svc.getFamily(famB.familyId)]);
    const winnerIsA = detailA!.members.some((mm) => mm.accountId === 'm1');
    const winner = winnerIsA ? detailA! : detailB!;
    const loser = winnerIsA ? detailB! : detailA!;
    expect(winner.memberCount).toBe(2);
    expect(loser.memberCount).toBe(1);
    expect(loser.members.some((mm) => mm.accountId === 'm1')).toBe(false);
  });

  it('regression: requestJoin rejects a concurrent second pending request for the same account (unique index backstop)', async () => {
    // Root cause: the "no existing pending request" check is a plain findOne before insertOne — not
    // atomic — so two near-simultaneous requestJoin calls for the same account (to the same or different
    // families) could both pass it and both create a pending request. If both were later accepted, this
    // fed directly into the joinFamily race above. The partial unique index on {accountId} (status:'pending')
    // is the atomic backstop.
    await m.ensureIndexes();
    const famA = await svc.createFamily('leader', 'ReqRace A', 'RQRA');
    const famB = await svc.createFamily('leader2', 'ReqRace B', 'RQRB');
    meta.add('leader2', 'P-LEAD2');

    const results = await Promise.allSettled([
      svc.requestJoin('m1', famA.familyId),
      svc.requestJoin('m1', famB.familyId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'ALREADY_REQUESTED' });

    const pending = await m.collections.familyJoinRequests.find({ accountId: 'm1', status: 'pending' }).toArray();
    expect(pending).toHaveLength(1);
  });

  it('listJoinRequests: leader/elder only, resolves applicant profile', async () => {
    const fam = await svc.createFamily('leader', 'Listers', 'LIST');
    await svc.requestJoin('m1', fam.familyId);
    const list = await svc.listJoinRequests('leader');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ accountId: 'm1', publicId: 'P-M1' });

    await svc.joinFamily('m2', fam.familyId); // plain member, not an approver
    await expectErr(svc.listJoinRequests('m2'), 'NO_PERMISSION');
    await expectErr(svc.listJoinRequests('nobody'), 'NOT_IN_FAMILY');
  });

  it('respondJoinRequest: accept adds membership and clears the pending request', async () => {
    const fam = await svc.createFamily('leader', 'Approvers', 'APRV');
    const { requestId } = await svc.requestJoin('m1', fam.familyId);
    await svc.respondJoinRequest('leader', requestId, true);

    const detail = await svc.getFamily(fam.familyId);
    expect(detail!.memberCount).toBe(2);
    expect(detail!.members.find((x) => x.accountId === 'm1')?.role).toBe('member');
    expect(await svc.listJoinRequests('leader')).toHaveLength(0);
    // No rejection mail on accept.
    expect(await m.collections.mails.findOne({ to: 'm1' })).toBeNull();
  });

  it('respondJoinRequest: reject mails the applicant and leaves membership untouched', async () => {
    const fam = await svc.createFamily('leader', 'Rejecters', 'REJT');
    const { requestId } = await svc.requestJoin('m1', fam.familyId);
    await svc.respondJoinRequest('leader', requestId, false);

    expect(await svc.getFamilyIdByAccount('m1')).toBeNull();
    expect((await svc.getFamily(fam.familyId))!.memberCount).toBe(1);
    expect(await svc.listJoinRequests('leader')).toHaveLength(0);

    const mail = await m.collections.mails.findOne({ to: 'm1' });
    expect(mail).toMatchObject({ subject: 'family.mail.rejected.subject' });
    expect(mail!.body).toMatch(/^family\.mail\.rejected\.body\|familyName=Rejecters$/);
  });

  it('respondJoinRequest: elder may respond; member and non-members may not', async () => {
    const fam = await svc.createFamily('leader', 'Tiered', 'TIER');
    await svc.joinFamily('elder1', fam.familyId);
    await svc.setRole('leader', 'elder1', 'elder');
    await svc.joinFamily('member1', fam.familyId);

    const { requestId: r1 } = await svc.requestJoin('m1', fam.familyId);
    await expectErr(svc.respondJoinRequest('member1', r1, true), 'NO_PERMISSION');
    await expectErr(svc.respondJoinRequest('outsider', r1, true), 'NOT_IN_FAMILY');
    await svc.respondJoinRequest('elder1', r1, true);
    expect(await svc.getFamilyIdByAccount('m1')).toBe(fam.familyId);
  });

  it('respondJoinRequest: rejects a request already resolved or from another family', async () => {
    const famA = await svc.createFamily('leader', 'AFam', 'AFAM');
    await svc.createFamily('leader2', 'BFam', 'BFAM');
    meta.add('leader2', 'P-LEAD2');
    const { requestId } = await svc.requestJoin('m1', famA.familyId);

    await expectErr(svc.respondJoinRequest('leader2', requestId, true), 'NOT_FOUND'); // wrong family
    await svc.respondJoinRequest('leader', requestId, true);
    await expectErr(svc.respondJoinRequest('leader', requestId, true), 'NOT_FOUND'); // already resolved
  });

  it('leaveFamily: member leaves; leader cannot leave (must transfer/dissolve)', async () => {
    const fam = await svc.createFamily('leader', 'Leavers', 'LEAV');
    await svc.joinFamily('m1', fam.familyId);
    await svc.leaveFamily('m1');
    expect((await svc.getFamily(fam.familyId))!.memberCount).toBe(1);
    expect(await svc.getFamilyIdByAccount('m1')).toBeNull();
    await expectErr(svc.leaveFamily('leader'), 'BAD_REQUEST');   // leader blocked
    await expectErr(svc.leaveFamily('stranger'), 'NOT_IN_FAMILY');
  });

  // Regression for the 2026-07-29 audit fix: leaveFamily used to unconditionally $inc memberCount by -1
  // after deleteOne, regardless of whether that call actually removed a row. Two concurrent calls
  // targeting the same member (e.g. a network retry of leaveFamily, or leaveFamily racing kickMember on
  // the same account) would both decrement even though only one deleteOne actually removed anything —
  // double-counting a single removal and drifting memberCount BELOW the real member row count (the
  // unsafe direction: under-counting lets the family creep past FAMILY_CAP instead of just blocking a
  // join prematurely).
  it('leaveFamily: concurrent duplicate calls for the same member decrement memberCount only once', async () => {
    const fam = await svc.createFamily('leader', 'Racers', 'RACE');
    await svc.joinFamily('m1', fam.familyId);
    await svc.joinFamily('m2', fam.familyId); // memberCount = 3 (leader + m1 + m2)

    const results = await Promise.allSettled([svc.leaveFamily('m1'), svc.leaveFamily('m1')]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect((await svc.getFamily(fam.familyId))!.memberCount).toBe(2); // leader + m2, not 1
  });

  it('kickMember: concurrently kicking the same target (racing leaveFamily) decrements memberCount only once', async () => {
    const fam = await svc.createFamily('leader', 'Racers2', 'RAC2');
    await svc.joinFamily('m1', fam.familyId); // memberCount = 2

    await Promise.allSettled([svc.kickMember('leader', 'm1'), svc.leaveFamily('m1')]);
    expect((await svc.getFamily(fam.familyId))!.memberCount).toBe(1); // just the leader, not 0
  });

  // ── Permissions ──────────────────────────────────────────────────────────────

  it('kickMember: leader kicks anyone; elder kicks only members; member cannot kick', async () => {
    const fam = await svc.createFamily('leader', 'Kickers', 'KICK');
    await svc.joinFamily('m1', fam.familyId);
    await svc.joinFamily('m2', fam.familyId);
    await svc.setRole('leader', 'm1', 'elder'); // m1 = elder, m2 = member

    await expectErr(svc.kickMember('m2', 'm1'), 'NO_PERMISSION');      // member cannot kick
    await expectErr(svc.kickMember('m1', 'leader'), 'NO_PERMISSION');  // elder cannot kick leader
    await svc.kickMember('m1', 'm2');                                  // elder kicks member → ok
    expect(await svc.getFamilyIdByAccount('m2')).toBeNull();
    expect((await svc.getFamily(fam.familyId))!.memberCount).toBe(2);
    await expectErr(svc.kickMember('leader', 'leader'), 'BAD_REQUEST'); // cannot kick self
  });

  it('setRole: leader-only, cannot promote to leader, target must be same family', async () => {
    const fam = await svc.createFamily('leader', 'Roles', 'ROLE');
    await svc.joinFamily('m1', fam.familyId);
    await expectErr(svc.setRole('leader', 'm1', 'leader'), 'BAD_REQUEST');   // cannot assign leader
    await expectErr(svc.setRole('m1', 'leader', 'elder'), 'NO_PERMISSION'); // non-leader requester
    await svc.setRole('leader', 'm1', 'elder');
    expect((await svc.getMember('m1'))!.role).toBe('elder');
  });

  it('dissolveFamily: leader-only; wipes members, messages, and the family doc', async () => {
    const fam = await svc.createFamily('leader', 'Doomed', 'DOOM');
    await svc.joinFamily('m1', fam.familyId);
    await svc.sendMessage('leader', 'Leader', 'last words');
    await expectErr(svc.dissolveFamily('m1'), 'NO_PERMISSION'); // non-leader
    await svc.dissolveFamily('leader');
    expect(await svc.getFamily(fam.familyId)).toBeNull();
    expect(await m.collections.familyMembers.countDocuments({ familyId: fam.familyId })).toBe(0);
    expect(await m.collections.familyMessages.countDocuments({ familyId: fam.familyId })).toBe(0);
  });

  it('setAnnouncement: leader/elder allowed, plain member denied, length capped', async () => {
    const fam = await svc.createFamily('leader', 'Announce', 'ANNC');
    await svc.joinFamily('m1', fam.familyId);
    await expectErr(svc.setAnnouncement('m1', 'hi'), 'NO_PERMISSION');
    await expectErr(svc.setAnnouncement('leader', 'x'.repeat(201)), 'BAD_REQUEST');
    await svc.setAnnouncement('leader', 'Welcome, scribes.');
    expect((await svc.getFamily(fam.familyId))!.announcement).toBe('Welcome, scribes.');
  });

  // ── Chat channel ──────────────────────────────────────────────────────────────

  it('sendMessage: persists, pushes to other members only, and paginates by ts', async () => {
    const fam = await svc.createFamily('leader', 'Chatters', 'CHAT');
    await svc.joinFamily('m1', fam.familyId);
    await svc.joinFamily('m2', fam.familyId);

    nowMs = 2_000; await svc.sendMessage('leader', 'Leader', 'first');
    nowMs = 3_000; await svc.sendMessage('leader', 'Leader', 'second');

    // Pushed to the two other members, not the sender.
    const fam_msgs = gateway.ofKind('family_msg');
    expect(fam_msgs).toHaveLength(2 /*msgs*/ * 2 /*recipients*/);
    expect(new Set(gateway.pushes.map((p) => p.accountId))).toEqual(new Set(['m1', 'm2']));

    // Channel history is newest-first.
    const all = await svc.getChannel('leader');
    expect(all.map((x) => x.body)).toEqual(['second', 'first']);
    // `before` cursor pages backward.
    const older = await svc.getChannel('leader', 3_000);
    expect(older.map((x) => x.body)).toEqual(['first']);
    // Non-member cannot read.
    await expectErr(svc.getChannel('stranger'), 'NOT_IN_FAMILY');
  });

  it('sendMessage: rejects non-members and over-long / empty bodies', async () => {
    const fam = await svc.createFamily('leader', 'Guards', 'GRD');
    await expectErr(svc.sendMessage('stranger', 'X', 'hi'), 'NOT_IN_FAMILY');
    await expectErr(svc.sendMessage('leader', 'Leader', ''), 'BAD_REQUEST');
    await expectErr(svc.sendMessage('leader', 'Leader', 'x'.repeat(FAMILY_MSG_BODY_MAX + 1)), 'BAD_REQUEST');
    void fam;
  });

  it('sendMessage: masks a sensitive word instead of rejecting delivery (CONTENT_MODERATION_DESIGN.md CM5, mask-not-reject like DM/world chat)', async () => {
    await svc.createFamily('leader', 'Maskers', 'MASK');
    const result = await svc.sendMessage('leader', 'Leader', 'what the fuck');
    expect(result.body).toBe('what the ****');
  });

  it('sendMessage: rejects delivery while muted (CONTENT_MODERATION_DESIGN.md CM6/CM7.1)', async () => {
    await svc.createFamily('leader', 'Muters', 'MUTE');
    meta.mute('leader', nowMs + 3600_000); // muted 1h into the future
    await expectErr(svc.sendMessage('leader', 'Leader', 'hello'), 'ACCOUNT_MUTED');
    // Once the mute has expired, the same account can post again.
    nowMs += 3600_001;
    const result = await svc.sendMessage('leader', 'Leader', 'hello again');
    expect(result.body).toBe('hello again');
  });

  // Regression: senderName must never trust a stale client-side cache (e.g. leftover from before
  // a rename, or the raw loginId fallback) once meta can resolve the account's real display name.
  it('sendMessage: senderName resolved from meta.displayName, not blindly trusted from the client', async () => {
    meta = new FakeMeta().add('leader', 'P-LEAD', 'RealNickname').add('m1', 'P-M1');
    svc = new FamilyService({ cols: m.collections, now, gateway, meta });
    const fam = await svc.createFamily('leader', 'Renamed', 'RNM');
    await svc.joinFamily('m1', fam.familyId);

    // Client sends a stale cached name (e.g. the raw loginId) — meta's real nickname must win.
    const result = await svc.sendMessage('leader', '233784986', 'hi everyone');
    expect(result.senderName).toBe('RealNickname');
    const pushed = gateway.ofKind('family_msg');
    expect(pushed[0]).toMatchObject({ fromName: 'RealNickname' });
    const history = await svc.getChannel('leader');
    expect(history[0].senderName).toBe('RealNickname');

    // meta has no profile for this account → falls back to the client-supplied senderName.
    const fallback = await svc.sendMessage('m1', 'ClientFallback', 'hi again');
    expect(fallback.senderName).toBe('P-M1'); // m1 IS registered in meta, so meta wins here too

    const svcNoMeta = new FamilyService({ cols: m.collections, now, gateway, meta: undefined });
    const fallback2 = await svcNoMeta.sendMessage('leader', 'ClientFallback2', 'hi once more');
    expect(fallback2.senderName).toBe('ClientFallback2');
  });

  // Family chat is already scoped to one family, so familyName is cheap to resolve (the family's
  // own name, looked up alongside the sender's meta profile); title comes from meta.equippedTitle.
  // sectName is intentionally NOT resolved here (would need a cross-service call to worldsvc) —
  // absent means the client simply omits that bracket segment.
  it('sendMessage: title + familyName resolved and returned by both sendMessage() and getChannel()', async () => {
    meta = new FakeMeta().add('leader', 'P-LEAD', 'Alice', undefined, 'Grandmaster');
    svc = new FamilyService({ cols: m.collections, now, gateway, meta });
    const fam = await svc.createFamily('leader', 'The Inklords', 'INK');

    const result = await svc.sendMessage('leader', 'Alice', 'hi everyone');
    expect(result.title).toBe('Grandmaster');
    expect(result.familyName).toBe('The Inklords');

    const history = await svc.getChannel('leader');
    expect(history[0]?.title).toBe('Grandmaster');
    expect(history[0]?.familyName).toBe('The Inklords');
    void fam;
  });

  it('sendMessage: title absent (no equippedTitle) still resolves familyName', async () => {
    const fam = await svc.createFamily('leader', 'Titleless', 'NOTL');
    const result = await svc.sendMessage('leader', 'Leader', 'hi');
    expect(result.title).toBeUndefined();
    expect(result.familyName).toBe('Titleless');
    void fam;
  });

  it('sendMessage: title/familyName both absent when meta is not configured', async () => {
    const svcNoMeta = new FamilyService({ cols: m.collections, now, gateway, meta: undefined });
    const fam = await svcNoMeta.createFamily('leader', 'NoMeta', 'NOMT');
    const result = await svcNoMeta.sendMessage('leader', 'Leader', 'hi');
    expect(result.title).toBeUndefined();
    // familyName is resolved independently of meta (a plain families collection lookup),
    // so it's still populated even without meta.
    expect(result.familyName).toBe('NoMeta');
    void fam;
  });

  // ── worldsvc-facing internal API ──────────────────────────────────────────────

  it('getMember / getFamilyIdByAccount: one-round-trip membership identity', async () => {
    expect(await svc.getMember('leader')).toBeNull();
    const fam = await svc.createFamily('leader', 'Idents', 'IDN');
    const mem = await svc.getMember('leader');
    expect(mem).toMatchObject({ familyId: fam.familyId, role: 'leader', leaderId: 'leader', tag: 'IDN', memberCount: 1 });
    expect(await svc.getFamilyIdByAccount('leader')).toBe(fam.familyId);
  });

  it('bumpActivity + refreshProsperity: prosperity recomputed from worldsvc-supplied territory', async () => {
    const fam = await svc.createFamily('leader', 'Prosper', 'PRS');
    await svc.joinFamily('m1', fam.familyId);          // memberCount = 2
    await svc.bumpActivity(fam.familyId, 4);            // activity = 4
    const prosperity = await svc.refreshProsperity(fam.familyId, 7 /*territory*/);
    expect(prosperity).toBe(familyProsperity(7, 2, 4));
    const view = await svc.getFamily(fam.familyId);
    expect(view!.prosperity).toBe(prosperity);
    expect(view!.territoryCount).toBe(7);
    // Missing family → 0, no write.
    expect(await svc.refreshProsperity('fam:GHOST', 100)).toBe(0);
  });

  // Regression coverage for the comm-audit batch F item 9 merge (bumpActivity + refreshProsperity
  // collapsed into one round trip): the combined call must land BOTH the activity $inc and the
  // recomputed prosperity/territoryCount in a single write, matching what two separate calls would do.
  it('bumpActivityAndProsperity: merged activity bump + prosperity refresh land together in one call', async () => {
    const fam = await svc.createFamily('leader', 'Merged', 'MRG');
    await svc.joinFamily('m1', fam.familyId); // memberCount = 2

    const prosperity = await svc.bumpActivityAndProsperity(fam.familyId, 4, 7 /*territory*/);
    expect(prosperity).toBe(familyProsperity(7, 2, 4));

    const view = await svc.getFamily(fam.familyId);
    expect(view!.prosperity).toBe(prosperity);
    expect(view!.territoryCount).toBe(7);
    expect((await svc.getMember('leader'))).toMatchObject({ familyId: fam.familyId }); // sanity: family still intact

    // A second call accumulates the activity delta (not a plain overwrite) and re-derives prosperity from it.
    const prosperity2 = await svc.bumpActivityAndProsperity(fam.familyId, 3, 9 /*new territory*/);
    expect(prosperity2).toBe(familyProsperity(9, 2, 7 /*4+3*/));
    const view2 = await svc.getFamily(fam.familyId);
    expect(view2!.territoryCount).toBe(9);

    // Missing family → 0, no write (same contract as refreshProsperity).
    expect(await svc.bumpActivityAndProsperity('fam:GHOST', 5, 100)).toBe(0);
  });

  it('setSect / getFamiliesBySect / getFamiliesByIds / resetSlgState: sect mirror + season reset', async () => {
    const a = await svc.createFamily('leader', 'Alpha', 'ALFA');
    const b = await svc.createFamily('m1', 'Bravo', 'BRVO');
    await svc.setSect(a.familyId, 'sect:1', 'Iron Fist');
    await svc.setSect(b.familyId, 'sect:1', 'Iron Fist');
    await svc.refreshProsperity(a.familyId, 5);

    const roster = await svc.getFamiliesBySect('sect:1');
    expect(new Set(roster.map((f) => f.familyId))).toEqual(new Set([a.familyId, b.familyId]));
    const byIds = await svc.getFamiliesByIds([a.familyId, 'fam:MISS']);
    expect(byIds).toHaveLength(1);
    expect((await svc.getFamily(a.familyId))!.sectName).toBe('Iron Fist');

    await svc.setSect(a.familyId, null); // clear
    const aAfter = await svc.getFamily(a.familyId);
    expect(aAfter!.sectId).toBeUndefined();
    expect(aAfter!.sectName).toBeUndefined(); // clearing sectId also clears the mirrored name

    await svc.resetSlgState(b.familyId); // wipe season state, keep identity
    const bAfter = await svc.getFamily(b.familyId);
    expect(bAfter!.prosperity).toBe(0);
    expect(bAfter!.territoryCount).toBe(0);
    expect(bAfter!.sectId).toBeUndefined();
    expect(bAfter!.sectName).toBeUndefined();
    expect(bAfter!.leaderId).toBe('m1'); // identity intact
  });

  it('setSect: omitting sectName leaves sectId set without a name (defensive — callers should always pass one)', async () => {
    const a = await svc.createFamily('leader', 'Alpha', 'ALFA');
    await svc.setSect(a.familyId, 'sect:1');
    const view = await svc.getFamily(a.familyId);
    expect(view!.sectId).toBe('sect:1');
    expect(view!.sectName).toBeUndefined();
  });

  it('searchByTag: case-insensitive exact match', async () => {
    await svc.createFamily('leader', 'Searchable', 'SRCH');
    expect((await svc.searchByTag('srch'))!.tag).toBe('SRCH');
    expect(await svc.searchByTag('nope')).toBeNull();
  });

  it('browseFamilies: sorts by prosperity desc, excludes full families, fuzzy-matches name', async () => {
    const low = await svc.createFamily('l1', 'LowPro', 'LOWP');
    const high = await svc.createFamily('l2', 'HighPro', 'HIGP');
    const full = await svc.createFamily('l3', 'FullFam', 'FULL');
    await svc.refreshProsperity(low.familyId, 1);
    await svc.refreshProsperity(high.familyId, 100);
    for (let i = 0; i < FAMILY_CAP - 1; i++) await svc.joinFamily(`filler${i}`, full.familyId);

    const top = await svc.browseFamilies(undefined, 10);
    expect(top.map((f) => f.familyId)).toEqual([high.familyId, low.familyId]);
    expect(top.find((f) => f.familyId === full.familyId)).toBeUndefined();

    const matched = await svc.browseFamilies('highpro');
    expect(matched.map((f) => f.familyId)).toEqual([high.familyId]);

    expect(await svc.browseFamilies('nonexistent')).toEqual([]);
  });
});
