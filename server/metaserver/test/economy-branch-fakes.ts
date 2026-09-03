// Shared fixtures for the src/service/economy/* branch-coverage backfill (test/economy-branch-*.test.ts,
// 2026-09-03). Not a *.test.ts file: it holds only the configurable commercial double, the MetaCore
// factory and the request/reply stubs the two handler suites share, so neither of them has to carry its
// own 200-line CommercialClient implementation (repo CI caps a file at 500 lines).
//
// The handlers are called as plain functions with a hand-built FastifyRequest/FastifyReply (the idiom
// test/liveops-achievements-unit.test.ts already uses) rather than through app.inject, because several of
// the branches being covered here sit *behind* the openapi request schema: `qty: 0`, a non-string promo
// `code`, an entirely absent request body. A schema-validated route can never deliver those to the
// handler, so a route-level test cannot reach the guards that exist for them.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collections } from '@nw/shared';
import { MetaCore } from '../src/service/base.js';
import { AccountCache } from '../src/accountCache.js';
import type { CommercialClient, GachaResultEntry, UndeliveredOrder, WalletView } from '../src/commercialClient.js';
import { FakeSocialsvc, fakeGateway } from './helpers/fakeClients.js';

/**
 * Configurable commercial double. Every knob exists for one refusal/degraded branch under test:
 * `available:false` for the ensureCommercial 503 gate, `walletUnavailable` for the
 * "mirrorWalletFrom vs. getOrCreateSave" fork, `next*Error` for one-shot error codes, `grantThrows`
 * for the recharge-milestone coin-grant catch, and `populateWallet` for the response-embedded wallet
 * that lets a handler skip its extra getWallet round trip.
 */
export class BranchCommercial implements CommercialClient {
  readonly available: boolean;
  constructor(available = true) {
    this.available = available;
  }

  coins = new Map<string, number>();
  totalRechargeCents = 0;
  subscriptionExpiry = 0;
  starterUsed: string[] = [];
  fatePoints = 0;
  pity: Record<string, number> = {};
  walletUnavailable = false;
  populateWallet = false;
  grantThrows = false;
  grantFails = false;
  grantCalls: { accountId: string; amount: number; reason: string; orderId: string }[] = [];
  delivered: string[] = [];
  results: GachaResultEntry[] = [{ itemId: 'skin_l1', rarity: 'legendary' } as GachaResultEntry];
  activeLimitedPools: unknown[] = [];
  nextShopChargeError: string | null = null;
  nextGachaDrawError: string | null = null;
  nextSubscriptionError: string | null = null;
  nextStarterError: string | null = null;
  nextFateError: string | null = null;
  nextPromoError: string | null = null;
  nextRechargeVerifyError: string | null = null;
  nextAdsCreditError: string | null = null;
  fateGained = 0;

  bal(id: string): number {
    return this.coins.get(id) ?? 0;
  }

  private view(id: string): WalletView {
    return {
      coins: this.bal(id),
      pity: this.pity,
      fatePoints: this.fatePoints,
      subscriptionExpiry: this.subscriptionExpiry,
      starterUsed: this.starterUsed,
      firstPurchaseUsed: false,
      totalRechargeCents: this.totalRechargeCents,
    } as WalletView;
  }

  private embedded(id: string) {
    return this.populateWallet ? { wallet: this.view(id) } : {};
  }

  async getWallet(id: string) {
    return this.walletUnavailable ? null : this.view(id);
  }

  async shopCharge(a: { accountId: string; itemId: string; cost: number; qty?: number; orderId: string }) {
    if (this.nextShopChargeError) {
      const e = this.nextShopChargeError;
      this.nextShopChargeError = null;
      return { ok: false as const, error: e };
    }
    const total = a.cost * (a.qty ?? 1);
    this.coins.set(a.accountId, this.bal(a.accountId) - total);
    return { ok: true as const, orderId: a.orderId, coinsAfter: this.bal(a.accountId), status: 'charged' };
  }

  async gachaDraw(a: { accountId: string; poolId: string; count: number; orderId: string }) {
    if (this.nextGachaDrawError) {
      const e = this.nextGachaDrawError;
      this.nextGachaDrawError = null;
      return { ok: false as const, error: e };
    }
    const results = this.results.slice(0, a.count);
    const gained = this.fateGained;
    this.fateGained = 0;
    this.fatePoints += gained;
    return {
      ok: true as const, orderId: a.orderId, coinsAfter: this.bal(a.accountId),
      pityAfter: a.count, results, fateGained: gained, fatePointsAfter: this.fatePoints,
    };
  }

  async redeemFate(a: { accountId: string; itemId: string; orderId: string }) {
    if (this.nextFateError) {
      const e = this.nextFateError;
      this.nextFateError = null;
      return { ok: false as const, error: e };
    }
    this.fatePoints = Math.max(0, this.fatePoints - 30);
    return {
      ok: true as const, orderId: a.orderId, itemId: a.itemId,
      coinsAfter: this.bal(a.accountId), fatePointsAfter: this.fatePoints,
    };
  }

  async monthlyCardBuy(a: { accountId: string; orderId: string }) {
    if (this.nextSubscriptionError) {
      const e = this.nextSubscriptionError;
      this.nextSubscriptionError = null;
      return { ok: false as const, error: e };
    }
    this.subscriptionExpiry = 30 * 86400000;
    return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: this.subscriptionExpiry, ...this.embedded(a.accountId) };
  }

  async yearCardBuy(a: { accountId: string; orderId: string }) {
    if (this.nextSubscriptionError) {
      const e = this.nextSubscriptionError;
      this.nextSubscriptionError = null;
      return { ok: false as const, error: e };
    }
    this.subscriptionExpiry = 365 * 86400000;
    return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: this.subscriptionExpiry, ...this.embedded(a.accountId) };
  }

  async monthlyCardClaim(a: { accountId: string; dayKey: string }) {
    if (this.nextSubscriptionError) {
      const e = this.nextSubscriptionError;
      this.nextSubscriptionError = null;
      return { ok: false as const, error: e };
    }
    this.coins.set(a.accountId, this.bal(a.accountId) + 20);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), claimed: 20, subscriptionExpiry: this.subscriptionExpiry, ...this.embedded(a.accountId) };
  }

  async starterBuy(a: { accountId: string; productId: string; orderId: string }) {
    if (this.nextStarterError) {
      const e = this.nextStarterError;
      this.nextStarterError = null;
      return { ok: false as const, error: e };
    }
    this.starterUsed = [...this.starterUsed, a.productId];
    const results = a.productId === 'starter_draw' ? this.results : [];
    return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: this.subscriptionExpiry, results, ...this.embedded(a.accountId) };
  }

  async verifyNonCoinReceipt(a: { receipt: string; expectedProduct: string }) {
    if (a.receipt !== `product:${a.expectedProduct}`) return { ok: false as const, error: 'INVALID_RECEIPT' };
    return { ok: true as const, product: a.expectedProduct };
  }

  async rechargeVerify(a: { accountId: string }) {
    if (this.nextRechargeVerifyError) {
      const e = this.nextRechargeVerifyError;
      this.nextRechargeVerifyError = null;
      return { ok: false as const, error: e };
    }
    this.coins.set(a.accountId, this.bal(a.accountId) + 550);
    this.totalRechargeCents += 499;
    return { ok: true as const, coinsAfter: this.bal(a.accountId), coinsGranted: 550 };
  }

  async adsCredit(a: { accountId: string; amount: number }) {
    if (this.nextAdsCreditError) {
      const e = this.nextAdsCreditError;
      this.nextAdsCreditError = null;
      return { ok: false as const, error: e };
    }
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }

  async promoRedeem(a: { accountId: string }) {
    if (this.nextPromoError) {
      const e = this.nextPromoError;
      this.nextPromoError = null;
      return { ok: false as const, error: e };
    }
    this.coins.set(a.accountId, this.bal(a.accountId) + 100);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), coinsGranted: 100 };
  }

  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    if (this.grantThrows) throw new Error('commercial unreachable');
    this.grantCalls.push({ accountId: a.accountId, amount: a.amount, reason: a.reason, orderId: a.orderId });
    if (this.grantFails) return { ok: false as const, error: 'GRANT_REJECTED' };
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }

  async spend(a: { accountId: string; amount: number }) {
    this.coins.set(a.accountId, this.bal(a.accountId) - a.amount);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }

  async victoryCredit(a: { accountId: string; amount: number }) {
    return { ok: true as const, coinsAfter: this.bal(a.accountId), credited: a.amount, capped: false };
  }

  async orderDelivered(a: { orderId: string }) {
    this.delivered.push(a.orderId);
    return { ok: true as const };
  }

  async undeliveredOrders(): Promise<UndeliveredOrder[]> {
    return [];
  }

  async listActiveLimitedPools() {
    return this.activeLimitedPools as never[];
  }

  // CommercialClient members these suites never exercise: they throw rather than silently answer.
  async createCustomPool(): Promise<never> { throw new Error('BranchCommercial.createCustomPool is not stubbed'); }
  async closeLimitedPool(): Promise<never> { throw new Error('BranchCommercial.closeLimitedPool is not stubbed'); }
  async listLimitedPools(): Promise<never> { throw new Error('BranchCommercial.listLimitedPools is not stubbed'); }
  async createPromoCode(): Promise<never> { throw new Error('BranchCommercial.createPromoCode is not stubbed'); }
  async listPromoCodes(): Promise<never> { throw new Error('BranchCommercial.listPromoCodes is not stubbed'); }
  async paddleComplete(): Promise<never> { throw new Error('BranchCommercial.paddleComplete is not stubbed'); }
  async paddleRefund(): Promise<never> { throw new Error('BranchCommercial.paddleRefund is not stubbed'); }
  async recordPaddleEvent(): Promise<never> { throw new Error('BranchCommercial.recordPaddleEvent is not stubbed'); }
  async listPaddleEvents(): Promise<never> { throw new Error('BranchCommercial.listPaddleEvents is not stubbed'); }
  async auditCoinGains(): Promise<never> { throw new Error('BranchCommercial.auditCoinGains is not stubbed'); }
}

/** MetaCore over real collections. `socialsvc` defaults to a working FakeSocialsvc so the
 *  `core.deps.socialsvc ?? nullMetaSocialsvcClient` configured side is the one exercised. */
export function makeCore(opts: {
  cols: Collections;
  commercial: CommercialClient;
  now?: () => number;
  socialsvc?: FakeSocialsvc | null;
}): MetaCore {
  return new MetaCore({
    cols: opts.cols,
    jwt: { secret: 'test-secret' },
    now: opts.now ?? (() => Date.now()),
    commercial: opts.commercial,
    gatewayPublicUrl: null,
    gateway: fakeGateway(),
    authRateLimit: 0,
    flags: null,
    wordlists: null,
    region: null,
    lokiPushUrl: null,
    socialsvc: opts.socialsvc === undefined ? new FakeSocialsvc() : opts.socialsvc,
    redis: null,
    accountCache: new AccountCache(),
  });
}

export interface Sent {
  code: number;
  payload: { ok?: boolean; error?: { code: string; message: string }; data?: Record<string, unknown> };
}

/** Fastify request stub: only `accountId`, `body` and `headers` are read by these handlers. */
export function mkReq(accountId: string, body?: unknown, platform?: string): FastifyRequest {
  return {
    accountId,
    body,
    headers: platform ? { 'x-nw-platform': platform } : {},
  } as unknown as FastifyRequest;
}

/** Reply stub capturing the last code()/send() pair; `sent` stays undefined when the handler returns ok(). */
export function mkReply(): { reply: FastifyReply; get(): Sent | undefined } {
  let sent: Sent | undefined;
  const reply = {
    code(c: number) {
      sent = { code: c, payload: {} };
      return this;
    },
    send(p: unknown) {
      sent!.payload = p as Sent['payload'];
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, get: () => sent };
}
