// Test helper: swap ONE method on ONE real Mongo collection (2026-09-03 branch-coverage pass).
//
// Several branches in this package only run when a single-document CAS loses a race — `if (!claimed)`
// after a `findOneAndUpdate({status:'pending'})`, `if (!res)` after a capped `$inc`, the E11000 arm of
// an `insertOne` — or when the driver returns a half-populated result (a `bulkWrite` with no
// `upsertedIds`). Reaching those with two concurrent callers is not deterministic: both have to arrive
// inside the same atomic operation, and whichever one the server happens to serve first wins. So the
// loser's side of each branch is produced here instead, by making exactly the racing call behave the
// way it behaves when it loses, and leaving every other collection method on the REAL collection so
// the rest of the method under test still runs against real Mongo.
//
// Deliberately NOT an in-memory Mongo: an override that isn't declared falls through to the real
// driver, so a test can never quietly end up asserting against a second, hand-written implementation
// of query semantics (the trap `test/stubDeps.ts` in admin calls out for the same reason).
import type { SocialCollections } from '../src/db';

/**
 * A view of `real` where the named methods are replaced. Everything else — including methods the
 * driver adds — is forwarded to the real collection, bound to it so `this` stays correct.
 */
export function overrideCollection<T extends object>(real: T, overrides: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return (overrides as Record<string | symbol, unknown>)[prop as string];
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** `cols` with a single collection swapped for an overridden view of itself. */
export function withCollection<K extends keyof SocialCollections>(
  cols: SocialCollections,
  key: K,
  overrides: Partial<Record<keyof SocialCollections[K], unknown>>,
): SocialCollections {
  return { ...cols, [key]: overrideCollection(cols[key] as object, overrides) as SocialCollections[K] };
}
