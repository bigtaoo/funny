// AuctionScene shared types + constants — split out of core.ts (2026-08-11 composition conversion)
// purely to bring core.ts back under the 500-line convention once the domain classes moved out; see
// claudedocs/client-modules.md's split-form priority note. core.ts re-exports everything from here
// (`export * from './types'`) so existing `from './core'` import paths (and the legacy `from './base'`
// callers, now updated to './core') keep resolving unchanged.
import type { WorldApiClient, AuctionView } from '../../net/WorldApiClient';
import type { SaveData } from '../../game/meta/SaveData';

export interface AuctionSceneCallbacks {
  onBack(): void;
  worldApi: WorldApiClient;
  /**
   * Read the current authoritative save — source for the equipment/card listing picker
   * (equipmentInv / cardInv). Optional: without it, only material listing is offered.
   */
  getSave?(): SaveData;
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene changes the save. Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
  /**
   * Re-pull the authoritative save after an equipment/card listing (the server escrows the
   * instance, removing it from inventory). Optional; no-op when absent (e.g. tests).
   */
  reloadSave?(): Promise<void>;
  /**
   * Current account id — used to derive "My Bids" (auctions I'm the current top bidder on)
   * client-side from the already-loaded market list. Optional; without it the tab is empty.
   */
  myAccountId?: string;
}

export type AucTab = 'all' | 'mine' | 'bids';
export type ItemClass = 'material' | 'equipment' | 'card' | 'skin';

export const HUD_H = 50;
// 1.5x the original 44 — approved 15.07.2026 category-bar enlargement pass.
export const FILTER_H = 66;

// Auction market grid: card cells (mirrors CardScene's roster-card treatment — a framed item glyph
// on the left, info stacked to the right) instead of thin list rows.
export const AUC_CELL_GAP = 14;
// Compact card height — the 285 from the 15.07.2026 1.5x pass left a large dead gap between the
// price block and the bottom-pinned countdown/buy row (16.07.2026 report: "看起来太乱了"). Shrunk
// back down so content and the bottom row sit close together, with more rows visible per screen.
export const AUC_CELL_H = 180;
export const AUC_CELL_W_TARGET = 340;

// Material types available for auction
export const MATERIALS = ['scrap', 'lead', 'binding'] as const;
// Fixed listing duration — must match server-side AUCTION_DURATIONS_SEC (shared/slg/auction.ts),
// otherwise createAuction throws BAD_REQUEST. No longer user-selectable (all listings run 72h).
export const AUCTION_DURATION_SEC = 72 * 3600;
// Category filter for the market tab — matches AuctionView.itemType ('' = no filter).
export const FILTERS = ['', 'material', 'equipment', 'card', 'skin'] as const;
export type AucFilter = typeof FILTERS[number];

// Background-poll cadence. auctionsvc is a pure REST service with no push channel (own DB, port 18086,
// not wired into the gateway), so the open market goes stale the moment another player buys/bids/lists.
// We mirror WorldMapNet's setInterval refresh — but off the scene's own update(dt) tick so it stops
// automatically on destroy — to re-pull every few seconds. See core.ts's loadData / pollRefresh.
export const AUCTION_POLL_SEC = 5;

// Lightweight change-signature for a listing set: re-render on a poll only when something visible
// actually changed (item sold/removed, new bid → price change, expiry, new listing), so an unchanged
// market doesn't tear down and rebuild the body (which would fight scrolling) every 5s.
export function auctionSig(list: AuctionView[]): string {
  return list.map((a) => `${a.auctionId}:${a.price}:${a.status}:${a.expireAt}:${a.buyerId ?? ''}`).join(',');
}
