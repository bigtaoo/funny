// Sect business layer — membership lifecycle (found/join/leave/dissolve), alliances, and leadership
// voting (S8-4b, SLG_DESIGN §2.1/§8.2). Split out of sectService.ts (2026-08-11, 独立类+组合 form,
// familyService.ts's sibling — see ../sectService.ts for the composing facade). Zero cross-domain
// calls into query.ts/chat.ts.
import {
  sectId as makeSectId,
  SECT_FAMILY_CAP,
  SECT_CREATE_COST,
  SECT_ALLY_CAP,
  SECT_REMOVAL_VOTE_RATIO,
  ORG_NAME_WIDTH_MIN,
  ORG_NAME_WIDTH_MAX,
  orgNameWidth,
  SlgError,
  censorChat,
  type ChatRegion,
} from '@nw/shared';
import type { SectDoc } from '../db';
import { nullWorldCommercialClient, type WorldCommercialClient } from '../commercialClient';
import { nullWorldSocialsvcClient, type WorldSocialsvcClient, type FamilyMembership } from '../socialsvcClient';
import { docToView } from './shared';
import type { SectDetailView, SectServiceDeps } from './types';

export class SectMembershipService {
  private readonly commercial: WorldCommercialClient;
  private readonly socialsvc: WorldSocialsvcClient;

  constructor(private readonly deps: SectServiceDeps) {
    this.commercial = deps.commercial ?? nullWorldCommercialClient;
    this.socialsvc = deps.socialsvc ?? nullWorldSocialsvcClient;
  }

  /** Fetches the requester's family membership from socialsvc (requires them to be the family leader); throws a permission/not-in-family error otherwise. */
  private async requireFamilyLeader(accountId: string): Promise<FamilyMembership> {
    const mem = await this.socialsvc.getMember(accountId);
    if (!mem) throw new SlgError('NOT_IN_FAMILY');
    if (mem.role !== 'leader') throw new SlgError('NO_PERMISSION', 'Only the family leader can act on behalf of the family for sect operations');
    return mem;
  }

  /** Create a sect: requester must be a family leader and their family must not already belong to a sect; deducts SECT_CREATE_COST coins; TAG must be unique within the world. */
  async createSect(
    worldId: string,
    requesterId: string,
    name: string,
    tag: string,
    clientPlatform?: string,
    region: ChatRegion = 'global',
  ): Promise<SectDetailView> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(requesterId);
    if (fam.sectId) throw new SlgError('ALREADY_IN_SECT');

    const tagUpper = tag.toUpperCase();
    if (!/^[A-Z0-9]{2,5}$/.test(tagUpper)) throw new SlgError('BAD_REQUEST', 'Tag must be 2–5 uppercase alphanumeric characters');
    const nameWidth = name ? orgNameWidth(name) : 0;
    if (nameWidth < ORG_NAME_WIDTH_MIN || nameWidth > ORG_NAME_WIDTH_MAX) {
      throw new SlgError('BAD_REQUEST', 'Name must be 2–12 display units (full-width chars count as 2)');
    }
    // CONTENT_MODERATION_DESIGN.md CM5: sect name is long-lived/public like a display name, not
    // ephemeral chat — a hit rejects creation outright rather than persisting a masked name.
    if (censorChat(name, region, this.deps.wordlists).hit) {
      throw new SlgError('BAD_REQUEST', 'Name contains disallowed words');
    }

    const sid = makeSectId(worldId, tagUpper);

    // Deduct coins first (founding cost). Failure → throws INSUFFICIENT_FUNDS (mapped by commercial); nothing is written to the DB.
    const orderId = `sect_create:${sid}:${this.deps.now()}`;
    await this.commercial.spend(requesterId, SECT_CREATE_COST, orderId, clientPlatform);

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
    await this.socialsvc.setSect(fam.familyId, sid, name);

    return { ...docToView(doc), memberFamilies: [{
      familyId: fam.familyId, name: fam.name, tag: fam.tag, leaderId: fam.leaderId,
      memberCount: fam.memberCount, territoryCount: 0,
    }] };
  }

  /** Family joins a sect (family leader operation; capped at SECT_FAMILY_CAP families; family must not already be in a sect). */
  async joinSect(worldId: string, requesterId: string, sectId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(requesterId);
    if (fam.sectId) throw new SlgError('ALREADY_IN_SECT');

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
    await this.socialsvc.setSect(fam.familyId, sectId, res.name);
  }

  /** Family leaves a sect (family leader operation). The leader family cannot leave directly — must dissolve the sect or go through a leadership vote first. */
  async leaveSect(worldId: string, requesterId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(requesterId);
    if (!fam.sectId) throw new SlgError('NOT_IN_SECT');
    const sect = await cols.sects.findOne({ _id: fam.sectId });
    if (sect && sect.leaderFamilyId === fam.familyId) {
      throw new SlgError('BAD_REQUEST', 'The leader family must dissolve the sect or transfer leadership first');
    }
    await this.socialsvc.setSect(fam.familyId, null);
    await cols.sects.updateOne({ _id: fam.sectId }, { $inc: { memberFamilyCount: -1 } });
  }

  /** Dissolve the sect (sect leader only). Clears sectId on all member families, removes all alliances bidirectionally, deletes the sect and its channel. */
  async dissolveSect(worldId: string, requesterId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(requesterId);
    if (!fam.sectId) throw new SlgError('NOT_IN_SECT');
    const sect = await cols.sects.findOne({ _id: fam.sectId });
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
    if (!fam.sectId) throw new SlgError('NOT_IN_SECT');
    const self = await cols.sects.findOne({ _id: fam.sectId });
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
    if (!fam.sectId) throw new SlgError('NOT_IN_SECT');
    const self = await cols.sects.findOne({ _id: fam.sectId });
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
    if (!fam.sectId) throw new SlgError('NOT_IN_SECT');

    // Nominee's family is not the requester's — this lookup is genuinely a different family (not
    // eliminable by getMember, comm-audit batch F item 8's remaining exception). Resolved once outside
    // the retry loop below since it doesn't depend on the sect doc's current revision.
    const [nominee] = await this.socialsvc.getFamiliesByIds([nomineeFamilyId]);

    // 2026-08-03 (worldsvc code review): two family leaders voting concurrently both used to read the
    // same `sect.removalVote.voterFamilyIds`, each append their own family to a locally-computed copy,
    // and whichever `updateOne` landed last would silently overwrite the other's vote (lost update) —
    // rev-guarded now, with a bounded refetch+retry so a losing writer's vote isn't just dropped.
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const sect = await cols.sects.findOne({ _id: fam.sectId });
      if (!sect) throw new SlgError('NOT_FOUND');
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
        const result = await cols.sects.updateOne(
          { _id: sect._id, rev: sect.rev },
          {
            $set: { leaderFamilyId: nominee.familyId, leaderId: nominee.leaderId },
            $unset: { removalVote: '' },
            $inc: { rev: 1 },
          },
        );
        if (result.matchedCount > 0) return { passed: true, voteCount: voters.length, needed };
      } else {
        const result = await cols.sects.updateOne(
          { _id: sect._id, rev: sect.rev },
          { $set: { removalVote: { nomineeFamilyId, voterFamilyIds: voters } }, $inc: { rev: 1 } },
        );
        if (result.matchedCount > 0) return { passed: false, voteCount: voters.length, needed };
      }
      if (attempt === MAX_ATTEMPTS - 1) throw new SlgError('REV_CONFLICT', 'Concurrent vote, please retry');
    }
    throw new SlgError('REV_CONFLICT', 'Concurrent vote, please retry');
  }
}
