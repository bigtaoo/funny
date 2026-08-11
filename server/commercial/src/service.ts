// commercial service core (S5-2~4): atomic wallet debit/credit + ledger + orders + gacha + recharge + ads.
// meta is the sole caller (internal trust boundary): commercial does not parse JWTs; it trusts the accountId passed by meta.
// Consistency: spend uses orderId idempotency, recharge uses receiptId idempotency; single-document $gte guard prevents overdraft.
//
// The service is composed by holding one independent sibling instance per business domain — each takes
// `WalletCore` (./service/base.ts — the cross-cutting wallet primitives: ensureWallet / credit /
// resolvePool / applySubscription / subscriptionCardBuy) in its constructor. No shared base CLASS, no
// mixin chain (2026-08-11: converted from the `XMixin(Base)` chain per claudedocs/server.md's "拆分
// 形态的优先级" 形态②/独立类+组合 — WalletCore was already the DAG's root (documented as such when it
// was split out of ./service/base.ts on 2026-08-10), so this batch just finishes the job: 10 domains
// that never called each other, all only depending on the same WalletCore). `CommercialService`'s own
// constructor keeps the pre-existing `(...args: any[])` signature (matching CommercialServiceBase's old
// unsound `args[0] as CommercialDeps` cast) rather than a strongly-typed `(deps: CommercialDeps)` —
// several test fixtures construct it with intentionally-partial deps objects (only the fields that test
// actually exercises), which only compiles because the parameter type was never checked; tightening it
// here would be a new tsc error unrelated to this refactor. To add a handler: find the matching domain
// class (or add a new one) — do NOT grow this file. This is money-critical code: never change logic
// while moving it.
import { WalletCore, type CommercialDeps } from './service/base';
import { GachaPoolService } from './service/gachaPool';
import { ShopService } from './service/shop';
import { GachaDrawService } from './service/gachaDraw';
import { SubscriptionService } from './service/subscription';
import { StarterService } from './service/starter';
import { RechargeService } from './service/recharge';
import { PromoService } from './service/promo';
import { RewardsService } from './service/rewards';
import { OrdersService } from './service/orders';
import { AuditService } from './service/audit';

export type { ServiceErr, WalletView, Result, CommercialDeps, Rarity } from './service/base';
export type { CoinGainRow } from './service/audit';

/**
 * CommercialService — the single object registered against every internal route (internalHttp calls svc.method(...)).
 * Composed from 10 independent sibling domain classes, each sharing one `WalletCore`.
 */
export class CommercialService {
  private readonly core: WalletCore;
  private readonly gachaPool: GachaPoolService;
  private readonly shop: ShopService;
  private readonly gachaDrawSvc: GachaDrawService;
  private readonly subscription: SubscriptionService;
  private readonly starter: StarterService;
  private readonly recharge: RechargeService;
  private readonly promo: PromoService;
  private readonly rewards: RewardsService;
  private readonly orders: OrdersService;
  private readonly audit: AuditService;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    const deps = args[0] as CommercialDeps;
    this.core = new WalletCore(deps);
    this.gachaPool = new GachaPoolService(this.core);
    this.shop = new ShopService(this.core);
    this.gachaDrawSvc = new GachaDrawService(this.core);
    this.subscription = new SubscriptionService(this.core);
    this.starter = new StarterService(this.core);
    this.recharge = new RechargeService(this.core);
    this.promo = new PromoService(this.core);
    this.rewards = new RewardsService(this.core);
    this.orders = new OrdersService(this.core);
    this.audit = new AuditService(this.core);
  }

  /** GET /internal/wallet — the one WalletCore method called directly (not through a domain). */
  getWallet(...args: Parameters<WalletCore['getWallet']>) { return this.core.getWallet(...args); }

  // ── gachaPool ──
  createLimitedPool(...args: Parameters<GachaPoolService['createLimitedPool']>) { return this.gachaPool.createLimitedPool(...args); }
  createCustomPool(...args: Parameters<GachaPoolService['createCustomPool']>) { return this.gachaPool.createCustomPool(...args); }
  closeLimitedPool(...args: Parameters<GachaPoolService['closeLimitedPool']>) { return this.gachaPool.closeLimitedPool(...args); }
  listLimitedPools(...args: Parameters<GachaPoolService['listLimitedPools']>) { return this.gachaPool.listLimitedPools(...args); }
  listActiveLimitedPools(...args: Parameters<GachaPoolService['listActiveLimitedPools']>) { return this.gachaPool.listActiveLimitedPools(...args); }

  // ── shop ──
  shopCharge(...args: Parameters<ShopService['shopCharge']>) { return this.shop.shopCharge(...args); }
  spend(...args: Parameters<ShopService['spend']>) { return this.shop.spend(...args); }
  grant(...args: Parameters<ShopService['grant']>) { return this.shop.grant(...args); }

  // ── gachaDraw ──
  gachaDraw(...args: Parameters<GachaDrawService['gachaDraw']>) { return this.gachaDrawSvc.gachaDraw(...args); }
  redeemFate(...args: Parameters<GachaDrawService['redeemFate']>) { return this.gachaDrawSvc.redeemFate(...args); }

  // ── subscription ──
  monthlyCardBuy(...args: Parameters<SubscriptionService['monthlyCardBuy']>) { return this.subscription.monthlyCardBuy(...args); }
  yearCardBuy(...args: Parameters<SubscriptionService['yearCardBuy']>) { return this.subscription.yearCardBuy(...args); }
  monthlyCardClaim(...args: Parameters<SubscriptionService['monthlyCardClaim']>) { return this.subscription.monthlyCardClaim(...args); }

  // ── starter ──
  starterBuy(...args: Parameters<StarterService['starterBuy']>) { return this.starter.starterBuy(...args); }

  // ── recharge ──
  rechargeVerify(...args: Parameters<RechargeService['rechargeVerify']>) { return this.recharge.rechargeVerify(...args); }
  verifyNonCoinReceipt(...args: Parameters<RechargeService['verifyNonCoinReceipt']>) { return this.recharge.verifyNonCoinReceipt(...args); }
  paddleComplete(...args: Parameters<RechargeService['paddleComplete']>) { return this.recharge.paddleComplete(...args); }
  paddleRefund(...args: Parameters<RechargeService['paddleRefund']>) { return this.recharge.paddleRefund(...args); }
  recordPaddleEvent(...args: Parameters<RechargeService['recordPaddleEvent']>) { return this.recharge.recordPaddleEvent(...args); }
  listPaddleEvents(...args: Parameters<RechargeService['listPaddleEvents']>) { return this.recharge.listPaddleEvents(...args); }

  // ── promo ──
  createPromoCode(...args: Parameters<PromoService['createPromoCode']>) { return this.promo.createPromoCode(...args); }
  listPromoCodes(...args: Parameters<PromoService['listPromoCodes']>) { return this.promo.listPromoCodes(...args); }
  promoRedeem(...args: Parameters<PromoService['promoRedeem']>) { return this.promo.promoRedeem(...args); }

  // ── rewards ──
  adsCredit(...args: Parameters<RewardsService['adsCredit']>) { return this.rewards.adsCredit(...args); }
  victoryCredit(...args: Parameters<RewardsService['victoryCredit']>) { return this.rewards.victoryCredit(...args); }

  // ── orders ──
  orderDelivered(...args: Parameters<OrdersService['orderDelivered']>) { return this.orders.orderDelivered(...args); }
  undeliveredOrders(...args: Parameters<OrdersService['undeliveredOrders']>) { return this.orders.undeliveredOrders(...args); }

  // ── audit ──
  auditCoinGains(...args: Parameters<AuditService['auditCoinGains']>) { return this.audit.auditCoinGains(...args); }
}
