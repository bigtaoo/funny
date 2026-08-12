// SLG shop (monetization S8-8).
import type { WorldApiCore } from './core';
import type { SlgShopItemView, PlayerWorldView } from './types';

/** SLG shop domain (see ../WorldApiClient.ts assembly + ./core.ts for the shared transport). */
export class SlgShopService {
  constructor(private readonly core: WorldApiCore) {}

  async getShopItems(): Promise<SlgShopItemView[]> {
    return this.core.req('GET', '/world/shop/items');
  }

  /** Returns the updated player world state (P1-3: was mis-declared as bare {ok:true} — the server
   *  always returned the full PlayerWorldView, so the caller can adopt it directly instead of a
   *  separate GET /world/me). */
  async buyShopItem(worldId: string, itemId: string): Promise<PlayerWorldView> {
    return this.core.req('POST', '/world/shop/buy', { worldId, itemId });
  }
}
