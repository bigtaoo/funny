// commercial service core (S5-2~4): atomic wallet debit/credit + ledger + orders + gacha + recharge + ads.
// meta is the sole caller (internal trust boundary): commercial does not parse JWTs; it trusts the accountId passed by meta.
// Consistency: spend uses orderId idempotency, recharge uses receiptId idempotency; single-document $gte guard prevents overdraft.
//
// The class is split by business domain — each mixin lives in ./service/*.ts and shares the cross-cutting
// helpers (ensureWallet / credit / resolvePool / applySubscription / subscriptionCardBuy) + deps defined on
// CommercialServiceBase (./service/base.ts). To add a handler: find the matching domain mixin (or add a new
// one to the chain below) — do NOT grow this file. This is money-critical code: never change logic while moving it.
import { CommercialServiceBase } from './service/base';
import { GachaPoolMixin } from './service/gachaPool';
import { ShopMixin } from './service/shop';
import { GachaDrawMixin } from './service/gachaDraw';
import { SubscriptionMixin } from './service/subscription';
import { StarterMixin } from './service/starter';
import { RechargeMixin } from './service/recharge';
import { PromoMixin } from './service/promo';
import { RewardsMixin } from './service/rewards';
import { OrdersMixin } from './service/orders';

export type { ServiceErr, WalletView, Result, CommercialDeps, Rarity } from './service/base';

const Assembled = OrdersMixin(
  RewardsMixin(
    PromoMixin(
      RechargeMixin(
        StarterMixin(
          SubscriptionMixin(
            GachaDrawMixin(
              ShopMixin(
                GachaPoolMixin(CommercialServiceBase),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);

/**
 * CommercialService — the single object registered against every internal route (internalHttp calls svc.method(...)).
 * Assembled from the per-domain mixin chain over CommercialServiceBase.
 */
export class CommercialService extends Assembled {}
