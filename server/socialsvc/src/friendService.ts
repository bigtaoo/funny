// Friend + private-chat service facade (SOCIAL_SVC_DESIGN §3.2/§3.3 P2). Logic aligned with
// metaserver/src/social.ts; data layer switched to the nw_social collections; publicId
// reverse-lookup changed to call SocialMetaClient (no direct connection to the accounts database).
//
// Composed of two independent domain classes (2026-08-10 split, 独立类+组合 form, familyService.ts's
// sibling — the original single 541-line class had no shared private state beyond the deps both
// domains already take by constructor injection, so it splits cleanly into: friend relations
// (list/requests/block/reports) and 1:1 private chat) — see friend/relations.ts / friend/chat.ts.
// This class is a thin delegating facade so external callers (httpApi routes, this package's own
// tests) keep importing `FriendService` from this one path with an unchanged public API and behavior.
import type { ChatRegion } from '@nw/shared';
import type { FriendServiceDeps } from './friend/types';
import type { ReportDoc } from './db';
import { FriendRelationsService } from './friend/relations';
import { FriendChatService } from './friend/chat';

export * from './friend/types';

export class FriendService {
  private readonly relations: FriendRelationsService;
  private readonly chat: FriendChatService;

  constructor(deps: FriendServiceDeps) {
    this.relations = new FriendRelationsService(deps);
    this.chat = new FriendChatService(deps);
  }

  // --- friend relations (friend/relations.ts) ---
  getFriendAccountIds(accountId: string) {
    return this.relations.getFriendAccountIds(accountId);
  }
  batchPublicIds(accountIds: string[]) {
    return this.relations.batchPublicIds(accountIds);
  }
  getFriends(accountId: string) {
    return this.relations.getFriends(accountId);
  }
  listRequests(accountId: string) {
    return this.relations.listRequests(accountId);
  }
  getSocialBadges(accountId: string) {
    return this.relations.getSocialBadges(accountId);
  }
  searchFriend(publicId: string) {
    return this.relations.searchFriend(publicId);
  }
  requestFriend(accountId: string, publicId: string, message: string | undefined) {
    return this.relations.requestFriend(accountId, publicId, message);
  }
  respondFriend(accountId: string, requestId: string, accept: boolean) {
    return this.relations.respondFriend(accountId, requestId, accept);
  }
  removeFriend(accountId: string, publicId: string) {
    return this.relations.removeFriend(accountId, publicId);
  }
  blockUser(accountId: string, publicId: string) {
    return this.relations.blockUser(accountId, publicId);
  }
  unblockUser(accountId: string, publicId: string) {
    return this.relations.unblockUser(accountId, publicId);
  }
  reportUser(accountId: string, publicId: string, reason: string) {
    return this.relations.reportUser(accountId, publicId, reason);
  }
  listReports(status: ReportDoc['status'] = 'open', limit = 200) {
    return this.relations.listReports(status, limit);
  }
  resolveReport(id: string, resolution: 'dismissed' | 'upheld', resolvedBy: string) {
    return this.relations.resolveReport(id, resolution, resolvedBy);
  }

  // --- 1:1 private chat (friend/chat.ts) ---
  allowChat(accountId: string, now: number, ratePerMin = 30) {
    return this.chat.allowChat(accountId, now, ratePerMin);
  }
  sendMessage(accountId: string, toPublicId: string, bodyRaw: string, region: ChatRegion) {
    return this.chat.sendMessage(accountId, toPublicId, bodyRaw, region);
  }
  getConversations(accountId: string) {
    return this.chat.getConversations(accountId);
  }
  getMessages(accountId: string, convId: string, before: number | undefined, limit: number) {
    return this.chat.getMessages(accountId, convId, before, limit);
  }
  markConversationRead(accountId: string, convId: string) {
    return this.chat.markConversationRead(accountId, convId);
  }
}
