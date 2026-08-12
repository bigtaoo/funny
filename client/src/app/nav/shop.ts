// Shop / IAP recharge / gacha / daily / events / battle pass navigation.
// Split into three form① modules (2026-08-12, see claudedocs/client-modules.md):
// - shop/badges.ts: shopCardBadgeClaimable/battlePassBadgeClaimable/rechargeBadgeClaimable (pure, explicit params)
// - shop/iap.ts: createShopIap(ctx) — doRechargeCoins/doBuySubscription/doBuyStarter + private polling helpers
// - shop/nav.ts: createShopNav(ctx) — goShop/goGacha/goDaily/goEvents/goBattlePass/goRecharge
// This file just re-exports createShopNav so existing imports (`from './nav/shop'`) keep working.
export { createShopNav } from './shop/nav';
