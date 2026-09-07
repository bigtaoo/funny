/**
 * appleUnfinishedTransactions.test.ts — reporting the StoreKit 2 transactions that arrive outside a
 * purchase (IOS_RELEASE.md §6).
 *
 * Every case here is about one rule: a transaction is finished only after the server has granted it.
 * Get that backwards and the failure is invisible and permanent — StoreKit forgets the transaction,
 * the player is charged, and nothing anywhere records that content was owed. So the tests below are
 * mostly about when finish() must NOT be called, and about routing each product family to the
 * endpoint that knows how to grant it (a coin pack, a subscription period and a starter pack are
 * three different grants; only the transaction id is common).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SaveData } from '../src/game/meta/SaveData';
import type { ApiClient } from '../src/net/ApiClient';
import { ApiError } from '../src/net/ApiClient';
import {
  drainAppleTransactions,
  resetAppleTransactionDrainForTest,
} from '../src/platform/appleUnfinishedTransactions';

type Globals = { NWBilling?: unknown };
const g = globalThis as Globals;

interface BridgeOpts {
  kind?: 'apple' | 'google';
  pending?: { transactionId: string; productKey: string }[];
  /** Omit `pending`/`finish` to model a native binary older than the StoreKit 2 bridge. */
  storeKit2?: boolean;
}

function bridge(opts: BridgeOpts = {}) {
  const { kind = 'apple', pending = [], storeKit2 = true } = opts;
  const finished: string[] = [];
  const b: Record<string, unknown> = { kind, purchase: () => Promise.resolve({ receipt: 'r' }) };
  if (storeKit2) {
    b.pending = () => Promise.resolve(pending);
    b.finish = (id: string) => { finished.push(id); return Promise.resolve(); };
  }
  return { b, finished };
}

interface ApiCalls {
  verify: string[];
  sync: string[];
  starter: [string, string][];
}

function fakeApi(opts: { granted?: number; fail?: unknown } = {}): ApiClient & { calls: ApiCalls } {
  const calls: ApiCalls = { verify: [], sync: [], starter: [] };
  const save = { adopted: true } as unknown as SaveData;
  const maybeThrow = (): void => { if (opts.fail) throw opts.fail; };
  return {
    calls,
    iapVerify: async (_platform: string, receipt: string) => {
      calls.verify.push(receipt); maybeThrow();
      return { save, granted: 550 };
    },
    iapAppleSync: async (receipt: string) => {
      calls.sync.push(receipt); maybeThrow();
      return { save, granted: opts.granted ?? 1 };
    },
    starterBuy: async (productId: string, _platform: string, receipt: string) => {
      calls.starter.push([productId, receipt]); maybeThrow();
      return { save, results: [] };
    },
  } as unknown as ApiClient & { calls: ApiCalls };
}

beforeEach(() => { resetAppleTransactionDrainForTest(); });
afterEach(() => { delete g.NWBilling; vi.restoreAllMocks(); });

describe('drainAppleTransactions — when it declines to act', () => {
  it('no native bridge (web / WeChat / CrazyGames): never touches the network', async () => {
    const api = fakeApi();
    await drainAppleTransactions(api, vi.fn());
    expect(api.calls.verify).toEqual([]);
  });

  it('an android bridge is left alone — Play has its own unbuilt flow', async () => {
    const { b } = bridge({ kind: 'google', pending: [{ transactionId: '1', productKey: 't499' }] });
    g.NWBilling = b;
    const api = fakeApi();
    await drainAppleTransactions(api, vi.fn());
    expect(api.calls.verify).toEqual([]);
  });

  it('an iOS binary older than the StoreKit 2 bridge is a normal state, not an error', async () => {
    // OTA ships new JS into old binaries by design (§11). A StoreKit 1 shell finished its own
    // transactions at purchase time, so there is nothing here to drain.
    const { b } = bridge({ storeKit2: false });
    g.NWBilling = b;
    const api = fakeApi();
    await drainAppleTransactions(api, vi.fn());
    expect(api.calls.verify).toEqual([]);
  });

  it('runs at most once per session', async () => {
    const { b } = bridge({ pending: [{ transactionId: '1', productKey: 't499' }] });
    g.NWBilling = b;
    const api = fakeApi();
    await drainAppleTransactions(api, vi.fn());
    await drainAppleTransactions(api, vi.fn());
    expect(api.calls.verify).toEqual(['1']);
  });
});

describe('drainAppleTransactions — routing and finishing', () => {
  it('reports a coin tier to /iap/verify, then finishes it', async () => {
    const { b, finished } = bridge({ pending: [{ transactionId: 'tx-c', productKey: 't999' }] });
    g.NWBilling = b;
    const api = fakeApi();
    const adopt = vi.fn();
    await drainAppleTransactions(api, adopt);
    expect(api.calls.verify).toEqual(['tx-c']);
    expect(finished).toEqual(['tx-c']);
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it('reports a subscription period through the sync endpoint', async () => {
    // Not /iap/verify: the sync endpoint applies every period behind the transaction and bypasses
    // the single-slot gate a renewal would otherwise hit.
    const { b, finished } = bridge({ pending: [{ transactionId: 'tx-s', productKey: 'monthly_card' }] });
    g.NWBilling = b;
    const api = fakeApi();
    await drainAppleTransactions(api, vi.fn());
    expect(api.calls.sync).toEqual(['tx-s']);
    expect(api.calls.verify).toEqual([]);
    expect(finished).toEqual(['tx-s']);
  });

  it('a sync that granted nothing still finishes the transaction, but adopts no save', async () => {
    // granted: 0 is the usual answer (the webhook got there first). The content exists either way,
    // so the transaction is done; there is just nothing new to paint.
    const { b, finished } = bridge({ pending: [{ transactionId: 'tx-s', productKey: 'year_card' }] });
    g.NWBilling = b;
    const api = fakeApi({ granted: 0 });
    const adopt = vi.fn();
    await drainAppleTransactions(api, adopt);
    expect(finished).toEqual(['tx-s']);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('reports a starter pack as a purchase of that product', async () => {
    const { b, finished } = bridge({
      pending: [{ transactionId: 'tx-p', productKey: 'starter_growth' }],
    });
    g.NWBilling = b;
    const api = fakeApi();
    await drainAppleTransactions(api, vi.fn());
    expect(api.calls.starter).toEqual([['starter_growth', 'tx-p']]);
    expect(finished).toEqual(['tx-p']);
  });

  it('leaves a transaction unfinished when the report fails', async () => {
    // The whole point of the two-step handoff: a failed report must leave the charge visible to the
    // next launch rather than consuming it.
    const { b, finished } = bridge({ pending: [{ transactionId: 'tx-c', productKey: 't499' }] });
    g.NWBilling = b;
    const api = fakeApi({ fail: new Error('offline') });
    await drainAppleTransactions(api, vi.fn());
    expect(finished).toEqual([]);
  });

  it('finishes a starter pack the account already owns — that content was delivered', async () => {
    // The one permanent rejection. Left unfinished it would be re-reported on every launch forever.
    const { b, finished } = bridge({
      pending: [{ transactionId: 'tx-p', productKey: 'starter_draw' }],
    });
    g.NWBilling = b;
    const api = fakeApi({ fail: new ApiError('ALREADY_PURCHASED', 'already owned') });
    await drainAppleTransactions(api, vi.fn());
    expect(finished).toEqual(['tx-p']);
  });

  it('one failure does not stop the rest of the queue', async () => {
    const { b, finished } = bridge({
      pending: [
        { transactionId: 'bad', productKey: 'monthly_card' },
        { transactionId: 'good', productKey: 't499' },
      ],
    });
    g.NWBilling = b;
    const api = {
      iapAppleSync: async () => { throw new Error('offline'); },
      iapVerify: async () => ({ save: {} as SaveData, granted: 550 }),
    } as unknown as ApiClient;
    await drainAppleTransactions(api, vi.fn());
    expect(finished).toEqual(['good']);
  });

  it('caps one pass at 20 transactions', async () => {
    // Transaction.updates can replay a long history after a migration or a restore; the rest is
    // picked up on later launches rather than turned into 100 POSTs at boot.
    const pending = Array.from({ length: 30 }, (_, i) => ({
      transactionId: `tx-${i}`,
      productKey: 't499',
    }));
    const { b, finished } = bridge({ pending });
    g.NWBilling = b;
    const api = fakeApi();
    await drainAppleTransactions(api, vi.fn());
    expect(api.calls.verify).toHaveLength(20);
    expect(finished).toHaveLength(20);
  });
});
