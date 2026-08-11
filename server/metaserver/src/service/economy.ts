// Economy handlers (S5): meta orchestrates → commercial deducts/randomizes → delivery → mirror
// push-back. Shop, gacha pools/draw, fate redemption, monthly/year subscription cards, starter packs,
// rewarded ads, IAP receipt verification, and promo codes.
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md's "拆分形态的优先级"
// 形态②): holds `core: MetaCore` — assembled by composition in ../service.ts. Every handler still
// binds a small `ctx` object (`{ deps, ensureCommercial, ... }`, now sourced from `this.core` instead
// of the old inherited `this`) and hands it to a free function living in ./economy/*.ts — this
// ctx-bind shape was originally forced by MetaServiceBase's `protected` visibility (2026-08-10 split);
// now that MetaCore's methods are plain public members, the ctx-bind is no longer structurally
// necessary and could be simplified to passing `core` directly — left as a documented follow-up rather
// than done in this batch, since it would mean touching all ~20 free-function files in ./economy/,
// ./pve/, ./liveops/, ./auth/ for a purely internal cleanup with zero external behavior change.
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
} from './economy/subscriptions.js';
import { starterBuyHandler } from './economy/starter.js';
import { adsRewardHandler, iapVerifyHandler, redeemPromoCodeHandler } from './economy/adsPromo.js';

type EconomyHandlers = Pick<
  MetaHandlers,
  | 'getShopItems' | 'getGachaPools' | 'shopBuy' | 'gachaDraw' | 'redeemFate'
  | 'monthlyCardBuy' | 'yearCardBuy' | 'monthlyCardClaim' | 'claimRechargeMilestone' | 'starterBuy'
  | 'adsReward' | 'iapVerify' | 'redeemPromoCode'
>;

export class EconomyService {
  constructor(private readonly core: MetaCore) {}

    async getShopItems(...args: Parameters<EconomyHandlers['getShopItems']>) {
      return getShopItemsHandler(this.core.deps, args[0]);
    }

    async shopBuy(...args: Parameters<EconomyHandlers['shopBuy']>) {
      return shopBuyHandler({ deps: this.core.deps, ensureCommercial: this.core.ensureCommercial.bind(this.core) }, ...args);
    }

    async getGachaPools() {
      return getGachaPoolsHandler(this.core.deps);
    }

    async gachaDraw(...args: Parameters<EconomyHandlers['gachaDraw']>) {
      return gachaDrawHandler(
        {
          deps: this.core.deps,
          ensureCommercial: this.core.ensureCommercial.bind(this.core),
          bumpRetentionTask: this.core.bumpRetentionTask.bind(this.core),
        },
        ...args,
      );
    }

    async redeemFate(...args: Parameters<EconomyHandlers['redeemFate']>) {
      return redeemFateHandler({ deps: this.core.deps, ensureCommercial: this.core.ensureCommercial.bind(this.core) }, ...args);
    }

    async monthlyCardBuy(...args: Parameters<EconomyHandlers['monthlyCardBuy']>) {
      return monthlyCardBuyHandler({ deps: this.core.deps, ensureCommercial: this.core.ensureCommercial.bind(this.core) }, ...args);
    }

    async yearCardBuy(...args: Parameters<EconomyHandlers['yearCardBuy']>) {
      return yearCardBuyHandler({ deps: this.core.deps, ensureCommercial: this.core.ensureCommercial.bind(this.core) }, ...args);
    }

    async monthlyCardClaim(...args: Parameters<EconomyHandlers['monthlyCardClaim']>) {
      return monthlyCardClaimHandler({ deps: this.core.deps, ensureCommercial: this.core.ensureCommercial.bind(this.core) }, ...args);
    }

    async claimRechargeMilestone(...args: Parameters<EconomyHandlers['claimRechargeMilestone']>) {
      return claimRechargeMilestoneHandler(
        {
          deps: this.core.deps,
          ensureCommercial: this.core.ensureCommercial.bind(this.core),
          mutateSave: this.core.mutateSave.bind(this.core),
        },
        ...args,
      );
    }

    async starterBuy(...args: Parameters<EconomyHandlers['starterBuy']>) {
      return starterBuyHandler({ deps: this.core.deps, ensureCommercial: this.core.ensureCommercial.bind(this.core) }, ...args);
    }

    async adsReward(...args: Parameters<EconomyHandlers['adsReward']>) {
      return adsRewardHandler({ deps: this.core.deps, ensureCommercial: this.core.ensureCommercial.bind(this.core) }, ...args);
    }

    async iapVerify(...args: Parameters<EconomyHandlers['iapVerify']>) {
      return iapVerifyHandler({ deps: this.core.deps, ensureCommercial: this.core.ensureCommercial.bind(this.core) }, ...args);
    }

    async redeemPromoCode(...args: Parameters<EconomyHandlers['redeemPromoCode']>) {
      return redeemPromoCodeHandler({ deps: this.core.deps, ensureCommercial: this.core.ensureCommercial.bind(this.core) }, ...args);
    }
}
