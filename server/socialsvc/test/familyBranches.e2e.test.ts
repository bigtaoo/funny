// Family layer branch-coverage gap-fill (2026-09-03 pass): src/family/membership.ts 91.47%,
// internal.ts 89.18%, chat.ts 91.42%, shared.ts 95% branch. family.e2e.test.ts + familyHttp*.e2e
// already drive the whole lifecycle, but always from inside a consistent family: a real families doc,
// a requester who IS a member, an insert that either succeeds or collides on the tag, and a CAS that
// always wins. The 19 branches left over are the states that arise when that isn't so:
//
//   * a requester who belongs to no family at all reaching kick/announcement/emblem. Each of those
//     dereferences the membership row right after the guard, so the guard is the only thing between a
//     non-member request and a TypeError.
//   * elder-vs-elder kick, and setRole on yourself — the two permission rules with no coverage. Both
//     protect against self-inflicted, unrecoverable states (an elder demoting the peer who could have
//     restrained them; a leader demoting themself, after which nobody can promote anyone).
//   * an insertOne failing with something OTHER than E11000. Only a duplicate key is a benign race
//     here; a real write failure must propagate rather than be reported as "already in a family",
//     which would send a player chasing a membership they do not have.
//   * `respondJoinRequest` losing its status CAS: the applicant must NOT be joined off a request
//     another approver already resolved.
//   * documents missing fields a newer writer always sets — a family with no `activity`, a member row
//     whose family doc is gone, a message whose `ts` is a number. These are the `?? 0` / `if (!fam)` /
//     `instanceof Date` fallbacks, i.e. what the read paths do instead of returning NaN or crashing.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EMBLEM_KEYS, EMBLEM_COLORS, familyProsperity, type ErrorCode } from '@nw/shared';
import type { FamilyDoc, FamilyMessageDoc, SocialMongo } from '../src/db';
import { FamilyService } from '../src/familyService';
import { FamilyChatService } from '../src/family/chat';
import { FamilyInternalService } from '../src/family/internal';
import { MailService } from '../src/mailService';
import { tryConnect, FakeMeta, FakeGateway } from './harness';
import { withCollection } from './stubCols';

const mongo = await tryConnect('nw_social_family_branches_test');
if (!mongo) console.warn('[socialsvc.familyBranches.e2e] Mongo unreachable — skipping.');

/** Assert an async call rejects with a SlgError carrying the given code. */
async function expectErr(p: Promise<unknown>, code: keyof typeof ErrorCode): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

describe.skipIf(!mongo)('socialsvc family layer branch gaps', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let meta: FakeMeta;
  let gateway: FakeGateway;
  let mailSvc: MailService;
  let svc: FamilyService;

  beforeEach(async () => {
    await Promise.all([
      m.collections.families.deleteMany({}),
      m.collections.familyMembers.deleteMany({}),
      m.collections.familyMessages.deleteMany({}),
      m.collections.familyJoinRequests.deleteMany({}),
      m.collections.mails.deleteMany({}),
    ]);
    nowMs = 1_000_000;
    meta = new FakeMeta()
      .add('leader', 'P-LEAD', 'Leader')
      .add('elder1', 'P-E1', 'ElderOne')
      .add('elder2', 'P-E2', 'ElderTwo')
      .add('member', 'P-MEM', 'Member')
      .add('outsider', 'P-OUT', 'Outsider')
      .add('applicant', 'P-APP', 'Applicant');
    gateway = new FakeGateway();
    mailSvc = new MailService({ cols: m.collections, gateway, meta, now });
    svc = new FamilyService({ cols: m.collections, now, gateway, meta, mail: mailSvc });
  });

  afterAll(async () => { await m.close(); });

  /** leader + two elders + one plain member in fam:BR. */
  async function seedFamily(): Promise<string> {
    await svc.createFamily('leader', 'Branchers', 'BR');
    for (const id of ['elder1', 'elder2', 'member']) await svc.joinFamily(id, 'fam:BR');
    await svc.setRole('leader', 'elder1', 'elder');
    await svc.setRole('leader', 'elder2', 'elder');
    return 'fam:BR';
  }

  // ── createFamily: name validation + non-duplicate insert failures ────────────

  it('createFamily: an empty name is width 0 and rejected (orgNameWidth is never called on it)', async () => {
    await expectErr(svc.createFamily('leader', '', 'AAA'), 'BAD_REQUEST');
    expect(await m.collections.families.countDocuments({})).toBe(0);
  });

  it('createFamily: a duplicate tag is ALREADY_IN_FAMILY, but any other insert error propagates', async () => {
    await svc.createFamily('leader', 'Branchers', 'BR');
    // The unique index on `tag` is what E11000 means here; reported as ALREADY_IN_FAMILY (the tag is
    // taken, so this account cannot have this family).
    await expectErr(svc.createFamily('outsider', 'Other', 'BR'), 'ALREADY_IN_FAMILY');

    const cols = withCollection(m.collections, 'families', {
      insertOne: async () => { throw Object.assign(new Error('write refused'), { code: 121 }); },
    });
    const broken = new FamilyService({ cols, now, gateway, meta, mail: mailSvc });
    await expect(broken.createFamily('outsider', 'Other', 'ZZ')).rejects.toThrow('write refused');
  });

  it('createFamily: the leader member view carries avatarId when the profile has one', async () => {
    meta.avatar('leader', 'portrait:ink-01');
    const fam = await svc.createFamily('leader', 'Branchers', 'BR');
    expect(fam.members[0]).toMatchObject({ accountId: 'leader', publicId: 'P-LEAD', avatarId: 'portrait:ink-01' });
  });

  // ── joinFamily / requestJoin: non-duplicate insert failures ──────────────────

  it('joinFamily: a member insert failing with something other than E11000 propagates', async () => {
    await svc.createFamily('leader', 'Branchers', 'BR');
    const cols = withCollection(m.collections, 'familyMembers', {
      insertOne: async () => { throw Object.assign(new Error('write refused'), { code: 121 }); },
    });
    const broken = new FamilyService({ cols, now, gateway, meta, mail: mailSvc });
    await expect(broken.joinFamily('outsider', 'fam:BR')).rejects.toThrow('write refused');
  });

  it('requestJoin: a request insert failing with something other than E11000 propagates', async () => {
    await svc.createFamily('leader', 'Branchers', 'BR');
    const cols = withCollection(m.collections, 'familyJoinRequests', {
      insertOne: async () => { throw Object.assign(new Error('write refused'), { code: 121 }); },
    });
    const broken = new FamilyService({ cols, now, gateway, meta, mail: mailSvc });
    await expect(broken.requestJoin('applicant', 'fam:BR')).rejects.toThrow('write refused');
  });

  it('requestJoin: a duplicate pending request (E11000 from the partial unique index) is ALREADY_REQUESTED', async () => {
    await svc.createFamily('leader', 'Branchers', 'BR');
    const cols = withCollection(m.collections, 'familyJoinRequests', {
      insertOne: async () => { throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); },
    });
    const raced = new FamilyService({ cols, now, gateway, meta, mail: mailSvc });
    await expectErr(raced.requestJoin('applicant', 'fam:BR'), 'ALREADY_REQUESTED');
  });

  // ── respondJoinRequest ──────────────────────────────────────────────────────

  it('respondJoinRequest: losing the status CAS is NOT_FOUND and the applicant is not joined', async () => {
    await svc.createFamily('leader', 'Branchers', 'BR');
    const { requestId } = await svc.requestJoin('applicant', 'fam:BR');
    // Another leader/elder resolved this request first: the guarded update matches nothing. Joining
    // anyway would add a member off a request that has already been rejected.
    const cols = withCollection(m.collections, 'familyJoinRequests', { findOneAndUpdate: async () => null });
    const raced = new FamilyService({ cols, now, gateway, meta, mail: mailSvc });
    await expectErr(raced.respondJoinRequest('leader', requestId, true), 'NOT_FOUND');
    expect(await m.collections.familyMembers.countDocuments({ _id: 'applicant' })).toBe(0);
    expect((await m.collections.families.findOne({ _id: 'fam:BR' }))!.memberCount).toBe(1);
  });

  it('respondJoinRequest: rejecting when the family doc is gone still mails, with an empty family name', async () => {
    await svc.createFamily('leader', 'Branchers', 'BR');
    const { requestId } = await svc.requestJoin('applicant', 'fam:BR');
    // The family was dissolved out from under the pending request (its member rows still name it).
    // The applicant is owed the rejection mail regardless; the name is simply blank in it.
    await m.collections.families.deleteOne({ _id: 'fam:BR' });
    await svc.respondJoinRequest('leader', requestId, false);
    const mail = await m.collections.mails.findOne({ to: 'applicant' });
    expect(mail!.body).toBe('family.mail.rejected.body|familyName=');
  });

  // ── permission guards with no coverage ──────────────────────────────────────

  it('kickMember: a requester who is in no family at all is NOT_IN_FAMILY', async () => {
    await seedFamily();
    await expectErr(svc.kickMember('outsider', 'member'), 'NOT_IN_FAMILY');
    expect(await m.collections.familyMembers.countDocuments({ _id: 'member' })).toBe(1);
  });

  it('kickMember: an elder cannot kick another elder (only the leader can)', async () => {
    await seedFamily();
    await expectErr(svc.kickMember('elder1', 'elder2'), 'NO_PERMISSION');
    await svc.kickMember('leader', 'elder2');
    expect(await m.collections.familyMembers.countDocuments({ _id: 'elder2' })).toBe(0);
  });

  it('setRole: nobody can change their own role (a leader demoting themself is unrecoverable)', async () => {
    await seedFamily();
    await expectErr(svc.setRole('leader', 'leader', 'elder'), 'BAD_REQUEST');
    expect((await m.collections.familyMembers.findOne({ _id: 'leader' }))!.role).toBe('leader');
  });

  it('setAnnouncement / setEmblem: a requester who is in no family is NOT_IN_FAMILY', async () => {
    await seedFamily();
    await expectErr(svc.setAnnouncement('outsider', 'hello'), 'NOT_IN_FAMILY');
    await expectErr(svc.setEmblem('outsider', EMBLEM_KEYS[0]!, EMBLEM_COLORS[0]!), 'NOT_IN_FAMILY');
  });

  // ── internal read paths: documents missing newer fields ─────────────────────

  it('getMember: a member row whose family doc is gone reads as null, not a half-filled view', async () => {
    await m.collections.familyMembers.insertOne({
      _id: 'orphan', familyId: 'fam:GONE', accountId: 'orphan', role: 'member', joinedAt: nowMs,
    });
    expect(await svc.getMember('orphan')).toBeNull();
  });

  it('getFamiliesByIds: an empty id list short-circuits to [] (no query)', async () => {
    expect(await svc.getFamiliesByIds([])).toEqual([]);
  });

  it('refreshProsperity: a family doc with no activity field scores it as 0', async () => {
    // A doc predating the `activity` field; `?? 0` is what keeps prosperity a number rather than NaN.
    const legacy = {
      _id: 'fam:OLD', name: 'Old', tag: 'OLD', leaderId: 'leader', memberCount: 3,
      prosperity: 0, prosperityUpdatedAt: nowMs, createdAt: nowMs, rev: 1,
    } as unknown as FamilyDoc;
    await m.collections.families.insertOne(legacy);
    expect(await svc.refreshProsperity('fam:OLD', 4)).toBe(familyProsperity(4, 3, 0));
    expect(await svc.refreshProsperity('fam:NOSUCH', 4)).toBe(0);
  });

  it('bumpActivityAndProsperity: a returned doc with no activity field scores it as 0', async () => {
    const cols = withCollection(m.collections, 'families', {
      findOneAndUpdate: async () => ({
        _id: 'fam:OLD', name: 'Old', tag: 'OLD', leaderId: 'leader', memberCount: 2,
        prosperity: 0, prosperityUpdatedAt: nowMs, createdAt: nowMs, rev: 1,
      }),
    });
    const internal = new FamilyInternalService({ cols, now, gateway, meta });
    expect(await internal.bumpActivityAndProsperity('fam:OLD', 1, 5)).toBe(familyProsperity(5, 2, 0));
  });

  // ── family chat channel ─────────────────────────────────────────────────────

  it('sendMessage: deps with no gateway fall back to the no-op client (the message still persists)', async () => {
    await svc.createFamily('leader', 'Branchers', 'BR');
    // socialsvc runs with gateway push disabled when NW_GATEWAY_INTERNAL_URL is unset — chat must
    // still be written to the channel (clients poll for it), just not pushed.
    const chat = new FamilyChatService({ cols: m.collections, now, meta });
    const view = await chat.sendMessage('leader', 'Leader', 'hello');
    expect(view.body).toBe('hello');
    expect(await m.collections.familyMessages.countDocuments({ familyId: 'fam:BR' })).toBe(1);
    expect(gateway.pushes).toHaveLength(0);
  });

  it('sendMessage: a missing family doc omits familyName rather than sending it undefined', async () => {
    await svc.createFamily('leader', 'Branchers', 'BR');
    await m.collections.families.deleteOne({ _id: 'fam:BR' });
    const view = await svc.sendMessage('leader', 'Leader', 'hello');
    expect(view.familyName).toBeUndefined();
    expect(await m.collections.familyMessages.findOne({ familyId: 'fam:BR' })).not.toHaveProperty('familyName');
  });

  it('getChannel: a message row with a numeric ts is converted instead of yielding NaN', async () => {
    await svc.createFamily('leader', 'Branchers', 'BR');
    await m.collections.familyMessages.insertOne({
      _id: 'fm:legacy', familyId: 'fam:BR', senderId: 'leader', senderName: 'Leader',
      body: 'old', ts: nowMs as unknown as Date,
    } as FamilyMessageDoc);
    const [msg] = await svc.getChannel('leader');
    expect(msg).toMatchObject({ id: 'fm:legacy', ts: nowMs });
  });
});
