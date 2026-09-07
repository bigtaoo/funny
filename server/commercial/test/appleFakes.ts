// Shared fakes for the Apple App Store Server API (src/iap/appleServerApi.ts).
//
// The real client talks to Apple over the network with a signed ES256 JWT, and the real verifier
// checks a certificate chain we cannot produce. Both are reached through narrow interfaces precisely
// so tests can stand in front of them: what is worth testing on our side is which transaction turns
// into which grant, not whether Apple's own crypto works.
//
// (Payload decoding IS covered for real elsewhere — appleNotifications.test.ts drives an actual
// `SignedDataVerifier` in Environment.LOCAL_TESTING, where Apple's library skips the signature check
// but still runs its own payload validation and the bundle/environment checks.)
import { vi } from 'vitest';
import type {
  AppleNotification,
  AppleServerApi,
  AppleTransaction,
} from '../src/iap/appleServerApi';
import type { ConsumptionRequest } from '@apple/app-store-server-library';

/** A transaction with sensible defaults; override whatever the test is actually about. */
export function tx(over: Partial<AppleTransaction> & { transactionId: string }): AppleTransaction {
  return {
    originalTransactionId: over.transactionId,
    productId: 'com.nw.sub.monthly',
    purchasedMs: 1,
    revoked: false,
    ...over,
  };
}

export interface FakeAppleApi extends AppleServerApi {
  /** Every (transactionId, request) pair passed to sendConsumption. */
  readonly consumptionSent: Array<{ transactionId: string; request: ConsumptionRequest }>;
}

/**
 * A fake API answering from a fixed set of transactions.
 *
 * `history` defaults to every transaction handed in, which matches the real thing closely enough for
 * the sync's purposes (Apple returns the whole subscription's history for any id belonging to it).
 */
export function fakeAppleApi(opts: {
  transactions?: AppleTransaction[];
  history?: AppleTransaction[];
  notification?: AppleNotification | null;
  /** Make sendConsumption reject, to exercise the best-effort path. */
  consumptionThrows?: boolean;
}): FakeAppleApi {
  const transactions = opts.transactions ?? [];
  const consumptionSent: Array<{ transactionId: string; request: ConsumptionRequest }> = [];
  return {
    consumptionSent,
    verifyTransaction: vi.fn(async (id: string) => transactions.find((t) => t.transactionId === id) ?? null),
    transactionHistory: vi.fn(async () => opts.history ?? transactions),
    verifyNotification: vi.fn(async () => opts.notification ?? null),
    sendConsumption: vi.fn(async (transactionId: string, request: ConsumptionRequest) => {
      if (opts.consumptionThrows) throw new Error('apple rejected');
      consumptionSent.push({ transactionId, request });
    }),
  };
}
