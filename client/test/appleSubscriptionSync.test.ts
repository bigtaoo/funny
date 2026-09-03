/**
 * appleSubscriptionSync.test.ts — the client half of Apple auto-renewable subscriptions
 * (IOS_RELEASE.md §4.1b).
 *
 * This module runs unprompted, at lobby entry, on a path where nothing it does is visible: a renewal
 * that syncs correctly looks exactly like one that never happened, right up until the player notices
 * their card lapsed despite being billed. So the cases below are all about what it does NOT do —
 * the four ways it must decline to act, and the one way it must not repeat itself:
 *
 *   • not on the web, WeChat or CrazyGames build (no native billing bridge at all);
 *   • not on Android (Play subscriptions renew through their own, unbuilt, mechanism);
 *   • not on an iOS shell whose native binary predates the bridge's `receipt()` reader — OTA ships
 *     new JS into old binaries by design (§11), so this is a normal state, not a broken one;
 *   • not on a device with no receipt yet (fresh install, never purchased);
 *   • and never twice in a session, because renewals arrive monthly and the lobby is entered
 *     constantly.
 *
 * Plus the one thing it must do: adopt the returned save when — and only when — the server says it
 * actually granted something.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SaveData } from '../src/game/meta/SaveData';
import type { ApiClient } from '../src/net/ApiClient';
import { syncAppleSubscription, resetAppleSubscriptionSyncForTest } from '../src/platform/appleSubscriptionSync';

type Globals = { NWBilling?: unknown };
const g = globalThis as Globals;

/** A bridge of the shape AppDelegate.swift injects; `receipt` omitted to model an older binary. */
function bridge(opts: { kind?: 'apple' | 'google'; receipt?: string | null; hasReader?: boolean } = {}) {
  const { kind = 'apple', receipt = 'RECEIPT', hasReader = true } = opts;
  const b: Record<string, unknown> = {
    kind,
    purchase: () => Promise.resolve({ receipt: 'r' }),
  };
  if (hasReader) b.receipt = () => Promise.resolve(receipt);
  return b;
}

/** An api double recording the receipt it was handed. */
function fakeApi(granted: number): ApiClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    iapAppleSync: async (receipt: string) => {
      calls.push(receipt);
      return { save: { synced: true } as unknown as SaveData, granted };
    },
  } as unknown as ApiClient & { calls: string[] };
}

beforeEach(() => { resetAppleSubscriptionSyncForTest(); });
afterEach(() => { delete g.NWBilling; vi.restoreAllMocks(); });

describe('syncAppleSubscription — when it declines to act', () => {
  it('no native bridge at all (web / WeChat / CrazyGames): never touches the network', async () => {
    const api = fakeApi(1);
    const adopt = vi.fn();
    await syncAppleSubscription(api, adopt);
    expect(api.calls).toEqual([]);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('an android bridge is left alone (Play renewals are their own, unbuilt, mechanism)', async () => {
    g.NWBilling = bridge({ kind: 'google' });
    const api = fakeApi(1);
    await syncAppleSubscription(api, vi.fn());
    expect(api.calls).toEqual([]);
  });

  it('an iOS shell older than receipt() is a normal state, not an error', async () => {
    // OTA (§11) ships new JS into a binary that may predate this bridge method. Feature-detect,
    // don't assume — and don't throw, because this runs on the lobby path.
    g.NWBilling = bridge({ hasReader: false });
    const api = fakeApi(1);
    await expect(syncAppleSubscription(api, vi.fn())).resolves.toBeUndefined();
    expect(api.calls).toEqual([]);
  });

  it('no receipt on the device yet (fresh install, never purchased)', async () => {
    g.NWBilling = bridge({ receipt: null });
    const api = fakeApi(1);
    await syncAppleSubscription(api, vi.fn());
    expect(api.calls).toEqual([]);
  });
});

describe('syncAppleSubscription — when it does act', () => {
  it('hands the receipt over and adopts the save when a period was granted', async () => {
    g.NWBilling = bridge({ receipt: 'BASE64-RECEIPT' });
    const api = fakeApi(1);
    const adopt = vi.fn();
    await syncAppleSubscription(api, adopt);
    expect(api.calls).toEqual(['BASE64-RECEIPT']);
    expect(adopt).toHaveBeenCalledWith({ synced: true });
  });

  it('granted:0 — the usual answer — leaves the local save alone', async () => {
    // Adopting on every launch would stomp whatever the session has in flight for no reason; the
    // server only has news for us on the one launch a month that follows a renewal.
    g.NWBilling = bridge();
    const api = fakeApi(0);
    const adopt = vi.fn();
    await syncAppleSubscription(api, adopt);
    expect(api.calls).toHaveLength(1);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('runs at most once per session, however often the lobby is entered', async () => {
    g.NWBilling = bridge();
    const api = fakeApi(0);
    await syncAppleSubscription(api, vi.fn());
    await syncAppleSubscription(api, vi.fn());
    await syncAppleSubscription(api, vi.fn());
    expect(api.calls).toHaveLength(1);
  });

  it('a failing request is swallowed — the boot path never sees a rejection', async () => {
    g.NWBilling = bridge();
    const api = { iapAppleSync: async () => { throw new Error('offline'); } } as unknown as ApiClient;
    const adopt = vi.fn();
    await expect(syncAppleSubscription(api, adopt)).resolves.toBeUndefined();
    expect(adopt).not.toHaveBeenCalled();
  });

  it('a bridge whose receipt() rejects is equally a non-event', async () => {
    g.NWBilling = { kind: 'apple', purchase: () => Promise.resolve({ receipt: 'r' }), receipt: () => Promise.reject(new Error('storekit')) };
    const api = fakeApi(1);
    await expect(syncAppleSubscription(api, vi.fn())).resolves.toBeUndefined();
    expect(api.calls).toEqual([]);
  });
});
