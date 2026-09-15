// createAppleSubscriptionReader — the factory the auto-renewal sync reads periods through
// (IOS_RELEASE.md §4.1b). Shipped 2026-09-07 with the StoreKit 2 work and had never been called by
// anything on 2026-09-14: its only wiring is `commercial/src/index.ts`, which is the process entry point
// and reports 0% by construction, so `iap.ts` sat at 89.47% lines / 66.66% functions with this as the
// whole gap.
//
// It is five lines, and both of them that branch matter more than their size suggests. From the
// function's own doc: this reader is deliberately NOT part of createReceiptVerifier's dispatch and
// deliberately has no dev-stub branch, because what it returns is not "is this receipt good for one
// product" but a list of *already-paid-for* periods, each of which is then granted with the single-slot
// gate bypassed (subscriptionCardBuy's `alreadyCharged`). A forgeable input there mints subscription time
// on demand. So "Apple is not configured" has exactly one acceptable answer — null, i.e. the sync route
// reports nothing to sync — and the configured answer must reach Apple's verified history and nothing else.
//
// Both collaborators are mocked because this file is about the WIRING between them: whether the env
// actually yields an api is `appleServerApi.test.ts`'s subject (it fails closed on each of the five
// variables independently), and what a history turns into is `apple.ts`'s.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleServerApi } from '../src/iap/appleServerApi';
import type { AppleSubscriptionTx } from '../src/iap/types';

const createAppleServerApi = vi.fn<() => AppleServerApi | null>();
const appleSubscriptionTransactions =
  vi.fn<(receiptOrTransactionId: string, api: AppleServerApi) => Promise<AppleSubscriptionTx[]>>();

vi.mock('../src/iap/appleServerApi', () => ({ createAppleServerApi: () => createAppleServerApi() }));
vi.mock('../src/iap/apple', () => ({
  appleVerify: vi.fn(),
  appleSubscriptionTransactions: (r: string, a: AppleServerApi) => appleSubscriptionTransactions(r, a),
}));

const { createAppleSubscriptionReader } = await import('../src/iap');

const API = { marker: 'the-verified-client' } as unknown as AppleServerApi;

beforeEach(() => {
  createAppleServerApi.mockReset();
  appleSubscriptionTransactions.mockReset();
});

describe('createAppleSubscriptionReader', () => {
  it('is null when Apple is unconfigured, so the sync route grants nothing', () => {
    createAppleServerApi.mockReturnValue(null);
    // Null and not, say, a reader that answers with an empty list: the sync route distinguishes the two
    // ("nothing to sync" vs "this account has no periods"), and only null keeps an unconfigured
    // deployment from looking like one that has checked and found nothing.
    expect(createAppleSubscriptionReader()).toBeNull();
  });

  it('reads periods only through the api it just built, never the raw argument', async () => {
    createAppleServerApi.mockReturnValue(API);
    const periods = [{ productId: 'com.nw.card.month' }] as unknown as AppleSubscriptionTx[];
    appleSubscriptionTransactions.mockResolvedValue(periods);

    const read = createAppleSubscriptionReader();
    expect(read).not.toBeNull();
    await expect(read!('receipt-or-transaction-id')).resolves.toBe(periods);
    // The second argument is the whole safety case: the periods that come back are the ones Apple's own
    // verified client returned, not anything derived from the caller's string.
    expect(appleSubscriptionTransactions).toHaveBeenCalledWith('receipt-or-transaction-id', API);
  });

  it('builds the api once, at construction, not per read', async () => {
    createAppleServerApi.mockReturnValue(API);
    appleSubscriptionTransactions.mockResolvedValue([]);
    const read = createAppleSubscriptionReader();
    await read!('a');
    await read!('b');
    // Rebuilding per call would re-parse the .p8 and re-pin the root CAs on every renewal notification,
    // and would make the null check above a per-call decision instead of a startup one.
    expect(createAppleServerApi).toHaveBeenCalledTimes(1);
  });
});
