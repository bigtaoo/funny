// SaveManager.bootstrap() + consumeActiveMatch() — the login path (SaveManager.ts §"bootstrap()").
//
// Why this file exists (2026-09-10, function-level coverage sweep): these were the only two
// SaveManager methods with an FNDA hit count of zero, and they were not untested for lack of
// callers — `auth-reconnect-prompt.test.ts` and `session-expiry.test.ts` both drive the login flow,
// but both hand it a `vi.fn()` SaveManager. Those suites pin the CALLER ("nav calls
// consumeActiveMatch exactly once"); nobody had ever run the real read-and-clear, or the real
// auth → pull → reconcile → flush chain underneath it.
//
// What makes the gap worth a gate rather than a shrug: bootstrap() wraps its ENTIRE body in
// `catch { return false }`, and `false` is also what a genuinely offline client returns. Any bug
// inside — a throw from reconcile, a rejected flush, a typo in the profile hand-off — is therefore
// indistinguishable from "no network" at every call site (nav/auth.ts treats false as offline and
// shows the lobby). Nothing logs, nothing reports; the account simply never syncs and the player
// keeps playing on local data. The activeMatch half fails just as quietly in the other direction:
// leak the read-and-clear and an unrelated mid-session refresh() re-opens "resume your match?" for
// a match that ended half an hour ago.
import { describe, it, expect, vi } from 'vitest';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { makeNewSave, type SaveData } from '../src/game/meta';
import type { ActiveMatchInfo, ApiClient } from '../src/net/ApiClient';
import type { AuthCredential, IStorage } from '../src/platform/IPlatform';

class MemStorage implements IStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

const ACTIVE_MATCH: ActiveMatchInfo = {
  roomId: 'room-7',
  gameUrl: 'wss://game.example/ws',
  ticket: 'tkt-abc',
  mode: 'ranked',
};

interface FakeApiOpts {
  auth?: Partial<{ accountId: string; publicId: string; gatewayUrl: string }> | Error;
  save?: Partial<{
    save: SaveData;
    displayName: string;
    publicId: string;
    gatewayUrl: string;
    freeRename: boolean;
    activeMatch: ActiveMatchInfo;
  }> | Error;
  hasToken?: boolean;
}

/**
 * Minimal ApiClient double. `auth`/`save` accept an Error to make that leg reject — the two failure
 * legs matter as much as the happy path here, since both collapse into the same `false`.
 */
function fakeApi(opts: FakeApiOpts = {}) {
  const calls = {
    auth: [] as AuthCredential[],
    getSave: 0,
    pveClear: [] as string[],
    setFlag: [] as [string, boolean][],
  };
  let token = opts.hasToken ?? true;
  const cloud = makeNewSave('acc-cloud', 1);
  const api = {
    hasToken: () => token,
    auth: async (cred: AuthCredential) => {
      calls.auth.push(cred);
      if (opts.auth instanceof Error) throw opts.auth;
      token = true;
      return { accountId: 'acc-cloud', ...(opts.auth ?? {}) };
    },
    getSave: async () => {
      calls.getSave += 1;
      if (opts.save instanceof Error) throw opts.save;
      return { save: cloud, ...(opts.save ?? {}) };
    },
    pveClear: async (levelId: string) => {
      calls.pveClear.push(levelId);
      return { save: cloud };
    },
    setFlag: async (key: string, value: boolean) => {
      calls.setFlag.push([key, value]);
      return { save: cloud };
    },
  } as unknown as ApiClient;
  return { api, calls, cloud };
}

const credential: AuthCredential = { kind: 'device', deviceId: 'dev-1' } as unknown as AuthCredential;
const getCredential = () => Promise.resolve(credential);

function makeStore(local?: SaveData) {
  const storage = new MemStorage();
  const store = new LocalSaveStore(storage);
  store.saveLocal(local ?? makeNewSave('local-acc', 1));
  return store;
}

describe('SaveManager.bootstrap', () => {
  it('runs auth → pull → reconcile and reports success', async () => {
    const store = makeStore();
    const { api, calls, cloud } = fakeApi();
    cloud.wallet.coins = 4321;

    const mgr = new SaveManager({ store, api, getCredential });
    expect(await mgr.bootstrap()).toBe(true);

    expect(calls.auth).toEqual([credential]);
    expect(calls.getSave).toBe(1);
    // Cloud authority landed AND was persisted (a reconcile that only touched memory would pass
    // the first assertion alone).
    expect(mgr.get().wallet.coins).toBe(4321);
    expect(store.loadLocal().wallet.coins).toBe(4321);
  });

  it('persists the accountId from the auth response BEFORE pulling the save', async () => {
    // Order matters and is not decorative: the pull can fail (next-to-last case below), and a
    // client that never wrote the accountId would re-auth as a different device identity on the
    // next launch. Asserting it after bootstrap resolves proves nothing — reconcile() overwrites
    // accountId with the cloud save's own value — so the probe reads the store from inside getSave.
    const store = makeStore();
    let seenAtPullTime: string | undefined;
    const cloud = makeNewSave('acc-cloud', 1);
    const api = {
      hasToken: () => true,
      auth: async () => ({ accountId: 'acc-42' }),
      getSave: async () => {
        seenAtPullTime = store.loadLocal().accountId;
        return { save: cloud };
      },
    } as unknown as ApiClient;

    const mgr = new SaveManager({ store, api, getCredential });
    await mgr.bootstrap();

    expect(seenAtPullTime).toBe('acc-42');
  });

  it('hands the profile to onProfile, preferring the auth response over the save response', async () => {
    // publicId/gatewayUrl exist in BOTH responses and the auth one wins (`auth.publicId ?? cloud.publicId`).
    // Getting this backwards is invisible in the common case, where the two agree — it only shows up
    // right after a login that moved the account to a different gateway.
    const store = makeStore();
    const { api } = fakeApi({
      auth: { publicId: 'pub-auth', gatewayUrl: 'wss://auth.example' },
      save: { publicId: 'pub-save', gatewayUrl: 'wss://save.example', displayName: '阿涛', freeRename: true },
    });
    const onProfile = vi.fn();

    const mgr = new SaveManager({ store, api, getCredential, onProfile });
    await mgr.bootstrap();

    expect(onProfile).toHaveBeenCalledTimes(1);
    expect(onProfile).toHaveBeenCalledWith({
      displayName: '阿涛',
      publicId: 'pub-auth',
      gatewayUrl: 'wss://auth.example',
      freeRename: true,
    });
  });

  it('falls back to the save response for publicId/gatewayUrl when auth omits them', async () => {
    const store = makeStore();
    const { api } = fakeApi({ save: { publicId: 'pub-save', gatewayUrl: 'wss://save.example' } });
    const onProfile = vi.fn();

    const mgr = new SaveManager({ store, api, getCredential, onProfile });
    await mgr.bootstrap();

    expect(onProfile).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: 'pub-save', gatewayUrl: 'wss://save.example' }),
    );
  });

  it('flushes the offline queues after the pull (clears + flag writes made while logged out)', async () => {
    const store = makeStore();
    store.savePending([{ levelId: 'ch1_lv3', stars: 3, ts: Date.now() }]);
    store.savePendingFlags({ seen_intro: true });
    const { api, calls } = fakeApi();

    const mgr = new SaveManager({ store, api, getCredential });
    expect(await mgr.bootstrap()).toBe(true);

    // Both queues drained through the token this bootstrap just obtained — the whole reason the
    // flushes live at the END of bootstrap rather than at their enqueue sites.
    expect(calls.pveClear).toEqual(['ch1_lv3']);
    expect(calls.setFlag).toEqual([['seen_intro', true]]);
    expect(store.loadPending()).toEqual([]);
    expect(store.loadPendingFlags()).toEqual({});
  });

  it('returns false without touching the network when there is no api', async () => {
    const store = makeStore();
    const mgr = new SaveManager({ store, getCredential });
    expect(await mgr.bootstrap()).toBe(false);
  });

  it('returns false when the api is configured but no credential provider is', async () => {
    const store = makeStore();
    const { api, calls } = fakeApi();
    const mgr = new SaveManager({ store, api });

    expect(await mgr.bootstrap()).toBe(false);
    expect(calls.auth).toEqual([]); // never even asked
  });

  it('swallows an auth failure: returns false, keeps local data playable', async () => {
    const local = makeNewSave('local-acc', 1);
    local.wallet.coins = 77;
    const store = makeStore(local);
    const { api, calls } = fakeApi({ auth: new Error('401') });

    const mgr = new SaveManager({ store, api, getCredential });
    expect(await mgr.bootstrap()).toBe(false);

    expect(calls.getSave).toBe(0); // pull never attempted
    expect(mgr.get().wallet.coins).toBe(77);
    expect(mgr.get().accountId).toBe('local-acc'); // not overwritten by a half-finished login
  });

  it('swallows a pull failure after a successful auth (accountId already adopted, no throw)', async () => {
    const store = makeStore();
    const { api } = fakeApi({ auth: { accountId: 'acc-9' }, save: new Error('502') });
    const onProfile = vi.fn();

    const mgr = new SaveManager({ store, api, getCredential, onProfile });
    expect(await mgr.bootstrap()).toBe(false);

    expect(mgr.get().accountId).toBe('acc-9'); // written before the pull, and persisted
    expect(store.loadLocal().accountId).toBe('acc-9');
    expect(onProfile).not.toHaveBeenCalled(); // the profile hand-off is downstream of the pull
  });
});

describe('SaveManager.consumeActiveMatch', () => {
  it('returns the ticket the pull carried, exactly once (read-and-clear)', async () => {
    const store = makeStore();
    const { api } = fakeApi({ save: { activeMatch: ACTIVE_MATCH } });

    const mgr = new SaveManager({ store, api, getCredential });
    await mgr.bootstrap();

    expect(mgr.consumeActiveMatch()).toEqual(ACTIVE_MATCH);
    // Second read is null: the prompt must not resurface on an unrelated later refresh.
    expect(mgr.consumeActiveMatch()).toBeNull();
  });

  it('is null when the pull carried no active match', async () => {
    const store = makeStore();
    const { api } = fakeApi();

    const mgr = new SaveManager({ store, api, getCredential });
    await mgr.bootstrap();

    expect(mgr.consumeActiveMatch()).toBeNull();
  });

  it('is null before any pull has happened', () => {
    const store = makeStore();
    const { api } = fakeApi();
    const mgr = new SaveManager({ store, api, getCredential });

    expect(mgr.consumeActiveMatch()).toBeNull();
  });

  it('a later pull that finds no match clears a ticket nobody consumed', async () => {
    // refresh() re-reads `activeMatch` the same way bootstrap does. A stale ticket surviving a pull
    // that says the match is over is the failure this pins: the resume dialog would offer a room
    // that no longer exists.
    const store = makeStore();
    let active: ActiveMatchInfo | undefined = ACTIVE_MATCH;
    const cloud = makeNewSave('acc-cloud', 1);
    const api = {
      hasToken: () => true,
      auth: async () => ({ accountId: 'acc-cloud' }),
      getSave: async () => ({ save: cloud, ...(active ? { activeMatch: active } : {}) }),
    } as unknown as ApiClient;

    const mgr = new SaveManager({ store, api, getCredential });
    await mgr.bootstrap();
    active = undefined;
    await mgr.refresh();

    expect(mgr.consumeActiveMatch()).toBeNull();
  });
});
