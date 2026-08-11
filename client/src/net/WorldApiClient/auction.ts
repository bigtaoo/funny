// Auction (auctionsvc's own contract, AUCTION_DESIGN §9).
import { getAuctionBaseUrl } from '../config';
import type { WorldApiCore } from './core';
import type { AuctionView } from './types';

/** Auction domain (see ../WorldApiClient.ts assembly + ./core.ts for the shared transport). */
export class AuctionApiService {
  constructor(private readonly core: WorldApiCore) {}

  async listAuctions(opts?: { itemType?: string; limit?: number }): Promise<AuctionView[]> {
    const params = new URLSearchParams();
    if (opts?.itemType) params.set('itemType', opts.itemType);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString() ? `?${params}` : '';
    return this.core.req('GET', `/auction/list${qs}`, undefined, 10_000, getAuctionBaseUrl());
  }

  async getMyListings(): Promise<AuctionView[]> {
    return this.core.req('GET', '/auction/mine', undefined, 10_000, getAuctionBaseUrl());
  }

  /**
   * Price guardrail band for a listing category (e.g. `material:scrap`, `equip:<defId>:<level>`), used by the
   * create-listing form to show the seller the acceptable range before submitting. Returns null when the
   * category is unguarded / cold-start (any price allowed). floor/ceil match the server's PRICE_OUT_OF_RANGE check.
   */
  async getAuctionRefBand(
    category: string
  ): Promise<{ ref: number; floor: number; ceil: number } | null> {
    return this.core.req(
      'GET',
      `/auction/refprice?category=${encodeURIComponent(category)}`,
      undefined,
      10_000,
      getAuctionBaseUrl()
    );
  }

  /**
   * Create a listing. fixed mode: pass price (buy-now unit price); auction mode: pass saleMode='auction' + startPrice (opening unit price)
   * + optional buyoutPrice (buy-now floor unit price).
   */
  async createAuction(
    itemType: 'material' | 'equipment' | 'card' | 'skin',
    item: Record<string, unknown>,
    qty: number,
    durationSec: number,
    opts?: {
      saleMode?: 'fixed' | 'auction';
      price?: number;
      startPrice?: number;
      buyoutPrice?: number;
      designatedBuyerId?: string;
    }
  ): Promise<AuctionView> {
    return this.core.req(
      'POST',
      '/auction/create',
      {
        itemType,
        item,
        qty,
        durationSec,
        saleMode: opts?.saleMode ?? 'fixed',
        ...(opts?.price != null ? { price: opts.price } : {}),
        ...(opts?.startPrice != null ? { startPrice: opts.startPrice } : {}),
        ...(opts?.buyoutPrice != null ? { buyoutPrice: opts.buyoutPrice } : {}),
        ...(opts?.designatedBuyerId ? { designatedBuyerId: opts.designatedBuyerId } : {}),
      },
      10_000,
      getAuctionBaseUrl()
    );
  }

  async buyAuction(auctionId: string): Promise<{ ok: true }> {
    return this.core.req(
      'POST',
      `/auction/${encodeURIComponent(auctionId)}/buy`,
      {},
      10_000,
      getAuctionBaseUrl()
    );
  }

  /** Place a bid (saleMode='auction'). amount = bid unit price; reaching or exceeding buyoutPrice closes the auction immediately. */
  async placeBid(auctionId: string, amount: number): Promise<AuctionView> {
    return this.core.req(
      'POST',
      `/auction/${encodeURIComponent(auctionId)}/bid`,
      { amount },
      10_000,
      getAuctionBaseUrl()
    );
  }

  async cancelAuction(auctionId: string): Promise<{ ok: true }> {
    return this.core.req(
      'POST',
      `/auction/${encodeURIComponent(auctionId)}/cancel`,
      {},
      10_000,
      getAuctionBaseUrl()
    );
  }
}
