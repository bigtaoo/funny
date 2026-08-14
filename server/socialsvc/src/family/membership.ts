// Family business layer — membership lifecycle: create/join/leave/kick/roles/announcement, plus the
// SS3.x join-request approval flow (SOCIAL_SVC_DESIGN §3/§4). Split out of familyService.ts (see
// ../familyService.ts for the composing facade).
import { randomUUID } from 'node:crypto';
import {
  FAMILY_CAP,
  ORG_NAME_WIDTH_MIN,
  ORG_NAME_WIDTH_MAX,
  orgNameWidth,
  SlgError,
  censorChat,
  isEmblemKey,
  isEmblemColor,
  type FamilyRole,
  type ChatRegion,
  type EmblemKey,
} from '@nw/shared';
import type { FamilyDoc, FamilyMemberDoc, FamilyJoinRequestDoc } from '../db';
import type { SocialMetaClient } from '../metaClient';
import { nullSocialMetaClient } from '../metaClient';
import type { MailService } from '../mailService';
import type { FamilyServiceDeps, FamilyDetailView, FamilyJoinRequestView } from './types';
import { docToView, makeFamilyId, withProfiles } from './shared';

export class FamilyMembershipService {
  private readonly meta: SocialMetaClient;
  private readonly mail?: MailService;

  constructor(private readonly deps: FamilyServiceDeps) {
    this.meta = deps.meta ?? nullSocialMetaClient;
    this.mail = deps.mail;
  }

  /** Create a family. TAG must be unique across the database; the creator becomes the leader; the creator must not already be in another family. */
  async createFamily(
    leaderId: string,
    name: string,
    tag: string,
    region: ChatRegion = 'global',
  ): Promise<FamilyDetailView> {
    const cols = this.deps.cols;
    const now = this.deps.now();

    const existing = await cols.familyMembers.findOne({ _id: leaderId });
    if (existing) throw new SlgError('ALREADY_IN_FAMILY');

    const tagUpper = tag.toUpperCase();
    if (!/^[A-Z0-9]{2,5}$/.test(tagUpper)) throw new SlgError('BAD_REQUEST');
    const nameWidth = name ? orgNameWidth(name) : 0;
    if (nameWidth < ORG_NAME_WIDTH_MIN || nameWidth > ORG_NAME_WIDTH_MAX) throw new SlgError('BAD_REQUEST');
    // CONTENT_MODERATION_DESIGN.md CM5: family name is long-lived/public like a display name, not
    // ephemeral chat — a hit rejects creation outright rather than persisting a masked name.
    if (censorChat(name, region, this.deps.wordlists).hit) throw new SlgError('BAD_REQUEST');

    const fid = makeFamilyId(tagUpper);

    const familyDoc: FamilyDoc = {
      _id: fid,
      name,
      tag: tagUpper,
      leaderId,
      memberCount: 1,
      prosperity: 0,
      prosperityUpdatedAt: now,
      activity: 0,
      createdAt: now,
      rev: 1,
    };
    try {
      await cols.families.insertOne(familyDoc);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new SlgError('ALREADY_IN_FAMILY');
      throw e;
    }

    const memberDoc: FamilyMemberDoc = {
      _id: leaderId,
      familyId: fid,
      accountId: leaderId,
      role: 'leader',
      joinedAt: now,
    };
    await cols.familyMembers.insertOne(memberDoc);

    return {
      ...docToView(familyDoc),
      members: await withProfiles(this.meta, [{ accountId: leaderId, role: 'leader', joinedAt: now }]),
    };
  }

  /**
   * Add membership directly (cap of 30 members; must not already be in a family). Public routes no
   * longer call this straight from a join click — see requestJoin/respondJoinRequest above; this is
   * now reached only via an accepted join request.
   */
  async joinFamily(accountId: string, familyId: string): Promise<void> {
    const cols = this.deps.cols;
    const now = this.deps.now();

    const existing = await cols.familyMembers.findOne({ _id: accountId });
    if (existing) throw new SlgError('ALREADY_IN_FAMILY');

    const res = await cols.families.findOneAndUpdate(
      { _id: familyId, memberCount: { $lt: FAMILY_CAP } },
      { $inc: { memberCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!res) {
      const fam = await cols.families.findOne({ _id: familyId });
      if (!fam) throw new SlgError('NOT_FOUND');
      throw new SlgError('FAMILY_FULL');
    }

    const memberDoc: FamilyMemberDoc = {
      _id: accountId,
      familyId,
      accountId,
      role: 'member',
      joinedAt: now,
    };
    try {
      await cols.familyMembers.insertOne(memberDoc);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        // Lost a race against a concurrent joinFamily for the SAME account (e.g. two of their pending join
        // requests, for different families, both accepted around the same time) — familyMembers._id is the
        // accountId itself, so only one insert can ever win globally. Roll back the memberCount bump this
        // attempt already committed above, so the losing family's count never drifts above its real roster
        // (2026-08-04 fix; mirrors createFamily's existing E11000 handling, plus the compensating rollback
        // createFamily doesn't need since it can't reach this point after a partial commit).
        await cols.families.updateOne({ _id: familyId }, { $inc: { memberCount: -1 } });
        throw new SlgError('ALREADY_IN_FAMILY');
      }
      throw e;
    }
  }

  /**
   * Submit a request to join a family (SS3.x join-approval). Does not add membership — a
   * leader/elder must call respondJoinRequest to accept before joinFamily actually runs.
   */
  async requestJoin(accountId: string, familyId: string): Promise<{ requestId: string }> {
    const cols = this.deps.cols;
    const now = this.deps.now();

    const existing = await cols.familyMembers.findOne({ _id: accountId });
    if (existing) throw new SlgError('ALREADY_IN_FAMILY');

    const fam = await cols.families.findOne({ _id: familyId });
    if (!fam) throw new SlgError('NOT_FOUND');
    if (fam.memberCount >= FAMILY_CAP) throw new SlgError('FAMILY_FULL');

    const pending = await cols.familyJoinRequests.findOne({ accountId, status: 'pending' });
    if (pending) throw new SlgError('ALREADY_REQUESTED');

    const requestId = randomUUID();
    const doc: FamilyJoinRequestDoc = { _id: requestId, familyId, accountId, status: 'pending', createdAt: now };
    try {
      await cols.familyJoinRequests.insertOne(doc);
    } catch (e) {
      // The findOne check above is not atomic — a concurrent requestJoin for the same account can slip
      // through between the check and this insert. The partial unique index on {accountId} (db.ts,
      // status:'pending') is the atomic backstop: the loser hits E11000 here instead of creating a second
      // pending request (2026-08-04 fix, closing the root cause behind a downstream memberCount-drift race
      // when both requests are later accepted).
      if ((e as { code?: number }).code === 11000) throw new SlgError('ALREADY_REQUESTED');
      throw e;
    }
    return { requestId };
  }

  /** List pending join requests for the caller's own family (leader/elder only). */
  async listJoinRequests(requesterId: string): Promise<FamilyJoinRequestView[]> {
    const requesterMem = await this.deps.cols.familyMembers.findOne({ _id: requesterId });
    if (!requesterMem) throw new SlgError('NOT_IN_FAMILY');
    if (requesterMem.role === 'member') throw new SlgError('NO_PERMISSION');

    const docs = await this.deps.cols.familyJoinRequests
      .find({ familyId: requesterMem.familyId, status: 'pending' })
      .sort({ createdAt: 1 })
      .toArray();
    if (docs.length === 0) return [];
    const profiles = await this.meta.batchProfiles(docs.map((d) => d.accountId));
    return docs.map((d) => {
      const p = profiles.get(d.accountId);
      return {
        requestId: d._id,
        accountId: d.accountId,
        createdAt: d.createdAt,
        ...(p ? { publicId: p.publicId, displayName: p.displayName } : {}),
      };
    });
  }

  /**
   * Approve or reject a pending join request (leader/elder only). Accept runs the same
   * cap-checked join as joinFamily; reject mails the applicant (SS3.x).
   */
  async respondJoinRequest(requesterId: string, requestId: string, accept: boolean): Promise<void> {
    const cols = this.deps.cols;
    const requesterMem = await cols.familyMembers.findOne({ _id: requesterId });
    if (!requesterMem) throw new SlgError('NOT_IN_FAMILY');
    if (requesterMem.role === 'member') throw new SlgError('NO_PERMISSION');

    const reqDoc = await cols.familyJoinRequests.findOne({ _id: requestId });
    if (!reqDoc || reqDoc.familyId !== requesterMem.familyId || reqDoc.status !== 'pending') {
      throw new SlgError('NOT_FOUND');
    }
    const now = this.deps.now();
    const claimed = await cols.familyJoinRequests.findOneAndUpdate(
      { _id: requestId, status: 'pending' },
      { $set: { status: accept ? 'accepted' : 'rejected', resolvedAt: now } },
    );
    if (!claimed) throw new SlgError('NOT_FOUND');

    if (accept) {
      await this.joinFamily(reqDoc.accountId, reqDoc.familyId);
    } else if (this.mail) {
      const fam = await cols.families.findOne({ _id: reqDoc.familyId });
      await this.mail.insertSystemMail(
        `family-join-reject:${reqDoc.familyId}:${reqDoc.accountId}:${now}`,
        reqDoc.accountId,
        {
          subject: 'family.mail.rejected.subject',
          body: `family.mail.rejected.body|familyName=${fam?.name ?? ''}`,
          expireDays: 7,
        },
      );
    }
  }

  /** Leave the family (the leader must first transfer leadership or dissolve the family). */
  async leaveFamily(accountId: string): Promise<void> {
    const cols = this.deps.cols;
    const memDoc = await cols.familyMembers.findOne({ _id: accountId });
    if (!memDoc) throw new SlgError('NOT_IN_FAMILY');
    if (memDoc.role === 'leader') throw new SlgError('BAD_REQUEST');

    const deleted = await cols.familyMembers.deleteOne({ _id: accountId });
    // Only decrement if THIS call actually removed a row — without the guard, a concurrent duplicate
    // call (e.g. a network retry of leaveFamily, or racing with kickMember on the same account) that
    // loses the deleteOne race would still unconditionally decrement, double-counting a single removal
    // and drifting memberCount below the family's actual member row count (the unsafe direction: an
    // under-count lets the family creep past FAMILY_CAP instead of just blocking joins prematurely).
    if (deleted.deletedCount > 0) {
      await cols.families.updateOne({ _id: memDoc.familyId }, { $inc: { memberCount: -1 } });
    }
  }

  /** Kick a member (leader can kick anyone; elder can only kick members). */
  async kickMember(requesterId: string, targetId: string): Promise<void> {
    if (requesterId === targetId) throw new SlgError('BAD_REQUEST');
    const cols = this.deps.cols;

    const requesterMem = await cols.familyMembers.findOne({ _id: requesterId });
    if (!requesterMem) throw new SlgError('NOT_IN_FAMILY');

    const targetMem = await cols.familyMembers.findOne({ _id: targetId });
    if (!targetMem || targetMem.familyId !== requesterMem.familyId) throw new SlgError('NOT_FOUND');
    if (targetMem.role === 'leader') throw new SlgError('NO_PERMISSION');
    if (requesterMem.role === 'elder' && targetMem.role === 'elder') throw new SlgError('NO_PERMISSION');
    if (requesterMem.role === 'member') throw new SlgError('NO_PERMISSION');

    const deleted = await cols.familyMembers.deleteOne({ _id: targetId });
    // Same guard as leaveFamily: only decrement if this call actually removed the row (protects against
    // a concurrent leaveFamily/kickMember racing on the same target double-decrementing memberCount).
    if (deleted.deletedCount > 0) {
      await cols.families.updateOne({ _id: requesterMem.familyId }, { $inc: { memberCount: -1 } });
    }
  }

  /** Set a member's role (leader only). */
  async setRole(requesterId: string, targetId: string, role: FamilyRole): Promise<void> {
    if (requesterId === targetId) throw new SlgError('BAD_REQUEST');
    if (role === 'leader') throw new SlgError('BAD_REQUEST');
    const cols = this.deps.cols;

    const requesterMem = await cols.familyMembers.findOne({ _id: requesterId });
    if (!requesterMem || requesterMem.role !== 'leader') throw new SlgError('NO_PERMISSION');

    const targetMem = await cols.familyMembers.findOne({ _id: targetId });
    if (!targetMem || targetMem.familyId !== requesterMem.familyId) throw new SlgError('NOT_FOUND');

    await cols.familyMembers.updateOne({ _id: targetId }, { $set: { role } });
  }

  /** Dissolve the family (leader only). Removes all member records, messages, and the family document. */
  async dissolveFamily(requesterId: string): Promise<void> {
    const cols = this.deps.cols;

    const requesterMem = await cols.familyMembers.findOne({ _id: requesterId });
    if (!requesterMem || requesterMem.role !== 'leader') throw new SlgError('NO_PERMISSION');

    const fid = requesterMem.familyId;
    await cols.familyMembers.deleteMany({ familyId: fid });
    await cols.familyMessages.deleteMany({ familyId: fid });
    await cols.families.deleteOne({ _id: fid });
  }

  /** Update the family announcement (leader / elder). */
  async setAnnouncement(requesterId: string, announcement: string): Promise<void> {
    if (announcement.length > 200) throw new SlgError('BAD_REQUEST');
    const mem = await this.deps.cols.familyMembers.findOne({ _id: requesterId });
    if (!mem) throw new SlgError('NOT_IN_FAMILY');
    if (mem.role === 'member') throw new SlgError('NO_PERMISSION');
    await this.deps.cols.families.updateOne({ _id: mem.familyId }, { $set: { announcement } });
  }

  /**
   * Set the family's badge (leader only — stricter than setAnnouncement's leader/elder, per the
   * 2026-08-14 product decision that emblem identity is a leader-level call, not an elder one).
   */
  async setEmblem(requesterId: string, emblemKey: EmblemKey, emblemColor: number): Promise<void> {
    if (!isEmblemKey(emblemKey)) throw new SlgError('BAD_REQUEST');
    if (!isEmblemColor(emblemColor)) throw new SlgError('BAD_REQUEST');
    const mem = await this.deps.cols.familyMembers.findOne({ _id: requesterId });
    if (!mem) throw new SlgError('NOT_IN_FAMILY');
    if (mem.role !== 'leader') throw new SlgError('NO_PERMISSION');
    await this.deps.cols.families.updateOne({ _id: mem.familyId }, { $set: { emblemKey, emblemColor } });
  }
}
