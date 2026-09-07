/**
 * appleConsumptionConsent.test.ts — the consumption-data question (IOS_RELEASE.md §4.1b).
 *
 * Apple asks the seller how much of a purchase was used when a customer requests a refund, requires
 * `customerConsented: true` on the answer, and requires the APP to have collected that consent. So
 * this question is the only thing standing between "we have a refund defence" and "we have a refund
 * defence that never fires". What the tests below pin is when it may be asked — a question about
 * refunds shown to someone who never paid is noise — and that an answer is never asked for twice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SaveData } from '../src/game/meta/SaveData';
import type { ApiClient } from '../src/net/ApiClient';
import type { IStorage } from '../src/platform/IPlatform';
import {
  shouldAskConsumptionConsent,
  recordConsumptionConsent,
} from '../src/platform/appleConsumptionConsent';

type Globals = { NWBilling?: unknown };
const g = globalThis as Globals;

function memStorage(): IStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** A save with the given lifetime spend; `monetization.totalRechargeCents` is the "has paid" signal. */
function save(cents: number | undefined): SaveData {
  return { monetization: { totalRechargeCents: cents } } as unknown as SaveData;
}

const appleBridge = { kind: 'apple', purchase: () => Promise.resolve({ receipt: 'r' }) };

afterEach(() => { delete g.NWBilling; vi.restoreAllMocks(); });

describe('shouldAskConsumptionConsent', () => {
  beforeEach(() => { g.NWBilling = appleBridge; });

  it('asks a paying iOS player', () => {
    expect(shouldAskConsumptionConsent(memStorage(), save(499))).toBe(true);
  });

  it('does not ask a player who has never paid', () => {
    // The question is about refunds. Asked before a purchase it is a privacy prompt about nothing.
    expect(shouldAskConsumptionConsent(memStorage(), save(0))).toBe(false);
    expect(shouldAskConsumptionConsent(memStorage(), save(undefined))).toBe(false);
  });

  it('does not ask outside the iOS shell', () => {
    g.NWBilling = { kind: 'google', purchase: () => Promise.resolve({ receipt: 'r' }) };
    expect(shouldAskConsumptionConsent(memStorage(), save(499))).toBe(false);
    delete g.NWBilling;
    expect(shouldAskConsumptionConsent(memStorage(), save(499))).toBe(false);
  });

  it('never asks twice, whichever way the player answered', async () => {
    const storage = memStorage();
    const api = { setAppleConsumptionConsent: async () => ({ consented: false }) } as unknown as ApiClient;
    await recordConsumptionConsent(api, storage, false);
    expect(shouldAskConsumptionConsent(storage, save(499))).toBe(false);
  });
});

describe('recordConsumptionConsent', () => {
  beforeEach(() => { g.NWBilling = appleBridge; });

  it('sends the answer to the server and marks the question answered', async () => {
    const storage = memStorage();
    const sent: boolean[] = [];
    const api = {
      setAppleConsumptionConsent: async (c: boolean) => { sent.push(c); return { consented: c }; },
    } as unknown as ApiClient;
    await recordConsumptionConsent(api, storage, true);
    expect(sent).toEqual([true]);
    expect(shouldAskConsumptionConsent(storage, save(499))).toBe(false);
  });

  it('a failed POST still counts as asked, and leaves the server withholding consent', async () => {
    // Fails closed on purpose: the server default is "no consent recorded", which means it does not
    // answer Apple at all. Re-asking until a request succeeds would be nagging, and claiming a
    // consent the server never stored would be worse than staying silent.
    const storage = memStorage();
    const api = {
      setAppleConsumptionConsent: async () => { throw new Error('offline'); },
    } as unknown as ApiClient;
    await expect(recordConsumptionConsent(api, storage, true)).resolves.toBeUndefined();
    expect(shouldAskConsumptionConsent(storage, save(499))).toBe(false);
  });
});
