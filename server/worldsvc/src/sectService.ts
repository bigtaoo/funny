// Sect business layer facade (S8-4b, SLG_DESIGN §2.1/§8.2).
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
//
// Composed of three independent domain classes (2026-08-11 split, 独立类+组合 form,
// socialsvc/familyService.ts's sibling — the original single 491-line class had no cross-domain
// calls beyond two shared helpers, so it splits cleanly into: read-only lookups, membership
// lifecycle + alliances + leadership voting, and the chat channel) — see sect/query.ts /
// sect/membership.ts / sect/chat.ts. This class is a thin delegating facade so external callers
// (httpApi routes, this package's own tests) keep importing `SectService` from this one path with an
// unchanged public API and behavior.
import type { ChatRegion, EmblemKey } from '@nw/shared';
import type { SectServiceDeps } from './sect/types';
import { SectQueryService } from './sect/query';
import { SectMembershipService } from './sect/membership';
import { SectChatService } from './sect/chat';

export * from './sect/types';

export class SectService {
  private readonly query: SectQueryService;
  private readonly membership: SectMembershipService;
  private readonly chat: SectChatService;

  constructor(deps: SectServiceDeps) {
    this.query = new SectQueryService(deps);
    this.membership = new SectMembershipService(deps);
    this.chat = new SectChatService(deps);
  }

  // --- read-only lookups (sect/query.ts) ---
  listSects(worldId: string) {
    return this.query.listSects(worldId);
  }
  getSect(sectId: string) {
    return this.query.getSect(sectId);
  }

  // --- membership lifecycle / alliances / leadership voting (sect/membership.ts) ---
  createSect(worldId: string, requesterId: string, name: string, tag: string, clientPlatform?: string, region?: ChatRegion) {
    return this.membership.createSect(worldId, requesterId, name, tag, clientPlatform, region);
  }
  joinSect(worldId: string, requesterId: string, sectId: string) {
    return this.membership.joinSect(worldId, requesterId, sectId);
  }
  leaveSect(worldId: string, requesterId: string) {
    return this.membership.leaveSect(worldId, requesterId);
  }
  dissolveSect(worldId: string, requesterId: string) {
    return this.membership.dissolveSect(worldId, requesterId);
  }
  allySect(worldId: string, requesterId: string, targetSectId: string) {
    return this.membership.allySect(worldId, requesterId, targetSectId);
  }
  unallySect(worldId: string, requesterId: string, targetSectId: string) {
    return this.membership.unallySect(worldId, requesterId, targetSectId);
  }
  voteRemoveLeader(worldId: string, requesterId: string, nomineeFamilyId: string) {
    return this.membership.voteRemoveLeader(worldId, requesterId, nomineeFamilyId);
  }
  setEmblem(worldId: string, requesterId: string, emblemKey: EmblemKey, emblemColor: number) {
    return this.membership.setEmblem(worldId, requesterId, emblemKey, emblemColor);
  }

  // --- channel (sect/chat.ts) ---
  sendMessage(worldId: string, accountId: string, senderName: string, body: string, region?: ChatRegion) {
    return this.chat.sendMessage(worldId, accountId, senderName, body, region);
  }
  getChannel(worldId: string, accountId: string, before?: number, limit?: number) {
    return this.chat.getChannel(worldId, accountId, before, limit);
  }
}
