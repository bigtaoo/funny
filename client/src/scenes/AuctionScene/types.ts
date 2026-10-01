// AuctionScene shared types + constants — split out of core.ts (2026-08-11 composition conversion)
// purely to bring core.ts back under the 500-line convention once the domain classes moved out; see
// claudedocs/client-modules.md's split-form priority note. core.ts re-exports everything from here
// (`export * from './types'`) so existing `from './core'` import paths (and the legacy `from './base'`
// callers, now updated to './core') keep resolving unchanged.
import { typeWidth } from '../../render/fontScale';
import type { WorldApiClient, AuctionBidView, AuctionView } from '../../net/WorldApiClient';
import type { SaveData } from '../../game/meta/SaveData';
import type { IPlatform } from '../../platform/IPlatform';

export interface AuctionSceneCallbacks {
  onBack(): void;
  /** Free-text entry surface (ASSET_PACKAGING §4.3/§4.4 item 1) — see IPlatform.openTextInput. */
  openTextInput: IPlatform['openTextInput'];
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
   * Current account id — marks my own listings in the Market tab (passive "your listing" marker instead
   * of a dead Buy/Bid button) and flags a designated-buyer listing as exclusive to me. Optional.
   *
   * NOT what drives the My Bids tab any more: that used to be derived client-side by filtering the market
   * list on `topBid.bidderId === myAccountId`, which by construction could only ever show listings I was
   * LEADING — the moment someone outbid me the listing vanished from the tab. It now comes from
   * `/auction/myBids` (server-side bid records), see core.myBids.
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
//
// 200, not 180 (2026-09-12): an auction-mode listing's info column is name + current bid (two
// lines in portrait's 167-px column) + buyout + countdown, and the countdown — the LAST line, and
// the one the cell has no way to absorb — ended 10 design px inside the action button's band, so
// the button's fill sliced through its bottom row of pixels. Under the sweep's `covered` threshold
// in every language, which is why it survived nine viewports of green: found by reading the
// screenshots (§50.13). 20 px is what the measurement asked for, and it is the whole of the fix —
// the cell is top-anchored, so everything above the button is exactly where it was.
export const AUC_CELL_H = 200;
export const AUC_CELL_W_TARGET = 340;

/** Breathing room inside a cell, and the gap between the item picture and the info column. */
export const AUC_CELL_PAD = 14;
export const AUC_CELL_IMG_GAP = 16;
/** Cap on the square item picture, so a tall cell does not crowd out the info column beside it. */
export const AUC_CELL_IMG_MAX = 130;
/** The picture a cell gets when nothing squeezes it — the cap, or the cell height minus padding. */
const AUC_CELL_IMG_FULL = Math.min(AUC_CELL_H - AUC_CELL_PAD * 2, AUC_CELL_IMG_MAX);
/** Smallest picture a phone's two-column grid may shrink it to (see `aucGrid`). */
export const AUC_CELL_IMG_MIN = 90;
/** The info column's share of {@link AUC_CELL_W_TARGET} at the full picture — 166 design px. */
const AUC_CELL_TEXT_W = AUC_CELL_W_TARGET - AUC_CELL_PAD * 2 - AUC_CELL_IMG_FULL - AUC_CELL_IMG_GAP;

/**
 * Columns the grid fits into `contentW`, and the width of one cell — `ListPanel.renderList`'s own
 * arithmetic, lifted here so it can be read without PIXI.
 */
export function aucGrid(contentW: number): { cols: number; cellW: number } {
  const avail = contentW - AUC_CELL_GAP * 2;
  // typeWidth: the target was tuned for the raw font table; on a phone the boosted text needs a
  // proportionally wider column, so the grid drops a column rather than overflow (see fontScale).
  const colsFor = (target: number): number =>
    Math.max(1, Math.floor((avail + AUC_CELL_GAP) / (target + AUC_CELL_GAP)));
  let cols = colsFor(typeWidth(AUC_CELL_W_TARGET));
  // Boosting the whole 340 is generous — only the TEXT part of the cell grows with the boost, the
  // picture and padding are fixed design px — and on the 720–860-wide portrait design
  // (layout/designSize.ts) it dropped the grid to ONE column of half-empty cells. So where that
  // happens (and only there: every other width keeps the column count it always had), boost just
  // the text, and if that still is one column let the picture shrink toward AUC_CELL_IMG_MIN
  // (aucImgSize hands the cell the picture its width leaves).
  const fixed = (img: number): number => AUC_CELL_PAD * 2 + img + AUC_CELL_IMG_GAP;
  if (cols === 1) cols = colsFor(fixed(AUC_CELL_IMG_FULL) + typeWidth(AUC_CELL_TEXT_W));
  if (cols === 1) cols = colsFor(fixed(AUC_CELL_IMG_MIN) + typeWidth(AUC_CELL_TEXT_W));
  return { cols, cellW: (avail - AUC_CELL_GAP * (cols - 1)) / cols };
}

/**
 * Side of the square item picture in a cell `cellW` wide: the full {@link AUC_CELL_IMG_FULL}, unless
 * that would leave the info column narrower than its (boosted) text target — then whatever the text
 * leaves, down to {@link AUC_CELL_IMG_MIN}. At the unboosted target every cell is at least 340 wide,
 * so desktop and tablets always get the full picture.
 */
export function aucImgSize(cellW: number): number {
  const room = Math.floor(cellW - AUC_CELL_PAD * 2 - AUC_CELL_IMG_GAP - typeWidth(AUC_CELL_TEXT_W));
  return Math.max(AUC_CELL_IMG_MIN, Math.min(AUC_CELL_IMG_FULL, room));
}

/**
 * The info column a cell of `cellW` leaves to the right of its item picture — the wrap width every
 * line of name/price/my-bid/buyout/countdown is measured against (`renderAuctionCell`'s `rightW`).
 *
 * Exported because it is a CONTRACT on the translations, not just a local: three of those lines
 * must fit it on ONE line in every locale or the countdown is pushed onto the cell's bottom-right
 * badge (§55.2). `test/auctionCellInfoWidth.test.ts` is the gate, and it has to measure the real
 * column rather than a copy of this arithmetic that can drift away from it.
 */
export function aucInfoColumnW(cellW: number): number {
  return cellW - AUC_CELL_PAD * 2 - aucImgSize(cellW) - AUC_CELL_IMG_GAP;
}

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

// Same idea for My Bids. The listing half alone isn't enough: `outcome` flips leading→outbid on someone
// else's bid (which does move `price`, so that part is covered) but also won→lost at settlement, and my
// own `myBid` changes when I raise — neither of which auctionSig would see, since a bid row's listing may
// not even be in the market list any more once it closes.
export function bidSig(list: AuctionBidView[]): string {
  return list.map((b) => `${b.auction.auctionId}:${b.auction.price}:${b.auction.status}:${b.auction.expireAt}:${b.myBid}:${b.outcome}`).join(',');
}
