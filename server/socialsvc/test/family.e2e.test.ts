// FamilyService end-to-end (SOCIAL_SVC_DESIGN §3/§4): real Mongo + fake clock/meta/gateway.
// Covers the family lifecycle (create/join/leave/kick/setRole/dissolve), permission tiers,
// the 30-member cap, the family chat channel, and the worldsvc-facing internal API
// (membership lookup, activity bump, sect mirror, prosperity refresh, season reset).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FAMILY_CAP, FAMILY_MSG_BODY_MAX, familyProsperity, type ErrorCode } from '@nw/shared';
import type { SocialMongo } from '../src/db';
import { FamilyService } from '../src/familyService';
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

  beforeEach(async () => {
    await m.collections.families.deleteMany({});
    await m.collections.familyMembers.deleteMany({});
    await m.collections.familyMessages.deleteMany({});
    nowMs = 1_000_000;
    meta = new FakeMeta().add('leader', 'P-LEAD').add('m1', 'P-M1').add('m2', 'P-M2');
    gateway = new FakeGateway();
    svc = new FamilyService({ cols: m.collections, now, gateway, meta });
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

  it('leaveFamily: member leaves; leader cannot leave (must transfer/dissolve)', async () => {
    const fam = await svc.createFamily('leader', 'Leavers', 'LEAV');
    await svc.joinFamily('m1', fam.familyId);
    await svc.leaveFamily('m1');
    expect((await svc.getFamily(fam.familyId))!.memberCount).toBe(1);
    expect(await svc.getFamilyIdByAccount('m1')).toBeNull();
    await expectErr(svc.leaveFamily('leader'), 'BAD_REQUEST');   // leader blocked
    await expectErr(svc.leaveFamily('stranger'), 'NOT_IN_FAMILY');
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

  it('setSect / getFamiliesBySect / getFamiliesByIds / resetSlgState: sect mirror + season reset', async () => {
    const a = await svc.createFamily('leader', 'Alpha', 'ALFA');
    const b = await svc.createFamily('m1', 'Bravo', 'BRVO');
    await svc.setSect(a.familyId, 'sect:1');
    await svc.setSect(b.familyId, 'sect:1');
    await svc.refreshProsperity(a.familyId, 5);

    const roster = await svc.getFamiliesBySect('sect:1');
    expect(new Set(roster.map((f) => f.familyId))).toEqual(new Set([a.familyId, b.familyId]));
    const byIds = await svc.getFamiliesByIds([a.familyId, 'fam:MISS']);
    expect(byIds).toHaveLength(1);

    await svc.setSect(a.familyId, null); // clear
    expect((await svc.getFamily(a.familyId))!.sectId).toBeUndefined();

    await svc.resetSlgState(b.familyId); // wipe season state, keep identity
    const bAfter = await svc.getFamily(b.familyId);
    expect(bAfter!.prosperity).toBe(0);
    expect(bAfter!.territoryCount).toBe(0);
    expect(bAfter!.sectId).toBeUndefined();
    expect(bAfter!.leaderId).toBe('m1'); // identity intact
  });

  it('searchByTag: case-insensitive exact match', async () => {
    await svc.createFamily('leader', 'Searchable', 'SRCH');
    expect((await svc.searchByTag('srch'))!.tag).toBe('SRCH');
    expect(await svc.searchByTag('nope')).toBeNull();
  });
});
