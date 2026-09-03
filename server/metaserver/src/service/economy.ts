// Economy handlers (S5): meta orchestrates → commercial deducts/randomizes → delivery → mirror
// push-back. Shop, gacha pools/draw, fate redemption, monthly/year subscription cards, starter packs,
// rewarded ads, IAP receipt verification, and promo codes.
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md's "拆分形态的优先级"
// 形态②): holds `core: MetaCore` — assembled by composition in ../service.ts. Every handler here just
// hands `this.core` straight through to a free function living in ./economy/*.ts (2026-08-11 ctx-bind
// cleanup — see base.ts's header: the bound-`ctx`-object shape this used to build — `{ deps,
// ensureCommercial, ... }`, each member bound off `this.core` — was forced by MetaServiceBase's
// `protected` visibility, 2026-08-10 split; now that MetaCore's members are plain public methods, every
// ./economy/*.ts handler just takes `core: MetaCore` and calls `core.ensureCommercial(...)`/
// `core.mutateSave(...)`/`core.bumpRetentionTask(...)` directly — no bind, no ctx object). Applied the
// same way across all ~20 free-function files in ./economy/, ./pve/, ./liveops/, ./auth/.
// - economy/shop.ts:          getShopItems + shopBuy
// - economy/gacha.ts:         getGachaPools + gachaDraw + redeemFate (GACHA_DESIGN §2/§7)
// - economy/subscriptions.ts: monthlyCardBuy/yearCardBuy/monthlyCardClaim + claimRechargeMilestone (§5/§13)
// - economy/starter.ts:       starterBuy (§6)
// - economy/adsPromo.ts:      adsReward + iapVerify + redeemPromoCode
import type { MetaHandlers } from '../generated/routes.gen.js';
import { type MetaCore } from './base.js';
import { getShopItemsHandler, shopBuyHandler } from './economy/shop.js';
import { getGachaPoolsHandler, gachaDrawHandler, redeemFateHandler } from './economy/gacha.js';
import {
  monthlyCardBuyHandler,
  yearCardBuyHandler,
  monthlyCardClaimHandler,
  claimRechargeMilestoneHandler,
  iapAppleSyncHandler,
} from './economy/subscriptions.js';
import { starterBuyHandler } from './economy/starter.js';
import { adsRewardHandler, iapVerifyHandler, redeemPromoCodeHandler } from './economy/adsPromo.js';

type EconomyHandlers = Pick<
  MetaHandlers,
  | 'getShopItems' | 'getGachaPools' | 'shopBuy' | 'gachaDraw' | 'redeemFate'
  | 'monthlyCardBuy' | 'yearCardBuy' | 'monthlyCardClaim' | 'claimRechargeMilestone' | 'starterBuy'
  | 'adsReward' | 'iapVerify' | 'iapAppleSync' | 'redeemPromoCode'
>;

export class EconomyService {
  constructor(private readonly core: MetaCore) {}

    async getShopItems(...args: Parameters<EconomyHandlers['getShopItems']>) {
      return getShopItemsHandler(this.core.deps, args[0]);
    }

    async shopBuy(...args: Parameters<EconomyHandlers['shopBuy']>) {
      return shopBuyHandler(this.core, ...args);
    }

    async getGachaPools() {
      return getGachaPoolsHandler(this.core.deps);
    }

    async gachaDraw(...args: Parameters<EconomyHandlers['gachaDraw']>) {
      return gachaDrawHandler(this.core, ...args);
    }

    async redeemFate(...args: Parameters<EconomyHandlers['redeemFate']>) {
      return redeemFateHandler(this.core, ...args);
    }

    async monthlyCardBuy(...args: Parameters<EconomyHandlers['monthlyCardBuy']>) {
      return monthlyCardBuyHandler(this.core, ...args);
    }

    async yearCardBuy(...args: Parameters<EconomyHandlers['yearCardBuy']>) {
      return yearCardBuyHandler(this.core, ...args);
    }

    async monthlyCardClaim(...args: Parameters<EconomyHandlers['monthlyCardClaim']>) {
      return monthlyCardClaimHandler(this.core, ...args);
    }

    async claimRechargeMilestone(...args: Parameters<EconomyHandlers['claimRechargeMilestone']>) {
      return claimRechargeMilestoneHandler(this.core, ...args);
    }

    async starterBuy(...args: Parameters<EconomyHandlers['starterBuy']>) {
      return starterBuyHandler(this.core, ...args);
    }

    async adsReward(...args: Parameters<EconomyHandlers['adsReward']>) {
      return adsRewardHandler(this.core, ...args);
    }

    async iapVerify(...args: Parameters<EconomyHandlers['iapVerify']>) {
      return iapVerifyHandler(this.core, ...args);
    }

    async iapAppleSync(...args: Parameters<EconomyHandlers['iapAppleSync']>) {
      return iapAppleSyncHandler(this.core, ...args);
    }

    async redeemPromoCode(...args: Parameters<EconomyHandlers['redeemPromoCode']>) {
      return redeemPromoCodeHandler(this.core, ...args);
    }
}
