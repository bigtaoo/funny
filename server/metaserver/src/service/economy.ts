// Economy handlers (S5): meta orchestrates → commercial deducts/randomizes → delivery → mirror
// push-back. Shop, gacha pools/draw, fate redemption, monthly/year subscription cards, starter packs,
// rewarded ads, IAP receipt verification, and promo codes — mixin facade.
//
// Split into independent function modules (2026-08-10, 独立函数模块 form, pve.ts/liveops.ts's sibling —
// same "already in the mixin chain but grown fat" case from claudedocs/server.md's priority doc:
// every handler needs one or more of `this.ensureCommercial`/`this.mutateSave`/`this.bumpRetentionTask`,
// all `protected` on MetaServiceBase, so a sibling class outside the mixin's own inheritance chain has
// no structural way to call them (TS rejects assigning a `protected` member to any wider/interface-shaped
// type, from any scope — see pve.ts's facade comment for the full explanation). Free functions sidestep
// this entirely: EconomyMixin's class body — which DOES have inherited access — reads `this.deps` and
// `.bind(this)`s the handful of protected methods each handler needs into a plain `ctx` object, then
// hands that `ctx` to a free function living outside the class. The one private helper that only ever
// touched `this.deps` (`reconcileRechargeCoins`) became a plain deps-parameterized function with no ctx
// needed at all (economy/subscriptions.ts). No behavior change: every method body was moved verbatim.
// - economy/shop.ts:          getShopItems + shopBuy
// - economy/gacha.ts:         getGachaPools + gachaDraw + redeemFate (GACHA_DESIGN §2/§7)
// - economy/subscriptions.ts: monthlyCardBuy/yearCardBuy/monthlyCardClaim + claimRechargeMilestone (§5/§13)
// - economy/starter.ts:       starterBuy (§6)
// - economy/adsPromo.ts:      adsReward + iapVerify + redeemPromoCode
import type { MetaHandlers } from '../generated/routes.gen.js';
import { type Constructor, type MetaBaseCtor } from './base.js';
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

export function EconomyMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<EconomyHandlers> {
  return class extends Base {
    async getShopItems(...args: Parameters<EconomyHandlers['getShopItems']>) {
      return getShopItemsHandler(this.deps, args[0]);
    }

    async shopBuy(...args: Parameters<EconomyHandlers['shopBuy']>) {
      return shopBuyHandler({ deps: this.deps, ensureCommercial: this.ensureCommercial.bind(this) }, ...args);
    }

    async getGachaPools() {
      return getGachaPoolsHandler(this.deps);
    }

    async gachaDraw(...args: Parameters<EconomyHandlers['gachaDraw']>) {
      return gachaDrawHandler(
        {
          deps: this.deps,
          ensureCommercial: this.ensureCommercial.bind(this),
          bumpRetentionTask: this.bumpRetentionTask.bind(this),
        },
        ...args,
      );
    }

    async redeemFate(...args: Parameters<EconomyHandlers['redeemFate']>) {
      return redeemFateHandler({ deps: this.deps, ensureCommercial: this.ensureCommercial.bind(this) }, ...args);
    }

    async monthlyCardBuy(...args: Parameters<EconomyHandlers['monthlyCardBuy']>) {
      return monthlyCardBuyHandler({ deps: this.deps, ensureCommercial: this.ensureCommercial.bind(this) }, ...args);
    }

    async yearCardBuy(...args: Parameters<EconomyHandlers['yearCardBuy']>) {
      return yearCardBuyHandler({ deps: this.deps, ensureCommercial: this.ensureCommercial.bind(this) }, ...args);
    }

    async monthlyCardClaim(...args: Parameters<EconomyHandlers['monthlyCardClaim']>) {
      return monthlyCardClaimHandler({ deps: this.deps, ensureCommercial: this.ensureCommercial.bind(this) }, ...args);
    }

    async claimRechargeMilestone(...args: Parameters<EconomyHandlers['claimRechargeMilestone']>) {
      return claimRechargeMilestoneHandler(
        {
          deps: this.deps,
          ensureCommercial: this.ensureCommercial.bind(this),
          mutateSave: this.mutateSave.bind(this),
        },
        ...args,
      );
    }

    async starterBuy(...args: Parameters<EconomyHandlers['starterBuy']>) {
      return starterBuyHandler({ deps: this.deps, ensureCommercial: this.ensureCommercial.bind(this) }, ...args);
    }

    async adsReward(...args: Parameters<EconomyHandlers['adsReward']>) {
      return adsRewardHandler({ deps: this.deps, ensureCommercial: this.ensureCommercial.bind(this) }, ...args);
    }

    async iapVerify(...args: Parameters<EconomyHandlers['iapVerify']>) {
      return iapVerifyHandler({ deps: this.deps, ensureCommercial: this.ensureCommercial.bind(this) }, ...args);
    }

    async redeemPromoCode(...args: Parameters<EconomyHandlers['redeemPromoCode']>) {
      return redeemPromoCodeHandler({ deps: this.deps, ensureCommercial: this.ensureCommercial.bind(this) }, ...args);
    }
  };
}
