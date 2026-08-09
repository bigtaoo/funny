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
// AuctionService was a single ~925-line class (925 → shell + 7 files, 2026-08-09 split). Same
// "linear inheritance chain" convention as worldsvc's WorldCore / metaserver's MarchService —
// see claudedocs/server.md — one file per concern layer under ./auctionService/, no `this.xxx`
// call site changes, the composed class is identical:
//   auctionService/base.ts     AuctionServiceBase     deps + AuctionView/AuctionServiceDeps types + doc↔view mapping helpers
//   auctionService/pricing.ts  AuctionServicePricing  C daily caps (bumpDaily) + G price guardrail (refPrice/checkPriceGuard/getRefBand/recordSoldPrice)
//   auctionService/delivery.ts AuctionServiceDelivery system-mail delivery (deliverItem/deliverCoins)
//   auctionService/listing.ts  AuctionServiceListing  read-only queries: listAuctions/queryListings/getMyListings/purgeClosedListings
//   auctionService/create.ts   AuctionServiceCreate   createAuction (+ cap-reject rollback)
//   auctionService/trade.ts    AuctionServiceTrade    buyAuction/placeBid/settleAuctionWin/cancelAuction/processExpiredAuctions
//   auctionService/audit.ts    AuctionServiceAudit    D/G7 anomaly audit scan (scanAnomalies)
export { type AuctionView, type AuctionServiceDeps } from './auctionService/base';
import { AuctionServiceAudit } from './auctionService/audit';

/** The full service, composed from the concern layers above. */
export class AuctionService extends AuctionServiceAudit {}
