// metaserver REST client (S0-5). Covers the endpoints used by S0: auth/device · auth/wx · GET/PUT save,
// plus economy/social/achievements/events/retention/season/bootstrap. Thin assembly file.
//
// The client is split by domain — each part lives in ./ApiClient/*.ts as an independent class
// constructed with the shared `ApiClientCore` (./ApiClient/core.ts, which owns the constructor + auth
// token + the shared request()/fetchRaw() transport). To add an endpoint: find the matching domain
// service (auth / pve / equipment / shop / gacha / social / mail / achievements / misc), add the method
// there + its matching one-line forward below, or add a new domain file — do NOT grow the domain logic
// into this file. All DTO/view types + ApiError are re-exported so existing importers
// (`from '../net/ApiClient'`) keep resolving to this file, not the directory.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — the chain had
// zero cross-domain `this.*` calls (pure file-splitting via a chain, see claudedocs/client-modules.md's
// split-form priority note), so this is a mechanical form-③→form-② conversion, not a behavior change.
// `ApiClient` itself is now a thin forwarding facade (one line per endpoint) rather than an `extends`
// chain — every method on this class exists solely because dozens of call sites across the codebase
// already call `apiClient.methodName(...)` directly and must keep resolving.
//
// Contract = contracts/openapi.yml (unified response envelope ApiResp<T>, optimistic locking via If-Match).
import type { AuthCredential } from '../platform/IPlatform';
import type {
  SaveData,
  LeanSaveResponse,
  EquipmentInstance,
  EquipSlot,
  CardInstance,
} from '../game/meta/SaveData';
import { ApiClientCore } from './ApiClient/core';
import { AuthService } from './ApiClient/auth';
import { PveService } from './ApiClient/pve';
import { EquipmentService } from './ApiClient/equipment';
import { ShopService } from './ApiClient/shop';
import { GachaService } from './ApiClient/gacha';
import { SocialService } from './ApiClient/social';
import { MailService } from './ApiClient/mail';
import { AchievementsService } from './ApiClient/achievements';
import { MiscService } from './ApiClient/misc';
import type { AuthResult, ActiveMatchInfo } from './ApiClient/types';
import type { ServerReplay, MatchHistoryEntry } from './ApiClient/types';
import type { ShopItem } from './ApiClient/types';
import type { GachaOverflow, GachaPool, GachaResultEntry, RechargeReward } from './ApiClient/types';
import type {
  FriendView,
  FriendRequestView,
  SocialBadges,
  ProfileView,
  ConversationView,
  ChatMessageView,
} from './ApiClient/types';
import type { MailView } from './ApiClient/types';
import type { AchievementsView } from './ApiClient/types';
import type { RetentionView, EventView, LobbyBadgesView } from './ApiClient/types';

export { ApiError } from './ApiClient/core';
export type {
  ShopItem,
  GachaPool,
  GachaResultEntry,
  GachaOverflow,
  MatchHistoryEntry,
  AuthResult,
  ActiveMatchInfo,
  ProfileView,
  FriendView,
  FriendRequestView,
  ConversationView,
  ChatMessageView,
  MailView,
  MailAttachmentView,
  SocialBadges,
  ServerReplay,
  Achievement,
  AchievementsView,
  EventView,
  RetentionView,
  LobbyBadgesView,
} from './ApiClient/types';

/**
 * metaserver REST client — thin forwarding facade over the per-domain composition (see the file-header
 * comment above). Owns one `ApiClientCore` (transport + token) and one instance of each domain service,
 * all constructed with that same core.
 */
export class ApiClient {
  private readonly core: ApiClientCore;
  private readonly authSvc: AuthService;
  private readonly pveSvc: PveService;
  private readonly equipmentSvc: EquipmentService;
  private readonly shopSvc: ShopService;
  private readonly gachaSvc: GachaService;
  private readonly socialSvc: SocialService;
  private readonly mailSvc: MailService;
  private readonly achievementsSvc: AchievementsService;
  private readonly miscSvc: MiscService;

  constructor(baseUrl: string) {
    this.core = new ApiClientCore(baseUrl);
    this.authSvc = new AuthService(this.core);
    this.pveSvc = new PveService(this.core);
    this.equipmentSvc = new EquipmentService(this.core);
    this.shopSvc = new ShopService(this.core);
    this.gachaSvc = new GachaService(this.core);
    this.socialSvc = new SocialService(this.core);
    this.mailSvc = new MailService(this.core);
    this.achievementsSvc = new AchievementsService(this.core);
    this.miscSvc = new MiscService(this.core);
  }

  setToken(token: string | null): void {
    this.core.setToken(token);
  }

  getToken(): string | null {
    return this.core.getToken();
  }

  hasToken(): boolean {
    return this.core.hasToken();
  }

  // ── auth / account / save (./ApiClient/auth.ts) ──────────────────────────
  auth(cred: AuthCredential): Promise<AuthResult> {
    return this.authSvc.auth(cred);
  }

  register(loginId: string, password: string, displayName?: string): Promise<AuthResult> {
    return this.authSvc.register(loginId, password, displayName);
  }

  login(loginId: string, password: string): Promise<AuthResult> {
    return this.authSvc.login(loginId, password);
  }

  changePassword(oldPassword: string, newPassword: string): Promise<void> {
    return this.authSvc.changePassword(oldPassword, newPassword);
  }

  deleteAccount(): Promise<{ confirmToken: string }> {
    return this.authSvc.deleteAccount();
  }

  cancelAccountDeletion(confirmToken: string): Promise<void> {
    return this.authSvc.cancelAccountDeletion(confirmToken);
  }

  recordGdprConsent(consent: boolean): Promise<void> {
    return this.authSvc.recordGdprConsent(consent);
  }

  getSave(): Promise<{
    save: SaveData;
    displayName?: string;
    publicId?: string;
    gatewayUrl?: string;
    freeRename?: boolean;
    activeMatch?: ActiveMatchInfo;
  }> {
    return this.authSvc.getSave();
  }

  rename(
    displayName: string
  ): Promise<{ save: SaveData; displayName: string; freeRename?: boolean }> {
    return this.authSvc.rename(displayName);
  }

  equipTitle(titleId: string): Promise<{ save: SaveData }> {
    return this.authSvc.equipTitle(titleId);
  }

  equipAvatar(avatarId: string): Promise<{ save: SaveData }> {
    return this.authSvc.equipAvatar(avatarId);
  }

  equipSkin(unitType: string, skinId: string | null): Promise<{ save: SaveData }> {
    return this.authSvc.equipSkin(unitType, skinId);
  }

  setFlag(key: string, value: boolean): Promise<{ save: SaveData }> {
    return this.authSvc.setFlag(key, value);
  }

  submitAppeal(reason: string): Promise<void> {
    return this.authSvc.submitAppeal(reason);
  }

  submitFeedback(text: string): Promise<void> {
    return this.authSvc.submitFeedback(text);
  }

  // ── PvE / replay / match history (./ApiClient/pve.ts) ────────────────────
  pveClear(
    levelId: string,
    stars: number,
    unitLevels?: Record<string, number>,
    stats?: Record<string, number>
  ): Promise<{
    save: SaveData;
    granted: Record<string, number>;
    capped: boolean;
    needsReplay?: boolean;
    verifyId?: string;
    grantedEquipment?: EquipmentInstance;
  }> {
    return this.pveSvc.pveClear(levelId, stars, unitLevels, stats);
  }

  createReplayShare(roomId: string): Promise<{ shareId: string }> {
    return this.pveSvc.createReplayShare(roomId);
  }

  getReplayByShare(shareId: string): Promise<{ replay: ServerReplay }> {
    return this.pveSvc.getReplayByShare(shareId);
  }

  createStateReplayShare(blob: unknown): Promise<{ shareCode: string }> {
    return this.pveSvc.createStateReplayShare(blob);
  }

  getStateReplayShare(shareCode: string): Promise<{ blob: unknown }> {
    return this.pveSvc.getStateReplayShare(shareCode);
  }

  pveVerify(
    verifyId: string,
    endFrame: number,
    frames: { frame: number; cmds: { side: number; commands: string }[] }[]
  ): Promise<{
    save: SaveData;
    granted: Record<string, number>;
    capped: boolean;
    verified: boolean;
    grantedEquipment?: EquipmentInstance;
  }> {
    return this.pveSvc.pveVerify(verifyId, endFrame, frames);
  }

  purchaseStamina(): Promise<{ stamina: { current: number; regenAt: number } }> {
    return this.pveSvc.purchaseStamina();
  }

  pveEnter(levelId: string): Promise<{ stamina: { current: number; regenAt: number } }> {
    return this.pveSvc.pveEnter(levelId);
  }

  getMatchHistory(limit?: number): Promise<MatchHistoryEntry[]> {
    return this.pveSvc.getMatchHistory(limit);
  }

  getMatchReplay(roomId: string): Promise<ServerReplay> {
    return this.pveSvc.getMatchReplay(roomId);
  }

  // ── Equipment / card fuse / card lock (./ApiClient/equipment.ts) ─────────
  craftEquipment(
    defId: string,
    idempotencyKey: string
  ): Promise<{ save: LeanSaveResponse; instance: EquipmentInstance }> {
    return this.equipmentSvc.craftEquipment(defId, idempotencyKey);
  }

  enhanceEquipment(
    instanceId: string,
    idempotencyKey: string,
    useProtect?: boolean
  ): Promise<{ success: boolean; instance: EquipmentInstance; save: LeanSaveResponse }> {
    return this.equipmentSvc.enhanceEquipment(instanceId, idempotencyKey, useProtect);
  }

  salvageEquipment(
    instanceIds: string[],
    idempotencyKey: string
  ): Promise<{ refunded: Record<string, number>; save: LeanSaveResponse }> {
    return this.equipmentSvc.salvageEquipment(instanceIds, idempotencyKey);
  }

  equipEquipment(
    slot: EquipSlot,
    instanceId: string | null,
    cardInstanceId: string
  ): Promise<{ save: LeanSaveResponse }> {
    return this.equipmentSvc.equipEquipment(slot, instanceId, cardInstanceId);
  }

  fuseCards(
    targetCardId: string,
    materialCardIds: string[],
    idempotencyKey: string
  ): Promise<{ save: SaveData; card: CardInstance }> {
    return this.equipmentSvc.fuseCards(targetCardId, materialCardIds, idempotencyKey);
  }

  setCardLock(cardInstanceId: string, locked: boolean): Promise<{ save: SaveData }> {
    return this.equipmentSvc.setCardLock(cardInstanceId, locked);
  }

  reforgeEquipment(
    targetId: string,
    materialId: string,
    idempotencyKey: string
  ): Promise<{ instance: EquipmentInstance; save: LeanSaveResponse }> {
    return this.equipmentSvc.reforgeEquipment(targetId, materialId, idempotencyKey);
  }

  // ── Shop / ads / IAP / promo (./ApiClient/shop.ts) ────────────────────────
  getShopItems(): Promise<ShopItem[]> {
    return this.shopSvc.getShopItems();
  }

  shopBuy(itemId: string, qty?: number): Promise<{ save: SaveData; granted: string }> {
    return this.shopSvc.shopBuy(itemId, qty);
  }

  adsReward(adToken: string, platform?: string): Promise<{ save: SaveData; granted: number }> {
    return this.shopSvc.adsReward(adToken, platform);
  }

  iapVerify(platform: string, receipt: string): Promise<{ save: SaveData; granted: number }> {
    return this.shopSvc.iapVerify(platform, receipt);
  }

  paddleCheckout(tierId: string): Promise<{ transactionId: string }> {
    return this.shopSvc.paddleCheckout(tierId);
  }

  redeemPromoCode(code: string): Promise<{ save: SaveData; granted: number }> {
    return this.shopSvc.redeemPromoCode(code);
  }

  // ── Gacha / monetized card products (./ApiClient/gacha.ts) ───────────────
  getGachaPools(): Promise<GachaPool[]> {
    return this.gachaSvc.getGachaPools();
  }

  gachaDraw(
    poolId: string,
    count: 1 | 10
  ): Promise<{
    save: LeanSaveResponse;
    results: GachaResultEntry[];
    overflow: GachaOverflow;
    cardGrants: CardInstance[];
    equipmentGrants: EquipmentInstance[];
  }> {
    return this.gachaSvc.gachaDraw(poolId, count);
  }

  redeemFate(itemId: string): Promise<{ save: SaveData; granted: string }> {
    return this.gachaSvc.redeemFate(itemId);
  }

  monthlyCardBuy(platform: string, receipt: string): Promise<{ save: SaveData }> {
    return this.gachaSvc.monthlyCardBuy(platform, receipt);
  }

  yearCardBuy(platform: string, receipt: string): Promise<{ save: SaveData }> {
    return this.gachaSvc.yearCardBuy(platform, receipt);
  }

  monthlyCardClaim(): Promise<{ save: SaveData; claimed: number }> {
    return this.gachaSvc.monthlyCardClaim();
  }

  starterBuy(
    productId: 'starter_draw' | 'starter_growth',
    platform: string,
    receipt: string
  ): Promise<{ save: SaveData; results: GachaResultEntry[] }> {
    return this.gachaSvc.starterBuy(productId, platform, receipt);
  }

  claimRechargeMilestone(tierId: number): Promise<{ save: SaveData; rewards: RechargeReward[] }> {
    return this.gachaSvc.claimRechargeMilestone(tierId);
  }

  // ── Social: friends + private chat (./ApiClient/social.ts) ───────────────
  getFriends(): Promise<FriendView[]> {
    return this.socialSvc.getFriends();
  }

  getFriendRequests(): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }> {
    return this.socialSvc.getFriendRequests();
  }

  getSocialBadges(): Promise<SocialBadges> {
    return this.socialSvc.getSocialBadges();
  }

  searchFriend(publicId: string): Promise<ProfileView> {
    return this.socialSvc.searchFriend(publicId);
  }

  requestFriend(publicId: string, message?: string): Promise<string> {
    return this.socialSvc.requestFriend(publicId, message);
  }

  respondFriend(requestId: string, accept: boolean): Promise<void> {
    return this.socialSvc.respondFriend(requestId, accept);
  }

  removeFriend(publicId: string): Promise<void> {
    return this.socialSvc.removeFriend(publicId);
  }

  blockUser(publicId: string): Promise<void> {
    return this.socialSvc.blockUser(publicId);
  }

  unblockUser(publicId: string): Promise<void> {
    return this.socialSvc.unblockUser(publicId);
  }

  reportUser(publicId: string, reason: string): Promise<void> {
    return this.socialSvc.reportUser(publicId, reason);
  }

  getConversations(): Promise<ConversationView[]> {
    return this.socialSvc.getConversations();
  }

  getMessages(convId: string, before?: number, limit?: number): Promise<ChatMessageView[]> {
    return this.socialSvc.getMessages(convId, before, limit);
  }

  sendChat(toPublicId: string, body: string): Promise<{ messageId: string; ts: number }> {
    return this.socialSvc.sendChat(toPublicId, body);
  }

  readChat(convId: string): Promise<void> {
    return this.socialSvc.readChat(convId);
  }

  // ── Mail (./ApiClient/mail.ts) ────────────────────────────────────────────
  getMail(): Promise<{ mail: MailView[]; unread: number }> {
    return this.mailSvc.getMail();
  }

  readMail(mailId: string): Promise<void> {
    return this.mailSvc.readMail(mailId);
  }

  claimMail(mailId: string): Promise<{ save: SaveData }> {
    return this.mailSvc.claimMail(mailId);
  }

  deleteMail(mailId: string): Promise<void> {
    return this.mailSvc.deleteMail(mailId);
  }

  sendMail(toPublicId: string, subject: string, body: string): Promise<string> {
    return this.mailSvc.sendMail(toPublicId, subject, body);
  }

  // ── Achievements (./ApiClient/achievements.ts) ───────────────────────────
  getAchievements(): Promise<AchievementsView> {
    return this.achievementsSvc.getAchievements();
  }

  claimAchievement(achId: string, tier: number): Promise<{ save: SaveData; granted: number }> {
    return this.achievementsSvc.claimAchievement(achId, tier);
  }

  // ── Retention / events / leaderboard / battle pass / bootstrap (./ApiClient/misc.ts) ──
  getLobbyBadges(): Promise<LobbyBadgesView> {
    return this.miscSvc.getLobbyBadges();
  }

  getRetention(): Promise<RetentionView> {
    return this.miscSvc.getRetention();
  }

  claimCheckin(): Promise<{
    save: SaveData;
    day: number;
    reward: { kind: string; count: number; id?: string; bonusCoins?: number };
  }> {
    return this.miscSvc.claimCheckin();
  }

  claimDailyReward(): Promise<{ save: SaveData; coins: number }> {
    return this.miscSvc.claimDailyReward();
  }

  claimWeeklyChest(
    threshold: number
  ): Promise<{
    save: SaveData;
    threshold: number;
    reward: { kind: string; count: number; id?: string };
  }> {
    return this.miscSvc.claimWeeklyChest(threshold);
  }

  getEvents(): Promise<EventView[]> {
    return this.miscSvc.getEvents();
  }

  claimEventReward(
    eventId: string,
    rewardId: string
  ): Promise<{ pointsLeft: number; reward: { kind: string; id?: string; count?: number } }> {
    return this.miscSvc.claimEventReward(eventId, rewardId);
  }

  getLeaderboard(): Promise<{
    seasonNo: number;
    entries: {
      rank: number;
      displayName: string;
      publicId: string;
      elo: number;
      pvpRank: string;
    }[];
    me?: { rank: number; elo: number; pvpRank: string };
  }> {
    return this.miscSvc.getLeaderboard();
  }

  submitBotResult(won: boolean): Promise<{ elo: number; rank: string; delta: number }> {
    return this.miscSvc.submitBotResult(won);
  }

  buyBattlePass(): Promise<{ battlePass: SaveData['battlePass'] }> {
    return this.miscSvc.buyBattlePass();
  }

  claimBattlePass(
    track: 'free' | 'paid',
    level: number
  ): Promise<{ battlePass: SaveData['battlePass']; reward: { kind: string; count: number } }> {
    return this.miscSvc.claimBattlePass(track, level);
  }

  getBootstrap(
    platform: string,
    publicId?: string
  ): Promise<{ flags: Record<string, boolean>; paddleClientToken?: string }> {
    return this.miscSvc.getBootstrap(platform, publicId);
  }

  postClientLog(body: {
    publicId: string;
    platform?: string;
    logs: { level: string; msg: string; ts: number; tag?: string }[];
  }): Promise<void> {
    return this.miscSvc.postClientLog(body);
  }
}
