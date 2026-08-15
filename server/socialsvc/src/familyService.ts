// Family business layer facade (SOCIAL_SVC_DESIGN §3/§4, SS2/SS3). A family is a globally persistent
// entity (no worldId); TAG is unique across the entire database. A player can belong to at most one
// family at a time (FamilyMemberDoc._id = accountId). Member cap FAMILY_CAP=30; three permission
// tiers: leader > elder > member.
//
// Composed of four independent domain classes (2026-08-10 split, 独立类+组合 form — the original
// single 666-line class had no natural mixin peer edges, so it splits cleanly into: read-only
// lookups, membership lifecycle, the chat channel, and worldsvc's internal API) — see family/query.ts
// / family/membership.ts / family/chat.ts / family/internal.ts. This class is a thin delegating
// facade so external callers (httpApi routes, this package's own tests) keep importing `FamilyService`
// from this one path with an unchanged public API and behavior.
import type { FamilyRole, ChatRegion, EmblemKey } from '@nw/shared';
import type { FamilyServiceDeps } from './family/types';
import { FamilyQueryService } from './family/query';
import { FamilyMembershipService } from './family/membership';
import { FamilyChatService } from './family/chat';
import { FamilyInternalService } from './family/internal';

export * from './family/types';

export class FamilyService {
  private readonly query: FamilyQueryService;
  private readonly membership: FamilyMembershipService;
  private readonly chat: FamilyChatService;
  private readonly internal: FamilyInternalService;

  constructor(deps: FamilyServiceDeps) {
    this.query = new FamilyQueryService(deps);
    this.membership = new FamilyMembershipService(deps);
    this.chat = new FamilyChatService(deps);
    this.internal = new FamilyInternalService(deps);
  }

  // --- read-only lookups (family/query.ts) ---
  getMyFamily(accountId: string) {
    return this.query.getMyFamily(accountId);
  }
  getFamily(familyId: string, callerId?: string) {
    return this.query.getFamily(familyId, callerId);
  }
  searchByTag(tag: string) {
    return this.query.searchByTag(tag);
  }
  browseFamilies(query: string | undefined, limit = 10) {
    return this.query.browseFamilies(query, limit);
  }

  // --- membership lifecycle (family/membership.ts) ---
  createFamily(leaderId: string, name: string, tag: string, region: ChatRegion = 'global') {
    return this.membership.createFamily(leaderId, name, tag, region);
  }
  joinFamily(accountId: string, familyId: string) {
    return this.membership.joinFamily(accountId, familyId);
  }
  requestJoin(accountId: string, familyId: string) {
    return this.membership.requestJoin(accountId, familyId);
  }
  listJoinRequests(requesterId: string) {
    return this.membership.listJoinRequests(requesterId);
  }
  respondJoinRequest(requesterId: string, requestId: string, accept: boolean) {
    return this.membership.respondJoinRequest(requesterId, requestId, accept);
  }
  leaveFamily(accountId: string) {
    return this.membership.leaveFamily(accountId);
  }
  kickMember(requesterId: string, targetId: string) {
    return this.membership.kickMember(requesterId, targetId);
  }
  setRole(requesterId: string, targetId: string, role: FamilyRole) {
    return this.membership.setRole(requesterId, targetId, role);
  }
  dissolveFamily(requesterId: string) {
    return this.membership.dissolveFamily(requesterId);
  }
  setAnnouncement(requesterId: string, announcement: string) {
    return this.membership.setAnnouncement(requesterId, announcement);
  }
  setEmblem(requesterId: string, emblemKey: EmblemKey, emblemColor: number) {
    return this.membership.setEmblem(requesterId, emblemKey, emblemColor);
  }

  // --- family chat channel (family/chat.ts) ---
  sendMessage(accountId: string, senderName: string, body: string, region: ChatRegion = 'global') {
    return this.chat.sendMessage(accountId, senderName, body, region);
  }
  getChannel(accountId: string, before?: number, limit = 30) {
    return this.chat.getChannel(accountId, before, limit);
  }

  // --- internal API for worldsvc (family/internal.ts) ---
  getFamilyIdByAccount(accountId: string) {
    return this.internal.getFamilyIdByAccount(accountId);
  }
  bumpActivity(familyId: string, delta = 1) {
    return this.internal.bumpActivity(familyId, delta);
  }
  getMember(accountId: string) {
    return this.internal.getMember(accountId);
  }
  getFamiliesByIds(familyIds: string[]) {
    return this.internal.getFamiliesByIds(familyIds);
  }
  getFamiliesBySect(sectId: string) {
    return this.internal.getFamiliesBySect(sectId);
  }
  setSect(familyId: string, sectId: string | null, sectName?: string | null) {
    return this.internal.setSect(familyId, sectId, sectName);
  }
  refreshProsperity(familyId: string, territoryCount: number) {
    return this.internal.refreshProsperity(familyId, territoryCount);
  }
  bumpActivityAndProsperity(familyId: string, delta: number, territoryCount: number) {
    return this.internal.bumpActivityAndProsperity(familyId, delta, territoryCount);
  }
  resetSlgState(familyId: string) {
    return this.internal.resetSlgState(familyId);
  }
}
