// Deterministic collection stubs for the code paths a real mongod cannot be asked to produce on demand.
//
// Every E11000 catch block in this package (shop.ts ×3, gachaDraw.ts ×2, recharge.ts ×3, promo.ts,
// base.ts's subscriptionCardBuy) exists for exactly one situation: this caller's pre-check read found no
// row, and by the time it tried to insert, a CONCURRENT caller had already claimed the same key. A real
// Mongo only produces that by losing a genuine race, which is why every one of those blocks — and every
// `?? fallback` inside them, i.e. what the loser actually reports back to the player — was still
// unexecuted after 13 e2e/unit files (claudedocs/server-testing-coverage.md, commercial 81.25% branches).
// Same for the `throw e` rethrow next to each one: a driver error that is NOT a duplicate key must
// propagate, never be reported as a successful idempotent replay of a purchase that never happened.
//
// These stubs are therefore deliberately dumb: each method returns canned values in call order (or throws
// a canned error), and nothing here emulates query matching, atomicity, or update semantics. Tests built
// on them assert what the SERVICE decided — its return value, and which collection call it made next —
// never what a fake database "stored"; storage semantics stay covered by the real-Mongo e2e files.
// Collections and methods a test does not stub are simply absent, so a path that reaches one dies with a
// TypeError instead of quietly running against a second, half-correct reimplementation of Mongo (the same
// rule admin's test/stubDeps.ts settled on).
import type { CommercialCollections, OrderDoc, RechargeDoc, WalletDoc } from '../../src/db';

/** One collection's stubbed methods (only what the path under test actually calls). */
export type MethodStubs = Record<string, unknown>;

/**
 * Assemble a `CommercialCollections` out of per-collection method stubs. Unstubbed collections stay
 * `undefined` on purpose — see the file header.
 */
export function stubCols(stubs: Partial<Record<keyof CommercialCollections, MethodStubs>>): CommercialCollections {
  return stubs as unknown as CommercialCollections;
}

/** The shape the mongodb driver raises on a unique-index conflict — `code: 11000` is all the callers read. */
export function dupKey(collection = 'orders'): Error & { code: number } {
  const e = new Error(`E11000 duplicate key error collection: ${collection} index: _id_`) as Error & { code: number };
  e.code = 11000;
  return e;
}

/**
 * A stub method resolving `values` in call order. A call past the end rejects rather than repeating the
 * last value: an unexpected extra read means the code under test no longer has the shape this test claims
 * to exercise, which should fail loudly instead of being papered over by a convenient default.
 */
export function replies<T>(...values: T[]): () => Promise<T> {
  let i = 0;
  return () => {
    if (i >= values.length) {
      return Promise.reject(new Error(`fakeCols stub exhausted: called ${i + 1}× but only ${values.length} reply/replies queued`));
    }
    return Promise.resolve(values[i++]!);
  };
}

/** A stub method that always rejects with `err` (duplicate-key conflicts, driver failures). */
export function throws(err: Error): () => Promise<never> {
  return () => Promise.reject(err);
}

/** A stub method that succeeds and returns nothing useful (insertOne/updateOne/deleteOne acknowledgements). */
export function ok(): () => Promise<unknown> {
  return () => Promise.resolve({ acknowledged: true });
}

/** Minimal well-formed wallet doc; spread overrides on top. */
export function wallet(over: Partial<WalletDoc> = {}): WalletDoc {
  return { _id: 'acc', coins: 0, rev: 0, gacha: { pity: {} }, updatedAt: 0, ...over };
}

/** Minimal well-formed order doc; spread overrides on top. */
export function order(over: Partial<OrderDoc> = {}): OrderDoc {
  return { _id: 'ord', accountId: 'acc', kind: 'shop', cost: 0, status: 'charged', coinsAfter: 0, result: {}, ts: 0, ...over };
}

/** Minimal well-formed recharge doc; spread overrides on top. */
export function recharge(over: Partial<RechargeDoc> = {}): RechargeDoc {
  return { _id: 'rcp', accountId: 'acc', platform: 'apple', coinsGranted: 0, status: 'granted', rawReceipt: 'r', ts: 0, ...over };
}
