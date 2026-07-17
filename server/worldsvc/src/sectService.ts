// Sect business layer (S8-4b, SLG_DESIGN §2.1/§8.2).
// A sect is a faction organization within a world region, composed of families (not individuals);
// membership is at the family level, indicated by socialsvc's family.sectId mirror pointing to the sect
// (worldsvc is the authoritative writer of that mirror — see WorldSocialsvcClient.setSect and the P4-follow-up
// note above SectDoc in db.ts; family identity/roster/leader come from socialsvc, not a local mirror).
// The sect leader is the leader account of the leaderFamily.
// Most operations require the requester to be a family leader (socialsvc FamilyMembershipView.role==='leader'),
// acting on behalf of the entire family when joining/leaving a sect.
//   - Found: costs SECT_CREATE_COST coins (via commercial); the founding family becomes the leader family.
//   - Join/leave: performed by a family leader; the leader family cannot leave directly (must dissolve or go through a leadership vote).
//   - Alliance: initiated by the sect leader; bidirectionally adds to allySectIds; each side capped at ≤ SECT_ALLY_CAP.
//   - Leadership transition: family leaders vote to remove the current leader and nominate a replacement;
//     votes/families ≥ SECT_REMOVAL_VOTE_RATIO triggers the transition.
//   - Channel: sect members send/receive messages (persisted with TTL 7 days); real-time push (sect_broadcast)
//     at scale uses Redis pub/sub; this slice uses REST polling for now
//     (gatewayClient O(n) direct push is not suitable for ≤900 members, see SLG_DESIGN §9.3).
import {
  sectId as makeSectId,
  SECT_FAMILY_CAP,
  SECT_CREATE_COST,
  SECT_ALLY_CAP,
  SECT_REMOVAL_VOTE_RATIO,
  FAMILY_MSG_BODY_MAX,
  SlgError,
} from '@nw/shared';
import type { WorldCollections, SectDoc, SectMessageDoc } from './db';
import type { WorldCommercialClient } from './commercialClient';
import { nullWorldCommercialClient } from './commercialClient';
import type { WorldGatewayClient } from './gatewayClient';
import { nullWorldGatewayClient } from './gatewayClient';
import { nullWorldSocialsvcClient, type WorldSocialsvcClient, type FamilyMembership } from './socialsvcClient';
import type { WorldMetaClient } from './metaClient';
import { nullWorldMetaClient } from './metaClient';

export interface SectView {
  sectId: string;
  worldId: string;
  name: string;
  tag: string;
  leaderFamilyId: string;
  leaderId: string;
  memberFamilyCount: number;
  allySectIds: string[];
  prosperity: number;
}

export interface SectMemberFamilyView {
  familyId: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  territoryCount: number;
}

export interface SectDetailView extends SectView {
  memberFamilies: SectMemberFamilyView[];
  removalVote?: { nomineeFamilyId: string; voteCount: number; needed: number };
}

export interface SectMessageView {
  id: string;
  senderId: string;
  senderName: string;
  /** Sender's equipped title (称号), if any. */
  title?: string;
  /** Sender's sect name (宗门) — the sect itself, since this channel is sect-scoped. */
  sectName?: string;
  /** Sender's family name (家族), if any. */
  familyName?: string;
  body: string;
  ts: number; // ms since epoch
}

export interface SectServiceDeps {
  cols: WorldCollections;
  now: () => number;
  commercial?: WorldCommercialClient;
  /** Real-time channel fan-out (S8-4b); default = no gateway, REST polling only. */
  gateway?: WorldGatewayClient;
  /** socialsvc client: family identity/roster + sectId mirror writes (SOCIAL_SVC_DESIGN §5 push delegation, P4-follow-up family lookups); default = no family data available. */
  socialsvc?: WorldSocialsvcClient;
  /** meta client for publicId resolution in chat messages; default = fromPublicId left empty. */
  meta?: WorldMetaClient;
}

/** In-process monotonic sequence number to prevent message id collisions within the same millisecond. */
let msgSeq = 0;

function docToView(doc: SectDoc): SectView {
  return {
    sectId: doc._id,
    worldId: doc.worldId,
    name: doc.name,
    tag: doc.tag,
    leaderFamilyId: doc.leaderFamilyId,
    leaderId: doc.leaderId,
    memberFamilyCount: doc.memberFamilyCount,
    allySectIds: doc.allySectIds,
    prosperity: doc.prosperity,
  };
}

export class SectService {
  private readonly commercial: WorldCommercialClient;
  private readonly gateway: WorldGatewayClient;
  private readonly socialsvc: WorldSocialsvcClient;
  private readonly meta: WorldMetaClient;

  constructor(private readonly deps: SectServiceDeps) {
    this.commercial = deps.commercial ?? nullWorldCommercialClient;
    this.gateway = deps.gateway ?? nullWorldGatewayClient;
    this.socialsvc = deps.socialsvc ?? nullWorldSocialsvcClient;
    this.meta = deps.meta ?? nullWorldMetaClient;
  }

  /** Fetches the requester's family membership from socialsvc (requires them to be the family leader); throws a permission/not-in-family error otherwise. */
  private async requireFamilyLeader(accountId: string): Promise<FamilyMembership> {
    const mem = await this.socialsvc.getMember(accountId);
    if (!mem) throw new SlgError('NOT_IN_FAMILY');
    if (mem.role !== 'leader') throw new SlgError('NO_PERMISSION', 'Only the family leader can act on behalf of the family for sect operations');
    return mem;
  }

  /** Lists all sects in the world (sorted by member family count descending, capped at 50). */
  async listSects(worldId: string): Promise<SectView[]> {
    const docs = await this.deps.cols.sects
      .find({ worldId })
      .sort({ memberFamilyCount: -1 })
      .limit(50)
      .toArray();
    return docs.map(docToView);
  }

  /** Sect detail (includes member family list, sourced from socialsvc's family.sectId mirror). */
  async getSect(sectId: string): Promise<SectDetailView | null> {
    const doc = await this.deps.cols.sects.findOne({ _id: sectId });
    if (!doc) return null;
    const fams = await this.socialsvc.getFamiliesBySect(sectId);
    const memberFamilies: SectMemberFamilyView[] = fams.map((f) => ({
      familyId: f.familyId,
      name: f.name,
      tag: f.tag,
      leaderId: f.leaderId,
      memberCount: f.memberCount,
      territoryCount: f.territoryCount ?? 0,
    }));
    const view: SectDetailView = { ...docToView(doc), memberFamilies };
    if (doc.removalVote) {
      view.removalVote = {
        nomineeFamilyId: doc.removalVote.nomineeFamilyId,
        voteCount: doc.removalVote.voterFamilyIds.length,
        needed: Math.ceil(doc.memberFamilyCount * SECT_REMOVAL_VOTE_RATIO),
      };
    }
    return view;
  }

  /** Create a sect: requester must be a family leader and their family must not already belong to a sect; deducts SECT_CREATE_COST coins; TAG must be unique within the world. */
  async createSect(worldId: string, requesterId: string, name: string, tag: string): Promise<SectDetailView> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(requesterId);
    const [famSummary] = await this.socialsvc.getFamiliesByIds([fam.familyId]);
    if (famSummary?.sectId) throw new SlgError('ALREADY_IN_SECT');

    const tagUpper = tag.toUpperCase();
    if (!/^[A-Z0-9]{2,5}$/.test(tagUpper)) throw new SlgError('BAD_REQUEST', 'Tag must be 2–5 uppercase alphanumeric characters');
    if (!name || name.length < 2 || name.length > 20) throw new SlgError('BAD_REQUEST', 'Name must be 2–20 characters');

    const sid = makeSectId(worldId, tagUpper);

    // Deduct coins first (founding cost). Failure → throws INSUFFICIENT_FUNDS (mapped by commercial); nothing is written to the DB.
    const orderId = `sect_create:${sid}:${this.deps.now()}`;
    await this.commercial.spend(requesterId, SECT_CREATE_COST, orderId);

    const doc: SectDoc = {
      _id: sid,
      worldId,
      name,
      tag: tagUpper,
      leaderFamilyId: fam.familyId,
      leaderId: requesterId,
      memberFamilyCount: 1,
      allySectIds: [],
      prosperity: 0,
      rev: 1,
    };
    try {
      await cols.sects.insertOne(doc);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        // TAG key collision: refund (best-effort) and throw already-taken error.
        await this.commercial.grant(requesterId, SECT_CREATE_COST, `${orderId}:refund`);
        throw new SlgError('ALREADY_IN_SECT', 'Tag is already taken');
      }
      throw e;
    }
    await this.socialsvc.setSect(fam.familyId, sid);

    return { ...docToView(doc), memberFamilies: [{
      familyId: fam.familyId, name: fam.name, tag: fam.tag, leaderId: fam.leaderId,
      memberCount: fam.memberCount, territoryCount: 0,
    }] };
  }

  /** Family joins a sect (family leader operation; capped at SECT_FAMILY_CAP families; family must not already be in a sect). */
  async joinSect(worldId: string, requesterId: string, sectId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(requesterId);
    const [famSummary] = await this.socialsvc.getFamiliesByIds([fam.familyId]);
    if (famSummary?.sectId) throw new SlgError('ALREADY_IN_SECT');

    // Atomic $inc with capacity guard.
    const res = await cols.sects.findOneAndUpdate(
      { _id: sectId, worldId, memberFamilyCount: { $lt: SECT_FAMILY_CAP } },
      { $inc: { memberFamilyCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!res) {
      const exists = await cols.sects.findOne({ _id: sectId });
      if (!exists) throw new SlgError('NOT_FOUND', 'Sect not found');
      throw new SlgError('SECT_FULL');
    }
    await this.socialsvc.setSect(fam.familyId, sectId);
  }

  /** Family leaves a sect (family leader operation). The leader family cannot leave directly — must dissolve the sect or go through a leadership vote first. */
  async leaveSect(worldId: string, requesterId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(requesterId);
    const [famSummary] = await this.socialsvc.getFamiliesByIds([fam.familyId]);
    if (!famSummary?.sectId) throw new SlgError('NOT_IN_SECT');
    const sect = await cols.sects.findOne({ _id: famSummary.sectId });
    if (sect && sect.leaderFamilyId === fam.familyId) {
      throw new SlgError('BAD_REQUEST', 'The leader family must dissolve the sect or transfer leadership first');
    }
    await this.socialsvc.setSect(fam.familyId, null);
    await cols.sects.updateOne({ _id: famSummary.sectId }, { $inc: { memberFamilyCount: -1 } });
  }

  /** Dissolve the sect (sect leader only). Clears sectId on all member families, removes all alliances bidirectionally, deletes the sect and its channel. */
  async dissolveSect(worldId: string, requesterId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(requesterId);
    const [famSummary] = await this.socialsvc.getFamiliesByIds([fam.familyId]);
    if (!famSummary?.sectId) throw new SlgError('NOT_IN_SECT');
    const sect = await cols.sects.findOne({ _id: famSummary.sectId });
    if (!sect) throw new SlgError('NOT_FOUND');
    if (sect.leaderId !== requesterId) throw new SlgError('NO_PERMISSION', 'Only the sect leader can dissolve the sect');

    const sid = sect._id;
    const memberFams = await this.socialsvc.getFamiliesBySect(sid);
    await Promise.all(memberFams.map((f) => this.socialsvc.setSect(f.familyId, null)));
    // Remove this sect from all allies' allySectIds.
    for (const ally of sect.allySectIds) {
      await cols.sects.updateOne({ _id: ally }, { $pull: { allySectIds: sid } });
    }
    await cols.sectMessages.deleteMany({ sectId: sid });
    await cols.sects.deleteOne({ _id: sid });
  }

  /** Form an alliance (initiated by the sect leader; bidirectional). Each side capped at ≤ SECT_ALLY_CAP; cannot ally with self or an already-allied sect. */
  async allySect(worldId: string, requesterId: string, targetSectId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(requesterId);
    const [famSummary] = await this.socialsvc.getFamiliesByIds([fam.familyId]);
    if (!famSummary?.sectId) throw new SlgError('NOT_IN_SECT');
    const self = await cols.sects.findOne({ _id: famSummary.sectId });
    if (!self) throw new SlgError('NOT_FOUND');
    if (self.leaderId !== requesterId) throw new SlgError('NO_PERMISSION', 'Only the sect leader can form alliances');
    if (targetSectId === self._id) throw new SlgError('BAD_REQUEST', 'Cannot ally with your own sect');

    const target = await cols.sects.findOne({ _id: targetSectId, worldId });
    if (!target) throw new SlgError('NOT_FOUND', 'Target sect not found');
    if (self.allySectIds.includes(targetSectId)) return; // idempotent: already allied
    if (self.allySectIds.length >= SECT_ALLY_CAP || target.allySectIds.length >= SECT_ALLY_CAP) {
      throw new SlgError('ALLY_CAP_REACHED');
    }
    await cols.sects.updateOne({ _id: self._id }, { $addToSet: { allySectIds: targetSectId } });
    await cols.sects.updateOne({ _id: target._id }, { $addToSet: { allySectIds: self._id } });
  }

  /** Dissolve an alliance (initiated by the sect leader; bidirectionally removes the alliance). */
  async unallySect(worldId: string, requesterId: string, targetSectId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(requesterId);
    const [famSummary] = await this.socialsvc.getFamiliesByIds([fam.familyId]);
    if (!famSummary?.sectId) throw new SlgError('NOT_IN_SECT');
    const self = await cols.sects.findOne({ _id: famSummary.sectId });
    if (!self) throw new SlgError('NOT_FOUND');
    if (self.leaderId !== requesterId) throw new SlgError('NO_PERMISSION', 'Only the sect leader can dissolve alliances');
    await cols.sects.updateOne({ _id: self._id }, { $pull: { allySectIds: targetSectId } });
    await cols.sects.updateOne({ _id: targetSectId }, { $pull: { allySectIds: self._id } });
  }

  /**
   * Vote to remove the sect leader (initiated by a family leader, nominating a replacement family).
   * Votes for the same nominee accumulate (deduplicated by family); votes ≥ ceil(familyCount × 2/3) → leadership transfers to the nominee.
   * Changing the nominee resets the vote count to just the current voter.
   * Returns { passed, voteCount, needed }.
   */
  async voteRemoveLeader(
    worldId: string,
    requesterId: string,
    nomineeFamilyId: string,
  ): Promise<{ passed: boolean; voteCount: number; needed: number }> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(requesterId);
    const [famSummary] = await this.socialsvc.getFamiliesByIds([fam.familyId]);
    if (!famSummary?.sectId) throw new SlgError('NOT_IN_SECT');
    const sect = await cols.sects.findOne({ _id: famSummary.sectId });
    if (!sect) throw new SlgError('NOT_FOUND');

    const [nominee] = await this.socialsvc.getFamiliesByIds([nomineeFamilyId]);
    if (!nominee || nominee.sectId !== sect._id) throw new SlgError('NOT_FOUND', 'Nominated family is not in this sect');

    // Accumulate or reset votes (keyed by nominee).
    let voters: string[];
    if (sect.removalVote && sect.removalVote.nomineeFamilyId === nomineeFamilyId) {
      voters = sect.removalVote.voterFamilyIds.includes(fam.familyId)
        ? sect.removalVote.voterFamilyIds
        : [...sect.removalVote.voterFamilyIds, fam.familyId];
    } else {
      voters = [fam.familyId]; // nominee changed → reset
    }

    const needed = Math.ceil(sect.memberFamilyCount * SECT_REMOVAL_VOTE_RATIO);
    if (voters.length >= needed) {
      // Leadership transition: transfer leader family and leader account to the nominee family.
      await cols.sects.updateOne(
        { _id: sect._id },
        {
          $set: { leaderFamilyId: nominee.familyId, leaderId: nominee.leaderId },
          $unset: { removalVote: '' },
          $inc: { rev: 1 },
        },
      );
      return { passed: true, voteCount: voters.length, needed };
    }
    await cols.sects.updateOne(
      { _id: sect._id },
      { $set: { removalVote: { nomineeFamilyId, voterFamilyIds: voters } } },
    );
    return { passed: false, voteCount: voters.length, needed };
  }

  /**
   * Send a sect channel message (any member may send; persisted + real-time push).
   * After writing to the DB, the message is fan-out to other online sect members via Redis pub/sub
   * (≤900 members; worldsvc publishes a single message to GW_PUSH_REDIS_CHANNEL; each gateway delivers
   * it to online members on that node; no Redis → gateway client falls back to O(n) HTTP push).
   * Offline members retrieve history via REST polling (TTL 7 days).
   */
  async sendMessage(
    worldId: string,
    accountId: string,
    senderName: string,
    body: string,
  ): Promise<SectMessageView> {
    const { cols } = this.deps;
    const mem = await this.socialsvc.getMember(accountId);
    if (!mem) throw new SlgError('NOT_IN_SECT');
    const [famSummary] = await this.socialsvc.getFamiliesByIds([mem.familyId]);
    if (!famSummary?.sectId) throw new SlgError('NOT_IN_SECT');
    if (!body || body.length > FAMILY_MSG_BODY_MAX) throw new SlgError('BAD_REQUEST');

    const sectId = famSummary.sectId;
    const ts = this.deps.now();
    const seq = ++msgSeq;
    const msgId = `sm:${sectId}:${ts}:${seq}`;

    // Resolve display name + title from meta (source of truth for renames); best-effort, falls back
    // to the client-supplied senderName if meta is unavailable or profile not found — a stale/incorrect
    // client-side cache must never be preferred over the account's real name.
    const profile = this.meta.available ? await this.meta.getProfile(accountId).catch(() => null) : null;
    const resolvedSenderName = profile?.displayName ?? senderName;
    const title = profile?.equippedTitle;
    // Family + sect name are already resolved above (mem.name / the sect this channel belongs to) — no extra lookups.
    const familyName = mem.name;
    const sectDoc = await cols.sects.findOne({ _id: sectId });
    const sectDocName = sectDoc?.name;

    const msgDoc: SectMessageDoc = {
      _id: msgId,
      worldId,
      sectId,
      senderId: accountId,
      senderName: resolvedSenderName,
      ...(title ? { title } : {}),
      ...(sectDocName ? { sectName: sectDocName } : {}),
      ...(familyName ? { familyName } : {}),
      body,
      ts: new Date(ts),
    };
    await cols.sectMessages.insertOne(msgDoc);

    // Push: prefer delegating to socialsvc (the push hub, §5); fall back to direct gateway push when socialsvc is unavailable.
    const payload = { sectId, fromPublicId: profile?.publicId ?? '', fromName: resolvedSenderName, title, sectName: sectDocName, familyName, body, ts };
    if (this.socialsvc.available) {
      const recipients = await this.sectMemberAccountIds(worldId, sectId, accountId);
      void this.socialsvc.push({ kind: 'sect', sectId }, 'sect_msg', payload, recipients);
    } else {
      const recipients = await this.sectMemberAccountIds(worldId, sectId, accountId);
      void this.gateway.broadcast(recipients, { kind: 'sect_msg', ...payload });
    }

    return { id: msgId, senderId: accountId, senderName: resolvedSenderName, title, sectName: sectDocName, familyName, body, ts };
  }

  /** Collects all member accountIds within the sect who are joined to this world (spread across member families, via PlayerWorldDoc.familyId); optionally excludes one account (e.g., the sender). */
  private async sectMemberAccountIds(worldId: string, sectId: string, exclude?: string): Promise<string[]> {
    const fams = await this.socialsvc.getFamiliesBySect(sectId);
    const famIds = fams.map((f) => f.familyId);
    if (famIds.length === 0) return [];
    const members = await this.deps.cols.playerWorld
      .find({ worldId, familyId: { $in: famIds } })
      .project<{ accountId: string }>({ accountId: 1 })
      .toArray();
    const ids = members.map((m) => m.accountId).filter((id) => id !== exclude);
    // Deduplicate (in theory each accountId belongs to only one family, but deduplicate for safety).
    return [...new Set(ids)];
  }

  /** Retrieve sect channel history (readable by any member; paginated in reverse chronological order). */
  async getChannel(
    worldId: string,
    accountId: string,
    before?: number,
    limit = 30,
  ): Promise<SectMessageView[]> {
    const { cols } = this.deps;
    const mem = await this.socialsvc.getMember(accountId);
    if (!mem) throw new SlgError('NOT_IN_SECT');
    const [famSummary] = await this.socialsvc.getFamiliesByIds([mem.familyId]);
    if (!famSummary?.sectId) throw new SlgError('NOT_IN_SECT');

    const realLimit = Math.min(Math.max(limit, 1), 50);
    const query: Record<string, unknown> = { sectId: famSummary.sectId };
    if (before != null) query['ts'] = { $lt: new Date(before) };

    const docs = await cols.sectMessages.find(query).sort({ ts: -1 }).limit(realLimit).toArray();
    return docs.map((d) => ({
      id: d._id,
      senderId: d.senderId,
      senderName: d.senderName,
      title: d.title,
      sectName: d.sectName,
      familyName: d.familyName,
      body: d.body,
      ts: d.ts instanceof Date ? d.ts.getTime() : (d.ts as unknown as number),
    }));
  }
}
