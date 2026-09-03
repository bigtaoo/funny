// Shared stub `AuctionServiceDeps` for the branch-coverage unit tests added in the 2026-09-03 pass
// (validation refusals / absent-field fallbacks / lost CAS races / the journal's collision states).
// Same precedent as server/admin/test/stubDeps.ts: build the service through the REAL `AuctionService`
// constructor, so the pricing / journal / trade wiring under test is the genuine implementation and only
// the one or two collection calls a given branch touches are stubbed.
//
// Deliberately NOT a general-purpose in-memory Mongo: every collection method a test does not pass stays
// undefined, so a test that wanders into an unstubbed call throws a TypeError instead of quietly
// exercising a second, parallel implementation of the service. The e2e suites (auction.e2e.test.ts,
// journal-atomicity.e2e.test.ts) are what cover the real driver against real Mongo.
import { AuctionService } from '../src/auctionService';
import type { AuctionServiceDeps } from '../src/auctionService/base';
import type { AuctionDoc, AuctionOrderDoc } from '../src/db';
import type { AuctionCommercialClient } from '../src/commercialClient';
import type { AuctionMailClient, AuctionMailContent } from '../src/mailClient';
import type { AuctionMetaClient } from '../src/metaClient';

/** Fixed clock, so a test can pin `expireAt` relative to "now" instead of sleeping. */
export const NOW = 1_700_000_000_000;

export interface SentMail { account: string; dispatchKey: string; content: AuctionMailContent }
export interface RecordedSpend { account: string; amount: number; orderId: string }

export interface Stub {
  deps: AuctionServiceDeps;
  svc: AuctionService;
  /** Every system mail the stubbed mail client accepted. */
  mails: SentMail[];
  /** Every coin debit the stubbed commercial client accepted. */
  spends: RecordedSpend[];
}

type ColName = 'auctions' | 'auctionDaily' | 'auctionPrices' | 'auctionOrders' | 'auctionBids';

export interface StubOver {
  cols?: Partial<Record<ColName, Record<string, unknown>>>;
  now?: () => number;
  commercial?: Partial<AuctionCommercialClient>;
  meta?: Partial<AuctionMetaClient>;
  mail?: Partial<AuctionMailClient>;
}

/**
 * Build deps whose commercial/mail clients are recording arrays and whose collections are exactly what
 * `over.cols` provides — merged PER COLLECTION (one level deeper than a spread), so a test that adds
 * `auctions.findOne` still gets any default alongside it.
 */
export function stubDeps(over: StubOver = {}): Stub {
  const mails: SentMail[] = [];
  const spends: RecordedSpend[] = [];
  const cols: Record<string, Record<string, unknown>> = {};
  for (const [name, methods] of Object.entries(over.cols ?? {})) {
    cols[name] = { ...(cols[name] ?? {}), ...methods };
  }
  const deps = {
    now: over.now ?? (() => NOW),
    cols,
    commercial: {
      available: true,
      async spend(accountId: string, amount: number, orderId: string) { spends.push({ account: accountId, amount, orderId }); },
      ...over.commercial,
    },
    mail: {
      available: true,
      async sendSystemMail(accountId: string, dispatchKey: string, content: AuctionMailContent) {
        mails.push({ account: accountId, dispatchKey, content });
      },
      ...over.mail,
    },
    // No defaults: an unstubbed meta call is meant to throw rather than pretend to escrow something.
    meta: { available: true, ...over.meta },
  } as unknown as AuctionServiceDeps;
  return { deps, svc: new AuctionService(deps), mails, spends };
}

/** A minimal open fixed-price material listing; `over` replaces any field. */
export function mkAuction(over: Partial<AuctionDoc> = {}): AuctionDoc {
  return {
    _id: 'a:seller-1:1:1',
    sellerId: 'seller-1',
    itemType: 'material',
    item: { material: 'scrap' },
    qty: 2,
    price: 100,
    currency: 'coins',
    expireAt: NOW + 3600_000,
    status: 'open',
    rev: 0,
    ...over,
  };
}

/** A minimal journal row; `over` replaces any field. */
export function mkOrder(over: Partial<AuctionOrderDoc> = {}): AuctionOrderDoc {
  return {
    _id: 'row-1',
    auctionId: 'a:seller-1:1:1',
    kind: 'buy',
    actorId: 'buyer-1',
    status: 'pending',
    steps: [],
    prefix: 0,
    done: {},
    started: {},
    decided: false,
    compensation: [],
    cycle: 0,
    claimedAt: NOW,
    attempts: 0,
    nextAttemptAt: NOW,
    ts: NOW,
    ...over,
  };
}

/** The duplicate-key error Mongo raises when `insertOne` loses an insert-first key claim. */
export function dupKeyError(): Error & { code: number } {
  return Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
}
