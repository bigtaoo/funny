// Admin service core (OPS_DESIGN §2/§3/§5). RBAC + account management + compensation approval ticket flow + audit + monitoring/trends + sampling.
// httpApi handles authentication (admin JWT) + static capability gates; this class enforces business invariants (initiator ≠ approver, quota → approval capability,
// ticket state machine) + audit persistence. All write operations flow through here → single source of truth.
//
// The service is composed by holding one independent sibling instance per business domain — each takes
// `AdminCore` (./service/base.ts, the cross-cutting audit/requireCap/actorNames helpers + unpacked deps
// fields) in its constructor. No shared base CLASS, no mixin chain (2026-08-11: converted from the
// `XMixin(Base)` chain per claudedocs/server.md's "拆分形态的优先级" 形态②/独立类+组合 — all 18 domains
// had zero cross-domain `this.*` calls, only these three shared helpers, so composition replaces the
// 18-deep inheritance chain one-for-one with no narrow per-pair interfaces needed — every domain just
// takes the same `AdminCore`). `AdminService`'s own constructor keeps the pre-existing `(...args: any[])`
// signature (matching AdminServiceBase's old unsound `args[0] as AdminServiceDeps` cast) rather than a
// strongly-typed `(deps: AdminServiceDeps)` — several existing test fixtures construct `AdminService`
// with intentionally-partial deps objects (only the fields that test actually exercises), which only
// compiles because the parameter type was never checked; tightening it here would be a new tsc error
// unrelated to this refactor. To add a handler: find the matching domain class (or add a new one) — do
// NOT grow this file.
import { ADMIN_ROLES } from '@nw/shared';
import { AdminCore, type AdminServiceDeps } from './service/base';
import { EventsService } from './service/events';
import { GachaService } from './service/gacha';
import { PromoService } from './service/promo';
import { PaddleEventsService } from './service/paddleEvents';
import { LadderService } from './service/ladder';
import { WorldService } from './service/world';
import { MapTemplatesService } from './service/mapTemplates';
import { SlgAuditService } from './service/slgAudit';
import { AuthService } from './service/auth';
import { AccountsService } from './service/accounts';
import { TicketsService } from './service/tickets';
import { AnalyticsService } from './service/analytics';
import { FlagsService } from './service/flags';
import { ShopService } from './service/shop';
import { ModerationService } from './service/moderation';
import { ReportsService } from './service/reports';
import { AppealsService } from './service/appeals';
import { FeedbackService } from './service/feedback';

export { AdminError } from './service/errors';
export type { Actor, AdminServiceDeps } from './service/base';
export { ADMIN_ROLES };

/**
 * AdminService — the single object registered against every admin route (httpApi calls svc.method(...)).
 * Composed from 18 independent sibling domain classes, each sharing one `AdminCore`.
 */
export class AdminService {
  private readonly core: AdminCore;
  private readonly events: EventsService;
  private readonly gacha: GachaService;
  private readonly promo: PromoService;
  private readonly paddleEvents: PaddleEventsService;
  private readonly ladder: LadderService;
  private readonly world: WorldService;
  private readonly mapTemplates: MapTemplatesService;
  private readonly slgAudit: SlgAuditService;
  private readonly auth: AuthService;
  private readonly accounts: AccountsService;
  private readonly tickets: TicketsService;
  private readonly analytics: AnalyticsService;
  private readonly flags: FlagsService;
  private readonly shop: ShopService;
  private readonly moderation: ModerationService;
  private readonly reports: ReportsService;
  private readonly appeals: AppealsService;
  private readonly feedback: FeedbackService;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    const deps = args[0] as AdminServiceDeps;
    this.core = new AdminCore(deps);
    this.events = new EventsService(this.core);
    this.gacha = new GachaService(this.core);
    this.promo = new PromoService(this.core);
    this.paddleEvents = new PaddleEventsService(this.core);
    this.ladder = new LadderService(this.core);
    this.world = new WorldService(this.core);
    this.mapTemplates = new MapTemplatesService(this.core);
    this.slgAudit = new SlgAuditService(this.core);
    this.auth = new AuthService(this.core);
    this.accounts = new AccountsService(this.core);
    this.tickets = new TicketsService(this.core);
    this.analytics = new AnalyticsService(this.core);
    this.flags = new FlagsService(this.core);
    this.shop = new ShopService(this.core);
    this.moderation = new ModerationService(this.core);
    this.reports = new ReportsService(this.core);
    this.appeals = new AppealsService(this.core);
    this.feedback = new FeedbackService(this.core);
  }

  /** Write one audit entry — a handful of httpApi routes call this directly (session/login paths). */
  audit(...args: Parameters<AdminCore['audit']>) { return this.core.audit(...args); }

  // ── events ──
  listEvents(...args: Parameters<EventsService['listEvents']>) { return this.events.listEvents(...args); }
  createEvent(...args: Parameters<EventsService['createEvent']>) { return this.events.createEvent(...args); }
  updateEvent(...args: Parameters<EventsService['updateEvent']>) { return this.events.updateEvent(...args); }
  deleteEvent(...args: Parameters<EventsService['deleteEvent']>) { return this.events.deleteEvent(...args); }

  // ── gacha ──
  listGachaPools(...args: Parameters<GachaService['listGachaPools']>) { return this.gacha.listGachaPools(...args); }
  gachaCatalog(...args: Parameters<GachaService['gachaCatalog']>) { return this.gacha.gachaCatalog(...args); }
  createCustomPool(...args: Parameters<GachaService['createCustomPool']>) { return this.gacha.createCustomPool(...args); }
  closeGachaPool(...args: Parameters<GachaService['closeGachaPool']>) { return this.gacha.closeGachaPool(...args); }

  // ── promo ──
  listPromoCodes(...args: Parameters<PromoService['listPromoCodes']>) { return this.promo.listPromoCodes(...args); }
  createPromoCode(...args: Parameters<PromoService['createPromoCode']>) { return this.promo.createPromoCode(...args); }

  // ── paddleEvents ──
  listPaddleEvents(...args: Parameters<PaddleEventsService['listPaddleEvents']>) { return this.paddleEvents.listPaddleEvents(...args); }

  // ── ladder ──
  getLadderCurrentSeason(...args: Parameters<LadderService['getLadderCurrentSeason']>) { return this.ladder.getLadderCurrentSeason(...args); }
  rollLadderSeason(...args: Parameters<LadderService['rollLadderSeason']>) { return this.ladder.rollLadderSeason(...args); }
  listMismatches(...args: Parameters<LadderService['listMismatches']>) { return this.ladder.listMismatches(...args); }
  listPvpCardStats(...args: Parameters<LadderService['listPvpCardStats']>) { return this.ladder.listPvpCardStats(...args); }
  listSuspiciousPve(...args: Parameters<LadderService['listSuspiciousPve']>) { return this.ladder.listSuspiciousPve(...args); }
  banAccount(...args: Parameters<LadderService['banAccount']>) { return this.ladder.banAccount(...args); }
  unbanAccount(...args: Parameters<LadderService['unbanAccount']>) { return this.ladder.unbanAccount(...args); }

  // ── world (SLG season ops) ──
  slgListWorlds(...args: Parameters<WorldService['slgListWorlds']>) { return this.world.slgListWorlds(...args); }
  slgOpenSeason(...args: Parameters<WorldService['slgOpenSeason']>) { return this.world.slgOpenSeason(...args); }
  slgSettleSeason(...args: Parameters<WorldService['slgSettleSeason']>) { return this.world.slgSettleSeason(...args); }
  slgResetSeason(...args: Parameters<WorldService['slgResetSeason']>) { return this.world.slgResetSeason(...args); }
  slgCloseSeason(...args: Parameters<WorldService['slgCloseSeason']>) { return this.world.slgCloseSeason(...args); }
  slgMergeShard(...args: Parameters<WorldService['slgMergeShard']>) { return this.world.slgMergeShard(...args); }
  slgAllocateNextSeason(...args: Parameters<WorldService['slgAllocateNextSeason']>) { return this.world.slgAllocateNextSeason(...args); }

  // ── mapTemplates ──
  slgListMapTemplates(...args: Parameters<MapTemplatesService['slgListMapTemplates']>) { return this.mapTemplates.slgListMapTemplates(...args); }
  slgGenerateMapTemplate(...args: Parameters<MapTemplatesService['slgGenerateMapTemplate']>) { return this.mapTemplates.slgGenerateMapTemplate(...args); }
  slgGetMapTemplateTiles(...args: Parameters<MapTemplatesService['slgGetMapTemplateTiles']>) { return this.mapTemplates.slgGetMapTemplateTiles(...args); }
  slgSaveMapTemplateTiles(...args: Parameters<MapTemplatesService['slgSaveMapTemplateTiles']>) { return this.mapTemplates.slgSaveMapTemplateTiles(...args); }
  slgGetMapTemplateCities(...args: Parameters<MapTemplatesService['slgGetMapTemplateCities']>) { return this.mapTemplates.slgGetMapTemplateCities(...args); }
  slgSaveMapTemplateCities(...args: Parameters<MapTemplatesService['slgSaveMapTemplateCities']>) { return this.mapTemplates.slgSaveMapTemplateCities(...args); }
  slgActivateMapTemplate(...args: Parameters<MapTemplatesService['slgActivateMapTemplate']>) { return this.mapTemplates.slgActivateMapTemplate(...args); }
  slgDeleteMapTemplate(...args: Parameters<MapTemplatesService['slgDeleteMapTemplate']>) { return this.mapTemplates.slgDeleteMapTemplate(...args); }

  // ── slgAudit ──
  slgScanAnomalies(...args: Parameters<SlgAuditService['slgScanAnomalies']>) { return this.slgAudit.slgScanAnomalies(...args); }
  slgQueryAuctionListings(...args: Parameters<SlgAuditService['slgQueryAuctionListings']>) { return this.slgAudit.slgQueryAuctionListings(...args); }
  slgFileAuditTicket(...args: Parameters<SlgAuditService['slgFileAuditTicket']>) { return this.slgAudit.slgFileAuditTicket(...args); }
  slgListAuditTickets(...args: Parameters<SlgAuditService['slgListAuditTickets']>) { return this.slgAudit.slgListAuditTickets(...args); }
  slgResolveAuditTicket(...args: Parameters<SlgAuditService['slgResolveAuditTicket']>) { return this.slgAudit.slgResolveAuditTicket(...args); }

  // ── auth ──
  authenticate(...args: Parameters<AuthService['authenticate']>) { return this.auth.authenticate(...args); }
  getAccount(...args: Parameters<AuthService['getAccount']>) { return this.auth.getAccount(...args); }
  meView(...args: Parameters<AuthService['meView']>) { return this.auth.meView(...args); }

  // ── accounts ──
  listAccounts(...args: Parameters<AccountsService['listAccounts']>) { return this.accounts.listAccounts(...args); }
  createAccount(...args: Parameters<AccountsService['createAccount']>) { return this.accounts.createAccount(...args); }
  updateAccount(...args: Parameters<AccountsService['updateAccount']>) { return this.accounts.updateAccount(...args); }
  resetPassword(...args: Parameters<AccountsService['resetPassword']>) { return this.accounts.resetPassword(...args); }

  // ── tickets ──
  initiateTicket(...args: Parameters<TicketsService['initiateTicket']>) { return this.tickets.initiateTicket(...args); }
  listTickets(...args: Parameters<TicketsService['listTickets']>) { return this.tickets.listTickets(...args); }
  approveTicket(...args: Parameters<TicketsService['approveTicket']>) { return this.tickets.approveTicket(...args); }
  rejectTicket(...args: Parameters<TicketsService['rejectTicket']>) { return this.tickets.rejectTicket(...args); }
  cancelTicket(...args: Parameters<TicketsService['cancelTicket']>) { return this.tickets.cancelTicket(...args); }
  preview(...args: Parameters<TicketsService['preview']>) { return this.tickets.preview(...args); }
  retryTicket(...args: Parameters<TicketsService['retryTicket']>) { return this.tickets.retryTicket(...args); }

  // ── analytics ──
  listAudit(...args: Parameters<AnalyticsService['listAudit']>) { return this.analytics.listAudit(...args); }
  liveStats(...args: Parameters<AnalyticsService['liveStats']>) { return this.analytics.liveStats(...args); }
  trend(...args: Parameters<AnalyticsService['trend']>) { return this.analytics.trend(...args); }
  analyticsSummary(...args: Parameters<AnalyticsService['analyticsSummary']>) { return this.analytics.analyticsSummary(...args); }
  analyticsQuery(...args: Parameters<AnalyticsService['analyticsQuery']>) { return this.analytics.analyticsQuery(...args); }
  lookupPlayer(...args: Parameters<AnalyticsService['lookupPlayer']>) { return this.analytics.lookupPlayer(...args); }
  lookupPlayerByAccountId(...args: Parameters<AnalyticsService['lookupPlayerByAccountId']>) { return this.analytics.lookupPlayerByAccountId(...args); }
  searchPlayers(...args: Parameters<AnalyticsService['searchPlayers']>) { return this.analytics.searchPlayers(...args); }
  resetPlayerPassword(...args: Parameters<AnalyticsService['resetPlayerPassword']>) { return this.analytics.resetPlayerPassword(...args); }
  listAntiCheatReviews(...args: Parameters<AnalyticsService['listAntiCheatReviews']>) { return this.analytics.listAntiCheatReviews(...args); }
  resolveAntiCheatReview(...args: Parameters<AnalyticsService['resolveAntiCheatReview']>) { return this.analytics.resolveAntiCheatReview(...args); }
  sampleOnce(...args: Parameters<AnalyticsService['sampleOnce']>) { return this.analytics.sampleOnce(...args); }

  // ── flags ──
  getConfigFlags(...args: Parameters<FlagsService['getConfigFlags']>) { return this.flags.getConfigFlags(...args); }
  getInternalFlags(...args: Parameters<FlagsService['getInternalFlags']>) { return this.flags.getInternalFlags(...args); }
  upsertFlag(...args: Parameters<FlagsService['upsertFlag']>) { return this.flags.upsertFlag(...args); }

  // ── shop ──
  getShopConfig(...args: Parameters<ShopService['getShopConfig']>) { return this.shop.getShopConfig(...args); }
  getInternalShopPrices(...args: Parameters<ShopService['getInternalShopPrices']>) { return this.shop.getInternalShopPrices(...args); }
  upsertShopItem(...args: Parameters<ShopService['upsertShopItem']>) { return this.shop.upsertShopItem(...args); }

  // ── moderation ──
  getWordlistConfig(...args: Parameters<ModerationService['getWordlistConfig']>) { return this.moderation.getWordlistConfig(...args); }
  getInternalWordlists(...args: Parameters<ModerationService['getInternalWordlists']>) { return this.moderation.getInternalWordlists(...args); }
  addWord(...args: Parameters<ModerationService['addWord']>) { return this.moderation.addWord(...args); }
  removeWord(...args: Parameters<ModerationService['removeWord']>) { return this.moderation.removeWord(...args); }

  // ── reports ──
  listReports(...args: Parameters<ReportsService['listReports']>) { return this.reports.listReports(...args); }
  resolveReport(...args: Parameters<ReportsService['resolveReport']>) { return this.reports.resolveReport(...args); }

  // ── appeals ──
  listAppeals(...args: Parameters<AppealsService['listAppeals']>) { return this.appeals.listAppeals(...args); }
  resolveAppeal(...args: Parameters<AppealsService['resolveAppeal']>) { return this.appeals.resolveAppeal(...args); }

  // ── feedback ──
  listFeedback(...args: Parameters<FeedbackService['listFeedback']>) { return this.feedback.listFeedback(...args); }
  reviewFeedback(...args: Parameters<FeedbackService['reviewFeedback']>) { return this.feedback.reviewFeedback(...args); }
}
