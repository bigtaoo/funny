// metaserver serviceHandlers: operationId from openapi.yml → method (assembled via generated/routes.gen.ts).
// Validation/routing is handled by the codegen'd router according to the spec; this file only assembles the
// per-domain handler classes into a single MetaService that structurally satisfies MetaHandlers.
//
// The service is composed by holding one independent sibling instance per business domain — each takes
// `MetaCore` (./service/base.js — the cross-cutting helpers: mutateSave / ensureCommercial / gatewayField /
// rejectIfBanned / readStaminaSnapshot / bumpRetentionTask) in its constructor. No shared base CLASS, no
// mixin chain (2026-08-11: converted from the `XMixin(Base)` chain per claudedocs/server.md's "拆分形态
// 的优先级" 形态②/独立类+组合 — all 9 domains had zero cross-domain `this.*` calls, only these shared
// helpers, which used to be `protected` on MetaServiceBase and are now plain public members on MetaCore).
// `MetaService`'s own constructor keeps the pre-existing `(...args: any[])` signature (matching
// MetaServiceBase's old unsound `args[0] as ServiceDeps` cast) rather than a strongly-typed
// `(deps: ServiceDeps)` — at least one test fixture (clientLog.test.ts) constructs it with an
// intentionally-partial deps object literal (only the fields that test actually exercises, no cast),
// which only compiles because the parameter type was never checked; tightening it here would be a new
// tsc error unrelated to this refactor. To add a handler: find the matching domain class (or add a new
// one) — do NOT grow this file.
import type { MetaHandlers } from './generated/routes.gen.js';
import { MetaCore, type ServiceDeps } from './service/base.js';
import { AuthService } from './service/auth.js';
import { SaveService } from './service/save.js';
import { PveService } from './service/pve.js';
import { EconomyService } from './service/economy.js';
import { InventoryService } from './service/inventory.js';
import { ProgressionService } from './service/progression.js';
import { LiveOpsService } from './service/liveops.js';
import { SocialService } from './service/social.js';
import { TelemetryService } from './service/telemetry.js';

export type { ServiceDeps } from './service/base.js';

/**
 * MetaService — the single object registered against every REST route (registerRoutes calls
 * fn.call(service, req, reply)). `implements MetaHandlers` gives a compile-time guarantee that every
 * handler method is present, with the right signature, across the 9 composed domain classes.
 */
export class MetaService implements MetaHandlers {
  private readonly core: MetaCore;
  private readonly authSvc: AuthService;
  private readonly saveSvc: SaveService;
  private readonly pveSvc: PveService;
  private readonly economySvc: EconomyService;
  private readonly inventorySvc: InventoryService;
  private readonly progressionSvc: ProgressionService;
  private readonly liveopsSvc: LiveOpsService;
  private readonly socialSvc: SocialService;
  private readonly telemetrySvc: TelemetryService;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    const deps = args[0] as ServiceDeps;
    this.core = new MetaCore(deps);
    this.authSvc = new AuthService(this.core);
    this.saveSvc = new SaveService(this.core);
    this.pveSvc = new PveService(this.core);
    this.economySvc = new EconomyService(this.core);
    this.inventorySvc = new InventoryService(this.core);
    this.progressionSvc = new ProgressionService(this.core);
    this.liveopsSvc = new LiveOpsService(this.core);
    this.socialSvc = new SocialService(this.core);
    this.telemetrySvc = new TelemetryService(this.core);
  }

  // ── auth ──
  authWx(...args: Parameters<AuthService['authWx']>) { return this.authSvc.authWx(...args); }
  authDevice(...args: Parameters<AuthService['authDevice']>) { return this.authSvc.authDevice(...args); }
  authRegister(...args: Parameters<AuthService['authRegister']>) { return this.authSvc.authRegister(...args); }
  authLogin(...args: Parameters<AuthService['authLogin']>) { return this.authSvc.authLogin(...args); }
  authPasswordChange(...args: Parameters<AuthService['authPasswordChange']>) { return this.authSvc.authPasswordChange(...args); }
  deleteAccount(...args: Parameters<AuthService['deleteAccount']>) { return this.authSvc.deleteAccount(...args); }
  cancelAccountDeletion(...args: Parameters<AuthService['cancelAccountDeletion']>) { return this.authSvc.cancelAccountDeletion(...args); }
  recordGdprConsent(...args: Parameters<AuthService['recordGdprConsent']>) { return this.authSvc.recordGdprConsent(...args); }
  authOAuth(...args: Parameters<AuthService['authOAuth']>) { return this.authSvc.authOAuth(...args); }
  authBind(...args: Parameters<AuthService['authBind']>) { return this.authSvc.authBind(...args); }
  profileRename(...args: Parameters<AuthService['profileRename']>) { return this.authSvc.profileRename(...args); }
  submitAppeal(...args: Parameters<AuthService['submitAppeal']>) { return this.authSvc.submitAppeal(...args); }
  submitFeedback(...args: Parameters<AuthService['submitFeedback']>) { return this.authSvc.submitFeedback(...args); }

  // ── save ──
  getSave(...args: Parameters<SaveService['getSave']>) { return this.saveSvc.getSave(...args); }
  getMatchHistory(...args: Parameters<SaveService['getMatchHistory']>) { return this.saveSvc.getMatchHistory(...args); }
  getMatchReplay(...args: Parameters<SaveService['getMatchReplay']>) { return this.saveSvc.getMatchReplay(...args); }
  createReplayShare(...args: Parameters<SaveService['createReplayShare']>) { return this.saveSvc.createReplayShare(...args); }
  getReplayByShare(...args: Parameters<SaveService['getReplayByShare']>) { return this.saveSvc.getReplayByShare(...args); }
  createStateReplayShare(...args: Parameters<SaveService['createStateReplayShare']>) { return this.saveSvc.createStateReplayShare(...args); }
  getStateReplayShare(...args: Parameters<SaveService['getStateReplayShare']>) { return this.saveSvc.getStateReplayShare(...args); }

  // ── pve ──
  purchaseStamina(...args: Parameters<PveService['purchaseStamina']>) { return this.pveSvc.purchaseStamina(...args); }
  pveEnter(...args: Parameters<PveService['pveEnter']>) { return this.pveSvc.pveEnter(...args); }
  pveClear(...args: Parameters<PveService['pveClear']>) { return this.pveSvc.pveClear(...args); }
  pveVerify(...args: Parameters<PveService['pveVerify']>) { return this.pveSvc.pveVerify(...args); }

  // ── economy ──
  getShopItems(...args: Parameters<EconomyService['getShopItems']>) { return this.economySvc.getShopItems(...args); }
  getGachaPools(...args: Parameters<EconomyService['getGachaPools']>) { return this.economySvc.getGachaPools(...args); }
  shopBuy(...args: Parameters<EconomyService['shopBuy']>) { return this.economySvc.shopBuy(...args); }
  gachaDraw(...args: Parameters<EconomyService['gachaDraw']>) { return this.economySvc.gachaDraw(...args); }
  redeemFate(...args: Parameters<EconomyService['redeemFate']>) { return this.economySvc.redeemFate(...args); }
  monthlyCardBuy(...args: Parameters<EconomyService['monthlyCardBuy']>) { return this.economySvc.monthlyCardBuy(...args); }
  yearCardBuy(...args: Parameters<EconomyService['yearCardBuy']>) { return this.economySvc.yearCardBuy(...args); }
  monthlyCardClaim(...args: Parameters<EconomyService['monthlyCardClaim']>) { return this.economySvc.monthlyCardClaim(...args); }
  claimRechargeMilestone(...args: Parameters<EconomyService['claimRechargeMilestone']>) { return this.economySvc.claimRechargeMilestone(...args); }
  starterBuy(...args: Parameters<EconomyService['starterBuy']>) { return this.economySvc.starterBuy(...args); }
  adsReward(...args: Parameters<EconomyService['adsReward']>) { return this.economySvc.adsReward(...args); }
  iapVerify(...args: Parameters<EconomyService['iapVerify']>) { return this.economySvc.iapVerify(...args); }
  redeemPromoCode(...args: Parameters<EconomyService['redeemPromoCode']>) { return this.economySvc.redeemPromoCode(...args); }

  // ── inventory ──
  craftEquipment(...args: Parameters<InventoryService['craftEquipment']>) { return this.inventorySvc.craftEquipment(...args); }
  enhanceEquipment(...args: Parameters<InventoryService['enhanceEquipment']>) { return this.inventorySvc.enhanceEquipment(...args); }
  salvageEquipment(...args: Parameters<InventoryService['salvageEquipment']>) { return this.inventorySvc.salvageEquipment(...args); }
  equipEquipment(...args: Parameters<InventoryService['equipEquipment']>) { return this.inventorySvc.equipEquipment(...args); }
  reforgeEquipment(...args: Parameters<InventoryService['reforgeEquipment']>) { return this.inventorySvc.reforgeEquipment(...args); }
  cardsFuse(...args: Parameters<InventoryService['cardsFuse']>) { return this.inventorySvc.cardsFuse(...args); }
  cardsFuseBatch(...args: Parameters<InventoryService['cardsFuseBatch']>) { return this.inventorySvc.cardsFuseBatch(...args); }
  cardsLock(...args: Parameters<InventoryService['cardsLock']>) { return this.inventorySvc.cardsLock(...args); }
  cardsUnlock(...args: Parameters<InventoryService['cardsUnlock']>) { return this.inventorySvc.cardsUnlock(...args); }

  // ── progression ──
  getLeaderboard(...args: Parameters<ProgressionService['getLeaderboard']>) { return this.progressionSvc.getLeaderboard(...args); }
  buyBattlePass(...args: Parameters<ProgressionService['buyBattlePass']>) { return this.progressionSvc.buyBattlePass(...args); }
  claimBattlePass(...args: Parameters<ProgressionService['claimBattlePass']>) { return this.progressionSvc.claimBattlePass(...args); }
  submitBotResult(...args: Parameters<ProgressionService['submitBotResult']>) { return this.progressionSvc.submitBotResult(...args); }

  // ── liveops ──
  getAchievements(...args: Parameters<LiveOpsService['getAchievements']>) { return this.liveopsSvc.getAchievements(...args); }
  claimAchievement(...args: Parameters<LiveOpsService['claimAchievement']>) { return this.liveopsSvc.claimAchievement(...args); }
  getRetention(...args: Parameters<LiveOpsService['getRetention']>) { return this.liveopsSvc.getRetention(...args); }
  claimCheckin(...args: Parameters<LiveOpsService['claimCheckin']>) { return this.liveopsSvc.claimCheckin(...args); }
  claimDailyReward(...args: Parameters<LiveOpsService['claimDailyReward']>) { return this.liveopsSvc.claimDailyReward(...args); }
  claimWeeklyChest(...args: Parameters<LiveOpsService['claimWeeklyChest']>) { return this.liveopsSvc.claimWeeklyChest(...args); }
  getEvents(...args: Parameters<LiveOpsService['getEvents']>) { return this.liveopsSvc.getEvents(...args); }
  claimEventReward(...args: Parameters<LiveOpsService['claimEventReward']>) { return this.liveopsSvc.claimEventReward(...args); }
  getTitles(...args: Parameters<LiveOpsService['getTitles']>) { return this.liveopsSvc.getTitles(...args); }
  equipTitle(...args: Parameters<LiveOpsService['equipTitle']>) { return this.liveopsSvc.equipTitle(...args); }
  equipAvatar(...args: Parameters<LiveOpsService['equipAvatar']>) { return this.liveopsSvc.equipAvatar(...args); }
  equipSkin(...args: Parameters<LiveOpsService['equipSkin']>) { return this.liveopsSvc.equipSkin(...args); }
  setFlag(...args: Parameters<LiveOpsService['setFlag']>) { return this.liveopsSvc.setFlag(...args); }
  getLobbyBadges(...args: Parameters<LiveOpsService['getLobbyBadges']>) { return this.liveopsSvc.getLobbyBadges(...args); }

  // ── social ──
  getFriends(...args: Parameters<SocialService['getFriends']>) { return this.socialSvc.getFriends(...args); }
  getFriendRequests(...args: Parameters<SocialService['getFriendRequests']>) { return this.socialSvc.getFriendRequests(...args); }
  getSocialBadges(...args: Parameters<SocialService['getSocialBadges']>) { return this.socialSvc.getSocialBadges(...args); }
  searchFriend(...args: Parameters<SocialService['searchFriend']>) { return this.socialSvc.searchFriend(...args); }
  requestFriend(...args: Parameters<SocialService['requestFriend']>) { return this.socialSvc.requestFriend(...args); }
  respondFriend(...args: Parameters<SocialService['respondFriend']>) { return this.socialSvc.respondFriend(...args); }
  removeFriend(...args: Parameters<SocialService['removeFriend']>) { return this.socialSvc.removeFriend(...args); }
  blockUser(...args: Parameters<SocialService['blockUser']>) { return this.socialSvc.blockUser(...args); }
  unblockUser(...args: Parameters<SocialService['unblockUser']>) { return this.socialSvc.unblockUser(...args); }
  reportUser(...args: Parameters<SocialService['reportUser']>) { return this.socialSvc.reportUser(...args); }
  getConversations(...args: Parameters<SocialService['getConversations']>) { return this.socialSvc.getConversations(...args); }
  getMessages(...args: Parameters<SocialService['getMessages']>) { return this.socialSvc.getMessages(...args); }
  sendChat(...args: Parameters<SocialService['sendChat']>) { return this.socialSvc.sendChat(...args); }
  readChat(...args: Parameters<SocialService['readChat']>) { return this.socialSvc.readChat(...args); }
  getMail(...args: Parameters<SocialService['getMail']>) { return this.socialSvc.getMail(...args); }
  readMail(...args: Parameters<SocialService['readMail']>) { return this.socialSvc.readMail(...args); }
  deleteMail(...args: Parameters<SocialService['deleteMail']>) { return this.socialSvc.deleteMail(...args); }
  claimMail(...args: Parameters<SocialService['claimMail']>) { return this.socialSvc.claimMail(...args); }
  sendMail(...args: Parameters<SocialService['sendMail']>) { return this.socialSvc.sendMail(...args); }

  // ── telemetry ──
  bootstrap(...args: Parameters<TelemetryService['bootstrap']>) { return this.telemetrySvc.bootstrap(...args); }
  clientLog(...args: Parameters<TelemetryService['clientLog']>) { return this.telemetrySvc.clientLog(...args); }
  clientAnomaly(...args: Parameters<TelemetryService['clientAnomaly']>) { return this.telemetrySvc.clientAnomaly(...args); }
  getAnalyticsConfig(...args: Parameters<TelemetryService['getAnalyticsConfig']>) { return this.telemetrySvc.getAnalyticsConfig(...args); }
  postAnalyticsEvents(...args: Parameters<TelemetryService['postAnalyticsEvents']>) { return this.telemetrySvc.postAnalyticsEvents(...args); }
}
