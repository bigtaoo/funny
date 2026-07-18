// Family business layer (SOCIAL_SVC_DESIGN §3/§4, SS2/SS3).
// A family is a globally persistent entity (no worldId); TAG is unique across the entire database.
// A player can belong to at most one family at a time (FamilyMemberDoc._id = accountId).
// Member cap FAMILY_CAP=30; three permission tiers: leader > elder > member.
import {
  FAMILY_CAP,
  FAMILY_MSG_BODY_MAX,
  ORG_NAME_WIDTH_MIN,
  ORG_NAME_WIDTH_MAX,
  orgNameWidth,
  SlgError,
  familyProsperity,
  type FamilyRole,
} from '@nw/shared';
import type { SocialCollections, FamilyDoc, FamilyMemberDoc, FamilyMessageDoc } from './db';
import type { SocialGatewayClient } from './gatewayClient';
import { nullSocialGatewayClient } from './gatewayClient';
import type { SocialMetaClient } from './metaClient';
import { nullSocialMetaClient } from './metaClient';

export interface FamilyView {
  familyId: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  prosperity: number;
  /** Prosperity decay anchor ms (needed by worldsvc to lazily decay sect-aggregate prosperity on read; SLG_DESIGN §17.4). */
  prosperityUpdatedAt?: number;
  /** Territory tile count (worldsvc-owned mirror). */
  territoryCount?: number;
  /** Sect the family currently belongs to (worldsvc-owned mirror; absent = independent family). */
  sectId?: string;
  announcement?: string;
}

/** Membership + family identity in one round trip (internal API, called by worldsvc's requireFamilyLeader). */
export interface FamilyMembershipView {
  familyId: string;
  role: FamilyRole;
  leaderId: string;
  name: string;
  tag: string;
  memberCount: number;
}

export interface FamilyDetailView extends FamilyView {
  members: FamilyMemberView[];
}

export interface FamilyMemberView {
  accountId: string;
  role: FamilyRole;
  joinedAt: number;
  /** Resolved via SocialMetaClient.batchProfiles; omitted if metaserver lookup is unavailable or the profile is gone. */
  publicId?: string;
  displayName?: string;
}

export interface FamilyMessageView {
  id: string;
  senderId: string;
  senderName: string;
  /** Sender's equipped title (称号), if any. */
  title?: string;
  /** Sender's family name (家族) — the family itself, since this channel is family-scoped. */
  familyName?: string;
  body: string;
  ts: number;
}

export interface FamilyServiceDeps {
  cols: SocialCollections;
  now: () => number;
  gateway?: SocialGatewayClient;
  meta?: SocialMetaClient;
}

/** In-process monotonic sequence number to prevent message ID collisions within the same millisecond. */
let msgSeq = 0;

function makeFamilyId(tag: string): string {
  return `fam:${tag.toUpperCase()}`;
}

function docToView(doc: FamilyDoc): FamilyView {
  return {
    familyId: doc._id,
    name: doc.name,
    tag: doc.tag,
    leaderId: doc.leaderId,
    memberCount: doc.memberCount,
    prosperity: doc.prosperity,
    prosperityUpdatedAt: doc.prosperityUpdatedAt,
    ...(doc.territoryCount != null ? { territoryCount: doc.territoryCount } : {}),
    ...(doc.sectId ? { sectId: doc.sectId } : {}),
    ...(doc.announcement ? { announcement: doc.announcement } : {}),
  };
}

export class FamilyService {
  private readonly gateway: SocialGatewayClient;
  private readonly meta: SocialMetaClient;

  constructor(private readonly deps: FamilyServiceDeps) {
    this.gateway = deps.gateway ?? nullSocialGatewayClient;
    this.meta = deps.meta ?? nullSocialMetaClient;
  }

  /** Attach resolved publicId/displayName to each member (best-effort; missing profiles are left unresolved). */
  private async withProfiles(members: FamilyMemberView[]): Promise<FamilyMemberView[]> {
    const profiles = await this.meta.batchProfiles(members.map((m) => m.accountId));
    return members.map((m) => {
      const p = profiles.get(m.accountId);
      return p ? { ...m, publicId: p.publicId, displayName: p.displayName } : m;
    });
  }

  /** Get the family the player belongs to (including member list). Returns null if not a member. */
  async getMyFamily(accountId: string): Promise<FamilyDetailView | null> {
    const mem = await this.deps.cols.familyMembers.findOne({ _id: accountId });
    if (!mem) return null;
    return this.getFamily(mem.familyId);
  }

  /** Get family details by familyId (including member list). */
  async getFamily(familyId: string): Promise<FamilyDetailView | null> {
    const doc = await this.deps.cols.families.findOne({ _id: familyId });
    if (!doc) return null;
    const memberDocs = await this.deps.cols.familyMembers.find({ familyId }).toArray();
    const members = await this.withProfiles(memberDocs.map((m) => ({
      accountId: m.accountId,
      role: m.role,
      joinedAt: m.joinedAt,
    })));
    return { ...docToView(doc), members };
  }

  /** Search for a family by TAG (exact match, case-insensitive). */
  async searchByTag(tag: string): Promise<FamilyView | null> {
    const doc = await this.deps.cols.families.findOne({ tag: tag.toUpperCase() });
    return doc ? docToView(doc) : null;
  }

  /**
   * Browse joinable families (join-picker source): families with an open slot, fuzzy-matched by
   * name when `query` is given, sorted by prosperity desc (default view = top-N most prosperous).
   */
  async browseFamilies(query: string | undefined, limit = 10): Promise<FamilyView[]> {
    const filter: Record<string, unknown> = { memberCount: { $lt: FAMILY_CAP } };
    const trimmed = query?.trim();
    if (trimmed) {
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.name = { $regex: escaped, $options: 'i' };
    }
    const docs = await this.deps.cols.families
      .find(filter)
      .sort({ prosperity: -1 })
      .limit(Math.min(Math.max(limit, 1), 50))
      .toArray();
    return docs.map(docToView);
  }

  /** Create a family. TAG must be unique across the database; the creator becomes the leader; the creator must not already be in another family. */
  async createFamily(
    leaderId: string,
    name: string,
    tag: string,
  ): Promise<FamilyDetailView> {
    const cols = this.deps.cols;
    const now = this.deps.now();

    const existing = await cols.familyMembers.findOne({ _id: leaderId });
    if (existing) throw new SlgError('ALREADY_IN_FAMILY');

    const tagUpper = tag.toUpperCase();
    if (!/^[A-Z0-9]{2,5}$/.test(tagUpper)) throw new SlgError('BAD_REQUEST');
    const nameWidth = name ? orgNameWidth(name) : 0;
    if (nameWidth < ORG_NAME_WIDTH_MIN || nameWidth > ORG_NAME_WIDTH_MAX) throw new SlgError('BAD_REQUEST');

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
      members: await this.withProfiles([{ accountId: leaderId, role: 'leader', joinedAt: now }]),
    };
  }

  /** Join a family (direct join; cap of 30 members; must not already be in a family). */
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
    await cols.familyMembers.insertOne(memberDoc);
  }

  /** Leave the family (the leader must first transfer leadership or dissolve the family). */
  async leaveFamily(accountId: string): Promise<void> {
    const cols = this.deps.cols;
    const memDoc = await cols.familyMembers.findOne({ _id: accountId });
    if (!memDoc) throw new SlgError('NOT_IN_FAMILY');
    if (memDoc.role === 'leader') throw new SlgError('BAD_REQUEST');

    await cols.familyMembers.deleteOne({ _id: accountId });
    await cols.families.updateOne({ _id: memDoc.familyId }, { $inc: { memberCount: -1 } });
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

    await cols.familyMembers.deleteOne({ _id: targetId });
    await cols.families.updateOne({ _id: requesterMem.familyId }, { $inc: { memberCount: -1 } });
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

  /** Send a message to the family channel. Pushes in real time to all other online members. */
  async sendMessage(
    accountId: string,
    senderName: string,
    body: string,
  ): Promise<FamilyMessageView> {
    const cols = this.deps.cols;

    const mem = await cols.familyMembers.findOne({ _id: accountId });
    if (!mem) throw new SlgError('NOT_IN_FAMILY');
    if (!body || body.length > FAMILY_MSG_BODY_MAX) throw new SlgError('BAD_REQUEST');

    const ts = this.deps.now();
    const seq = ++msgSeq;
    const msgId = `fm:${mem.familyId}:${ts}:${seq}`;

    // Resolve display name + title from meta (source of truth for renames); best-effort, falls back
    // to the client-supplied senderName if meta is unavailable or profile not found — a stale/incorrect
    // client-side cache must never be preferred over the account's real name.
    const profiles = this.meta.available ? await this.meta.batchProfiles([accountId]) : new Map();
    const resolvedSenderName = profiles.get(accountId)?.displayName ?? senderName;
    const title = profiles.get(accountId)?.equippedTitle;
    const familyDoc = await cols.families.findOne({ _id: mem.familyId });
    const familyName = familyDoc?.name;

    const msgDoc: FamilyMessageDoc = {
      _id: msgId,
      familyId: mem.familyId,
      senderId: accountId,
      senderName: resolvedSenderName,
      ...(title ? { title } : {}),
      ...(familyName ? { familyName } : {}),
      body,
      ts: new Date(ts),
    };
    await cols.familyMessages.insertOne(msgDoc);

    // Push to all other members (O(n), ≤30 members)
    const otherMembers = await cols.familyMembers
      .find({ familyId: mem.familyId, _id: { $ne: accountId } })
      .toArray();
    await this.gateway.pushMany(
      otherMembers.map((m) => m.accountId),
      { kind: 'family_msg', familyId: mem.familyId, fromAccountId: accountId, fromName: resolvedSenderName, title, familyName, body, ts },
    );

    return { id: msgId, senderId: accountId, senderName: resolvedSenderName, title, familyName, body, ts };
  }

  /** Get channel history (reverse-chronological pagination; `before` is a ms-epoch cursor; limit ≤50). */
  async getChannel(
    accountId: string,
    before?: number,
    limit = 30,
  ): Promise<FamilyMessageView[]> {
    const cols = this.deps.cols;

    const mem = await cols.familyMembers.findOne({ _id: accountId });
    if (!mem) throw new SlgError('NOT_IN_FAMILY');

    const realLimit = Math.min(Math.max(limit, 1), 50);
    const query: Record<string, unknown> = { familyId: mem.familyId };
    if (before != null) query['ts'] = { $lt: new Date(before) };

    const docs = await cols.familyMessages
      .find(query)
      .sort({ ts: -1 })
      .limit(realLimit)
      .toArray();

    return docs.map((d) => ({
      id: d._id,
      senderId: d.senderId,
      senderName: d.senderName,
      title: d.title,
      familyName: d.familyName,
      body: d.body,
      ts: d.ts instanceof Date ? d.ts.getTime() : (d.ts as unknown as number),
    }));
  }

  /** Internal API: look up the familyId the player currently belongs to (called by worldsvc). */
  async getFamilyIdByAccount(accountId: string): Promise<string | null> {
    const mem = await this.deps.cols.familyMembers.findOne({ _id: accountId });
    return mem ? mem.familyId : null;
  }

  /** Internal API: called by worldsvc to increment activity (occupation / battle +1). */
  async bumpActivity(familyId: string, delta = 1): Promise<void> {
    await this.deps.cols.families.updateOne(
      { _id: familyId },
      { $inc: { activity: delta } },
    );
  }

  /** Internal API: membership + family identity in one round trip (called by worldsvc's sect permission checks). Returns null if not in a family. */
  async getMember(accountId: string): Promise<FamilyMembershipView | null> {
    const mem = await this.deps.cols.familyMembers.findOne({ _id: accountId });
    if (!mem) return null;
    const fam = await this.deps.cols.families.findOne({ _id: mem.familyId });
    if (!fam) return null;
    return { familyId: mem.familyId, role: mem.role, leaderId: fam.leaderId, name: fam.name, tag: fam.tag, memberCount: fam.memberCount };
  }

  /** Internal API: batch fetch families by id (called by worldsvc for sect roster display / season settlement). Missing ids are silently skipped. */
  async getFamiliesByIds(familyIds: string[]): Promise<FamilyView[]> {
    if (familyIds.length === 0) return [];
    const docs = await this.deps.cols.families.find({ _id: { $in: familyIds } }).toArray();
    return docs.map(docToView);
  }

  /** Internal API: all families currently pointing at the given sectId (called by worldsvc sect roster / leave-vote flows). */
  async getFamiliesBySect(sectId: string): Promise<FamilyView[]> {
    const docs = await this.deps.cols.families.find({ sectId }).toArray();
    return docs.map(docToView);
  }

  /** Internal API: set/clear the sect a family belongs to (called by worldsvc on sect join/leave/found/dissolve; worldsvc is authoritative, this is a read cache for clients). */
  async setSect(familyId: string, sectId: string | null): Promise<void> {
    await this.deps.cols.families.updateOne(
      { _id: familyId },
      sectId ? { $set: { sectId } } : { $unset: { sectId: '' } },
    );
  }

  /**
   * Internal API: recompute + persist prosperity from a worldsvc-supplied territoryCount (worldsvc owns tile
   * ownership; socialsvc owns the family doc). Called at explicit refresh points (occupation / siege / sect-founding / settle),
   * mirroring the pre-P4 worldsvc-local refreshFamilyProsperity semantics. Family not found → returns 0 without writing.
   */
  async refreshProsperity(familyId: string, territoryCount: number): Promise<number> {
    const fam = await this.deps.cols.families.findOne({ _id: familyId });
    if (!fam) return 0;
    const prosperity = familyProsperity(territoryCount, fam.memberCount, fam.activity ?? 0);
    await this.deps.cols.families.updateOne(
      { _id: familyId },
      { $set: { prosperity, prosperityUpdatedAt: this.deps.now(), territoryCount } },
    );
    return prosperity;
  }

  /** Internal API: zero all SLG season state (territory/prosperity/activity/sect) on world reset (SLG_DESIGN §17.3); family identity/membership is untouched. */
  async resetSlgState(familyId: string): Promise<void> {
    await this.deps.cols.families.updateOne(
      { _id: familyId },
      { $set: { territoryCount: 0, prosperity: 0, activity: 0, prosperityUpdatedAt: this.deps.now() }, $unset: { sectId: '' } },
    );
  }
}
