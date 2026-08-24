// Auction service business layer (auction task 4, migrated from server/worldsvc/src/auctionService.ts).
// Tradeable items: materials (scrap/lead/binding, stock in meta SaveData.materials), equipment, character cards, skins.
// SLG season resources (ink/paper/graphite/metal/sticker) are NOT tradeable — they never went through the auction house.
// Currency: coins (premium, charged/paid via commercial); tax rate 10% (AUCTION_TAX_RATE).
// Expiry: expireAt plain index + scanner (not TTL auto-delete — requires settlement/refund to seller or auction close on expire).
// AUCTION_DESIGN §9 (2026-07-06 ruling): auction is an account-scoped, server-wide market — no worldId, no season lifecycle coupling.
// The end-of-season freeze/liquidation gate (F, formerly assertWorldAcceptsListings/clearWorldOnReset) has been dropped entirely.
//
// Anti-RMT gates (AUCTION_DESIGN §4):
//   C Daily caps (listing/purchase counts) — auctionDaily counter + TTL auto-clear
//   E Bound-material block — AUCTION_BANNED_MATERIALS
//   G Price guardrail — dynamic sliding-window refPrice + range check (falls back to static values on cold start)
//   B Auction bidding — saleMode='auction': start price / increment / escrow / anti-snipe / settle on expire
//
// AuctionService was a single ~925-line class (925 → shell + 7 files, 2026-08-09 split as a linear
// inheritance chain). Re-audited 2026-08-11 against claudedocs/server.md's split-priority doc (the
// same pass that converted 6 other zero-cross-call chains to composition): unlike those 6,
// AuctionService's chain has REAL cross-layer calls — create.ts and trade.ts both call pricing.ts's
// methods, and trade.ts also calls delivery.ts's — but they form a clean one-directional DAG (no
// cycles), so composition still applies cleanly, just with two of the six siblings taking a
// constructor-injected reference to another instead of standing fully alone:
//   auctionService/base.ts        (types + AuctionServiceDeps + doc↔view mapping helpers — the DAG's implicit root, no class of its own)
//   auctionService/pricing.ts     AuctionServicePricing  C daily caps (bumpDaily) + G price guardrail (refPrice/checkPriceGuard/getRefBand/recordSoldPrice) — depends on nothing
//   auctionService/delivery.ts    AuctionServiceDelivery system-mail delivery (deliverItem/deliverCoins) — depends on nothing; owned by journalSteps.ts, no longer a facade field
//   auctionService/listing.ts     AuctionServiceListing  read-only queries: listAuctions/queryListings/getMyListings/purgeClosedListings — depends on nothing
//   auctionService/journalPlans.ts                       (free functions) every idempotency key + every flow's plan — depends on nothing
//   auctionService/journalSteps.ts AuctionOrderStepRunner the ONLY place a cross-service asset call happens — depends on delivery
//   auctionService/journal.ts     AuctionOrderJournal    the settlement journal engine (begin/advance/decide/finalize/rollback) — depends on journalSteps + journalPlans
//   auctionService/journalSweep.ts AuctionServiceJournalSweep scheduler-driven resume + repair passes — depends on journal + journalPlans
//   auctionService/create.ts      AuctionServiceCreate   createAuction (+ cap-reject rollback) — depends on pricing AND journal
//   auctionService/trade.ts       AuctionServiceTrade    buyAuction/placeBid/settleAuctionWin/cancelAuction/processExpiredAuctions — depends on pricing AND journal
//   auctionService/audit.ts       AuctionServiceAudit    D/G7 anomaly audit scan (scanAnomalies) — depends on nothing
//
// 2026-08-24 (U13 close-out): the four journal files above are new, and `delivery.ts` moved from "called
// by trade.ts" to "called only by journalSteps.ts". See journal.ts for why a journal rather than a Mongo
// transaction (the atomicity boundary spans three processes and four databases).
// No behavior change: every method body is unchanged aside from `this.xxx()` → `this.pricing.xxx()`/
// `this.delivery.xxx()` at the two real cross-layer call sites, and `protected` → public visibility
// on the handful of methods those two call sites reach (bumpDaily/checkPriceGuard/recordSoldPrice/
// deliverItem/deliverCoins).
export { type AuctionView, type AuctionServiceDeps } from './auctionService/base';
import type { AuctionServiceDeps } from './auctionService/base';
import { AuctionServicePricing } from './auctionService/pricing';
import { AuctionServiceListing } from './auctionService/listing';
import { AuctionOrderJournal } from './auctionService/journal';
import { AuctionServiceJournalSweep } from './auctionService/journalSweep';
import { AuctionServiceCreate } from './auctionService/create';
import { AuctionServiceTrade } from './auctionService/trade';
import { AuctionServiceAudit } from './auctionService/audit';

/** The full service, composed from the six concern layers above. */
export class AuctionService {
  private readonly pricing: AuctionServicePricing;
  private readonly listing: AuctionServiceListing;
  private readonly journal: AuctionOrderJournal;
  private readonly journalSweep: AuctionServiceJournalSweep;
  private readonly create: AuctionServiceCreate;
  private readonly trade: AuctionServiceTrade;
  private readonly audit: AuctionServiceAudit;

  constructor(deps: AuctionServiceDeps) {
    this.pricing = new AuctionServicePricing(deps);
    this.listing = new AuctionServiceListing(deps);
    this.journal = new AuctionOrderJournal(deps);
    this.journalSweep = new AuctionServiceJournalSweep(deps, this.journal);
    this.create = new AuctionServiceCreate(deps, this.pricing, this.journal);
    this.trade = new AuctionServiceTrade(deps, this.pricing, this.journal);
    this.audit = new AuctionServiceAudit(deps);
  }

  // ── pricing ──
  getRefBand(...args: Parameters<AuctionServicePricing['getRefBand']>) { return this.pricing.getRefBand(...args); }

  // ── listing ──
  listAuctions(...args: Parameters<AuctionServiceListing['listAuctions']>) { return this.listing.listAuctions(...args); }
  queryListings(...args: Parameters<AuctionServiceListing['queryListings']>) { return this.listing.queryListings(...args); }
  getMyListings(...args: Parameters<AuctionServiceListing['getMyListings']>) { return this.listing.getMyListings(...args); }
  purgeClosedListings(...args: Parameters<AuctionServiceListing['purgeClosedListings']>) { return this.listing.purgeClosedListings(...args); }

  // ── create ──
  createAuction(...args: Parameters<AuctionServiceCreate['createAuction']>) { return this.create.createAuction(...args); }

  // ── trade ──
  buyAuction(...args: Parameters<AuctionServiceTrade['buyAuction']>) { return this.trade.buyAuction(...args); }
  placeBid(...args: Parameters<AuctionServiceTrade['placeBid']>) { return this.trade.placeBid(...args); }
  cancelAuction(...args: Parameters<AuctionServiceTrade['cancelAuction']>) { return this.trade.cancelAuction(...args); }
  processExpiredAuctions(...args: Parameters<AuctionServiceTrade['processExpiredAuctions']>) { return this.trade.processExpiredAuctions(...args); }

  // ── settlement journal ──
  /** Resume interrupted settlements + repair listings that closed without handing anything over (scheduler tick). */
  sweepSettlements(...args: Parameters<AuctionServiceJournalSweep['sweep']>) { return this.journalSweep.sweep(...args); }

  // ── audit ──
  scanAnomalies(...args: Parameters<AuctionServiceAudit['scanAnomalies']>) { return this.audit.scanAnomalies(...args); }
}
