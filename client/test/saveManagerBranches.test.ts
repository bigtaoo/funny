/**
 * `game/meta/SaveManager.ts` — the branches `save-manager.test.ts` does not reach.
 *
 * That file is thorough about the happy paths of refresh / reconcile / the offline clear queue.
 * What it never drives is the *unequip* half of the three optimistic equip helpers, the
 * self-correcting failure arm behind them, the stamina regen arithmetic, the pveEnter settle
 * failure, and the three-way `needsReplay && verifyId && replay` gate on both the online and the
 * flushed-offline clear path — 19 uncovered branches, the second-largest cluster in the client.
 *
 * These are the paths where the client and the server disagree about a player's stuff, so the
 * untaken side is usually the one that loses something: an unequip that writes `''` into
 * `equipped` instead of deleting the key shows an empty title forever; a rejected optimistic
 * write with no follow-up refresh leaves the client permanently claiming an item the server says
 * it does not own; a stamina spend whose settle request fails and is not queued is stamina the
 * player paid twice.
 */
import { describe, it, expect, vi } from 'vitest';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { makeNewSave, type CardInstance, type EquipmentInstance, type SaveData } from '../src/game/meta';
import { ApiError, type ApiClient } from '../src/net/ApiClient';
import type { IStorage } from '../src/platform/IPlatform';
import type { Replay } from '@nw/engine/types';

const STAMINA_CAP = 120;
const REGEN_MS = 6 * 60 * 1000;

class MemStorage implements IStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

function store(seed?: SaveData): LocalSaveStore {
  const s = new LocalSaveStore(new MemStorage());
  if (seed) s.saveLocal(seed);
  return s;
}

/** An ApiClient stub: every method is a vi.fn, overridable per case. */
function api(over: Partial<Record<string, unknown>> = {}, hasToken = true): ApiClient {
  const cloud = makeNewSave('a', 1);
  return {
    hasToken: () => hasToken,
    getSave: vi.fn(async () => ({ save: cloud })),
    equipTitle: vi.fn(async () => ({ save: cloud })),
    equipAvatar: vi.fn(async () => ({ save: cloud })),
    equipSkin: vi.fn(async () => ({ save: cloud })),
    setFlag: vi.fn(async () => ({ save: cloud })),
    pveEnter: vi.fn(async () => ({ stamina: { current: 99, regenAt: 0 } })),
    pveClear: vi.fn(async () => ({ save: cloud })),
    pveVerify: vi.fn(async () => ({ save: cloud })),
    ...over,
  } as unknown as ApiClient;
}

/** Let the fire-and-forget `.then()` chains inside the optimistic writers settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── The three optimistic equip helpers ──────────────────────────────────────────────────────

describe('optimistic equip / unequip', () => {
  it('unequipping DELETES the key rather than writing an empty string', () => {
    // `equipped.title = ''` would render as an empty title chip and would also be a truthy-looking
    // "has a title" value to every reader that only checks presence.
    const local = makeNewSave('a', 1);
    local.equipped = { title: 't_hero', avatar: 'preset:a', 'skin:infantry': 's1' };
    const mgr = new SaveManager({ store: store(local), api: api() });

    mgr.equipTitle(null);
    mgr.equipAvatar(null);
    mgr.equipSkin('infantry' as never, null);
    expect('title' in mgr.get().equipped).toBe(false);
    expect('avatar' in mgr.get().equipped).toBe(false);
    expect('skin:infantry' in mgr.get().equipped).toBe(false);
  });

  it('sends the empty string for a title/avatar unequip and null for a skin unequip', () => {
    // The three endpoints disagree on how "none" is spelled, so the `?? ''` is load-bearing:
    // sending `null` where the server expects a string is a 400, i.e. an unequip that never lands.
    const calls = {
      equipTitle: vi.fn(async () => ({ save: makeNewSave('a', 1) })),
      equipAvatar: vi.fn(async () => ({ save: makeNewSave('a', 1) })),
      equipSkin: vi.fn(async () => ({ save: makeNewSave('a', 1) })),
    };
    const mgr = new SaveManager({ store: store(), api: api(calls) });
    mgr.equipTitle(null);
    mgr.equipAvatar(null);
    mgr.equipSkin('archer' as never, null);
    expect(calls.equipTitle).toHaveBeenCalledWith('');
    expect(calls.equipAvatar).toHaveBeenCalledWith('');
    expect(calls.equipSkin).toHaveBeenCalledWith('archer', null);

    mgr.equipTitle('t_x');
    expect(calls.equipTitle).toHaveBeenLastCalledWith('t_x');
  });

  it('writes locally but issues no request while offline', () => {
    const calls = { equipTitle: vi.fn() };
    const mgr = new SaveManager({ store: store(), api: api(calls, /*hasToken*/ false) });
    mgr.equipTitle('t_x');
    expect(mgr.get().equipped.title).toBe('t_x');
    expect(calls.equipTitle).not.toHaveBeenCalled();
  });

  it('a rejected equip triggers a corrective refresh, so a bad local value cannot stick', () => {
    // This is the whole reason the optimistic write is allowed: the server rejecting an unowned
    // item (403) has to end with the client agreeing with the server, not keeping its guess.
    const getSave = vi.fn(async () => ({ save: makeNewSave('a', 1) }));
    const mgr = new SaveManager({
      store: store(),
      api: api({ equipTitle: vi.fn(async () => { throw new Error('403'); }), getSave }),
    });
    mgr.equipTitle('t_not_owned');
    return settle().then(() => {
      expect(getSave).toHaveBeenCalled();
    });
  });

  it('a rejected setFlag triggers the same corrective refresh', () => {
    const getSave = vi.fn(async () => ({ save: makeNewSave('a', 1) }));
    const mgr = new SaveManager({
      store: store(),
      api: api({ setFlag: vi.fn(async () => { throw new Error('boom'); }), getSave }),
    });
    mgr.setFlag('seen_intro', true);
    expect(mgr.getFlag('seen_intro')).toBe(true);
    return settle().then(() => expect(getSave).toHaveBeenCalled());
  });
});

// ── refresh's failure arm and resetForLogout ────────────────────────────────────────────────

describe('refresh and logout', () => {
  it('refresh answers false (and throws nothing) when the pull fails', async () => {
    const mgr = new SaveManager({
      store: store(),
      api: api({ getSave: vi.fn(async () => { throw new Error('offline'); }) }),
    });
    await expect(mgr.refresh()).resolves.toBe(false);
  });

  it('refresh answers false without a request when there is no token', async () => {
    const getSave = vi.fn();
    const mgr = new SaveManager({ store: store(), api: api({ getSave }, /*hasToken*/ false) });
    await expect(mgr.refresh()).resolves.toBe(false);
    expect(getSave).not.toHaveBeenCalled();
  });

  it('resetForLogout drops the local save, the queues, and notifies listeners', async () => {
    const local = makeNewSave('a', 1);
    local.progress.cleared.push('ch1_lv1');
    const st = store(local);
    const mgr = new SaveManager({ store: st, api: api({}, /*hasToken*/ false) });
    mgr.spendStaminaForLevel('ch1_lv1', 5); // offline → queued
    void mgr.recordClear('ch1_lv1', 3);
    expect(mgr.getPendingStaminaSpends()).toHaveLength(1);

    let notified = 0;
    mgr.subscribe(() => { notified++; });
    await mgr.resetForLogout();

    expect(mgr.get().progress.cleared).toEqual([]);
    expect(mgr.getPendingClears()).toEqual([]);
    expect(mgr.getPendingStaminaSpends()).toEqual([]);
    expect(notified).toBeGreaterThan(0);
    expect(st.loadLocal().progress.cleared).toEqual([]);
  });

  it('resetForLogout settles both queues first when still online', async () => {
    const pveClear = vi.fn(async () => ({ save: makeNewSave('a', 1) }));
    const pveEnter = vi.fn(async () => ({ stamina: { current: 50, regenAt: 0 } }));
    const st = store();
    st.savePending([{ levelId: 'ch1_lv1', stars: 3, ts: 1 }]);
    st.savePendingStamina([{ levelId: 'ch1_lv1', cost: 5, ts: 1 }]);
    const mgr = new SaveManager({ store: st, api: api({ pveClear, pveEnter }) });

    await mgr.resetForLogout();
    expect(pveClear).toHaveBeenCalledTimes(1);
    expect(pveEnter).toHaveBeenCalledTimes(1);
  });
});

// ── adoptServerPartial's four optional patch lists ──────────────────────────────────────────

describe('adoptServerPartial', () => {
  const lean = (): SaveData => {
    const s = makeNewSave('a', 1) as unknown as Record<string, unknown>;
    return { ...s, equipmentInv: null, cardInv: null } as unknown as SaveData;
  };
  const equip = (id: string): EquipmentInstance => ({ id, defId: 'w_1', level: 0, affixes: [] } as unknown as EquipmentInstance);
  const card = (id: string): CardInstance => ({ id, defId: 'c_1', level: 1, count: 1 } as unknown as CardInstance);

  it('applies removes before upserts on both inventories', () => {
    const local = makeNewSave('a', 1);
    local.equipmentInv = { e_old: equip('e_old'), e_keep: equip('e_keep') };
    local.cardInv = { c_old: card('c_old'), c_keep: card('c_keep') };
    const mgr = new SaveManager({ store: store(local), api: api() });

    mgr.adoptServerPartial(lean() as never, {
      remove: ['e_old'],
      upsert: [equip('e_new')],
      cardRemove: ['c_old'],
      cardUpsert: [card('c_new')],
    });
    expect(Object.keys(mgr.get().equipmentInv).sort()).toEqual(['e_keep', 'e_new']);
    expect(Object.keys(mgr.get().cardInv).sort()).toEqual(['c_keep', 'c_new']);
  });

  it('an empty patch leaves both inventories exactly as they were', () => {
    // Every one of the four lists is optional, and a lean response carries `null` inventories —
    // so with no patch the `?? []` fallbacks are the only thing keeping the local maps alive.
    const local = makeNewSave('a', 1);
    local.equipmentInv = { e_keep: equip('e_keep') };
    local.cardInv = { c_keep: card('c_keep') };
    const mgr = new SaveManager({ store: store(local), api: api() });

    mgr.adoptServerPartial(lean() as never, {});
    expect(Object.keys(mgr.get().equipmentInv)).toEqual(['e_keep']);
    expect(Object.keys(mgr.get().cardInv)).toEqual(['c_keep']);
  });
});

// ── Stamina: regen arithmetic, the spend gate, and the settle queue ─────────────────────────

describe('stamina', () => {
  function withStamina(current: number, regenAt: number): SaveData {
    const s = makeNewSave('a', 1);
    s.stamina = { current, regenAt };
    return s;
  }

  it('refuses a spend it cannot afford, but still banks the regen catch-up it just computed', () => {
    // Losing the catch-up here would mean the player's stamina appears to stand still while a
    // blocked entry screen is open.
    const due = Date.now() - REGEN_MS * 2;
    const st = store(withStamina(1, due));
    const mgr = new SaveManager({ store: st, api: api() });
    expect(mgr.spendStaminaForLevel('ch1_lv1', 50)).toBe(false);
    expect(mgr.get().stamina!.current).toBe(4); // 1 + 3 regen ticks
    expect(st.loadLocal().stamina!.current).toBe(4);
  });

  it('keeps an in-flight regen deadline instead of restarting the timer on every spend', () => {
    // Restarting it would let a player farm stamina by entering levels: each spend would push the
    // next regen tick a full 6 minutes into the future... or pull it closer, depending on the sign.
    const deadline = Date.now() + REGEN_MS - 1_000;
    const mgr = new SaveManager({ store: store(withStamina(50, deadline)), api: api({}, false) });
    expect(mgr.spendStaminaForLevel('ch1_lv1', 5)).toBe(true);
    expect(mgr.get().stamina).toEqual({ current: 45, regenAt: deadline });
  });

  it('starts the regen timer when spending down from a full bar', () => {
    const before = Date.now();
    const mgr = new SaveManager({ store: store(withStamina(STAMINA_CAP, 0)), api: api({}, false) });
    expect(mgr.spendStaminaForLevel('ch1_lv1', 5)).toBe(true);
    const { current, regenAt } = mgr.get().stamina!;
    expect(current).toBe(STAMINA_CAP - 5);
    expect(regenAt).toBeGreaterThanOrEqual(before + REGEN_MS);
  });

  it('leaves the timer off when a zero-cost spend keeps the bar full', () => {
    // `regenAt` must stay 0 at cap: a non-zero deadline on a full bar is what makes the regen
    // catch-up overshoot the moment one point is spent.
    const mgr = new SaveManager({ store: store(withStamina(STAMINA_CAP, 0)), api: api({}, false) });
    expect(mgr.spendStaminaForLevel('ch1_lv1', 0)).toBe(true);
    expect(mgr.get().stamina).toEqual({ current: STAMINA_CAP, regenAt: 0 });
  });

  it('regen clamps at the cap and clears the deadline once full', () => {
    const longAgo = Date.now() - REGEN_MS * 500;
    const mgr = new SaveManager({ store: store(withStamina(10, longAgo)), api: api({}, false) });
    mgr.spendStaminaForLevel('ch1_lv1', 0);
    expect(mgr.get().stamina).toEqual({ current: STAMINA_CAP, regenAt: 0 });
  });

  it('does not regen while the deadline is still in the future, or when it is unset', () => {
    const future = Date.now() + REGEN_MS;
    const a = new SaveManager({ store: store(withStamina(30, future)), api: api({}, false) });
    a.spendStaminaForLevel('ch1_lv1', 0);
    expect(a.get().stamina).toEqual({ current: 30, regenAt: future });

    // regenAt 0 below the cap is the "nothing scheduled" shape; it must not read as "due since
    // the epoch" and instantly refill the bar.
    const b = new SaveManager({ store: store(withStamina(30, 0)), api: api({}, false) });
    b.spendStaminaForLevel('ch1_lv1', 0);
    expect(b.get().stamina!.current).toBe(30);
  });

  it('adopts the server stamina when the settle request succeeds', async () => {
    const mgr = new SaveManager({
      store: store(withStamina(100, 0)),
      api: api({ pveEnter: vi.fn(async () => ({ stamina: { current: 77, regenAt: 12345 } })) }),
    });
    mgr.spendStaminaForLevel('ch1_lv1', 5);
    await settle();
    expect(mgr.get().stamina).toEqual({ current: 77, regenAt: 12345 });
    expect(mgr.getPendingStaminaSpends()).toHaveLength(0);
  });

  it('queues the spend when the settle request fails, so the server eventually catches up', async () => {
    const mgr = new SaveManager({
      store: store(withStamina(100, 0)),
      api: api({ pveEnter: vi.fn(async () => { throw new Error('offline'); }) }),
    });
    mgr.spendStaminaForLevel('ch1_lv1', 5);
    await settle();
    expect(mgr.getPendingStaminaSpends()).toEqual([
      expect.objectContaining({ levelId: 'ch1_lv1', cost: 5 }),
    ]);
    expect(mgr.get().stamina!.current).toBe(95); // the local deduction stands either way
  });

  it('drops a queued spend the server rejects on business grounds, and keeps one it cannot reach', async () => {
    const st = store(withStamina(100, 0));
    st.savePendingStamina([
      { levelId: 'bad_level', cost: 5, ts: 1 },
      { levelId: 'ch1_lv1', cost: 5, ts: 2 },
    ]);
    let call = 0;
    const mgr = new SaveManager({
      store: st,
      api: api({
        pveEnter: vi.fn(async () => {
          call++;
          if (call === 1) throw new ApiError('UNKNOWN_LEVEL', 'no such level');
          throw new Error('network');
        }),
      }),
    });
    await mgr.refresh();
    // The unsettleable entry is discarded so it cannot block the queue forever; the one that only
    // failed to reach the server stays for the next attempt.
    expect(mgr.getPendingStaminaSpends().map((e) => e.levelId)).toEqual(['ch1_lv1']);
  });

  it('stops flushing when the token is dropped mid-refresh', async () => {
    // The realistic shape: getSave succeeds, a 401 elsewhere clears the token, and by the time
    // refresh() reaches the queue flushes the client is no longer online. Both flushes have to
    // notice that rather than calling an endpoint with no credential.
    const st = store(withStamina(100, 0));
    st.savePending([{ levelId: 'ch1_lv1', stars: 3, ts: 1 }]);
    st.savePendingStamina([{ levelId: 'ch1_lv1', cost: 5, ts: 1 }]);
    const pveClear = vi.fn(async () => ({ save: makeNewSave('a', 1) }));
    const pveEnter = vi.fn(async () => ({ stamina: { current: 50, regenAt: 0 } }));

    // refresh() asks once; flushPending asks next; flushPendingStamina asks last.
    let asks = 0;
    const dropAfter = (n: number): ApiClient => ({
      ...(api({ pveClear, pveEnter }) as unknown as Record<string, unknown>),
      hasToken: () => ++asks <= n,
    }) as unknown as ApiClient;

    asks = 0;
    await new SaveManager({ store: st, api: dropAfter(1) }).refresh();
    expect(pveClear).not.toHaveBeenCalled();
    expect(pveEnter).not.toHaveBeenCalled();

    // Dropped one step later: the clear queue flushes, the stamina queue does not.
    asks = 0;
    await new SaveManager({ store: st, api: dropAfter(2) }).refresh();
    expect(pveClear).toHaveBeenCalledTimes(1);
    expect(pveEnter).not.toHaveBeenCalled();
  });

  it('does not touch the stamina queue while offline', async () => {
    const st = store(withStamina(100, 0));
    st.savePendingStamina([{ levelId: 'ch1_lv1', cost: 5, ts: 1 }]);
    const pveEnter = vi.fn();
    const mgr = new SaveManager({ store: st, api: api({ pveEnter }, /*hasToken*/ false) });
    await mgr.refresh();
    expect(pveEnter).not.toHaveBeenCalled();
    expect(mgr.getPendingStaminaSpends()).toHaveLength(1);
  });
});

// ── recordClear / the L1 spot check ─────────────────────────────────────────────────────────

describe('recordClear and the replay spot check', () => {
  const replay = (): Replay =>
    ({ meta: { recordedAt: 1_700_000_000_000 }, endFrame: 900, frames: [] } as unknown as Replay);

  it('ignores a zero-star clear entirely', async () => {
    const pveClear = vi.fn();
    const mgr = new SaveManager({ store: store(), api: api({ pveClear }) });
    await mgr.recordClear('ch1_lv1', 0);
    expect(pveClear).not.toHaveBeenCalled();
    expect(mgr.get().progress.cleared).toEqual([]);
  });

  it('uploads the replay only when the server asks AND a replay is on hand', async () => {
    const pveVerify = vi.fn(async () => ({ save: makeNewSave('a', 1) }));
    const cloud = makeNewSave('a', 1);

    // ① asked, with a replay → uploaded.
    const asked = new SaveManager({
      store: store(),
      api: api({ pveClear: vi.fn(async () => ({ save: cloud, needsReplay: true, verifyId: 'v1' })), pveVerify }),
    });
    await asked.recordClear('ch1_lv1', 3, replay());
    expect(pveVerify).toHaveBeenCalledTimes(1);
    expect(pveVerify).toHaveBeenCalledWith('v1', expect.anything(), expect.anything());

    // ② asked, but this run has no replay (a mode that does not record one) → nothing uploaded,
    // and no crash trying to serialise `undefined`.
    pveVerify.mockClear();
    const noReplay = new SaveManager({
      store: store(),
      api: api({ pveClear: vi.fn(async () => ({ save: cloud, needsReplay: true, verifyId: 'v2' })), pveVerify }),
    });
    await noReplay.recordClear('ch1_lv1', 3);
    expect(pveVerify).not.toHaveBeenCalled();

    // ③ asked without a verifyId (a malformed/partial receipt) → also nothing uploaded.
    const noId = new SaveManager({
      store: store(),
      api: api({ pveClear: vi.fn(async () => ({ save: cloud, needsReplay: true })), pveVerify }),
    });
    await noId.recordClear('ch1_lv1', 3, replay());
    expect(pveVerify).not.toHaveBeenCalled();

    // ④ not asked → the ordinary case, still nothing uploaded.
    const notAsked = new SaveManager({
      store: store(),
      api: api({ pveClear: vi.fn(async () => ({ save: cloud })), pveVerify }),
    });
    await notAsked.recordClear('ch1_lv1', 3, replay());
    expect(pveVerify).not.toHaveBeenCalled();
  });

  it('swallows a failed replay upload — the clear itself already landed', async () => {
    const cloud = makeNewSave('a', 1);
    const mgr = new SaveManager({
      store: store(),
      api: api({
        pveClear: vi.fn(async () => ({ save: cloud, needsReplay: true, verifyId: 'v1' })),
        pveVerify: vi.fn(async () => { throw new Error('recalc failed'); }),
      }),
    });
    // The clear itself is already settled server-side (the receipt was adopted); only the
    // material credit for this run is lost, so recordClear must resolve rather than reject.
    await expect(mgr.recordClear('ch1_lv1', 3, replay())).resolves.toBeUndefined();
    expect(mgr.getPendingClears()).toHaveLength(0);
  });

  it('falls back to the offline queue when an online clear request fails, keeping the replay id', async () => {
    const mgr = new SaveManager({
      store: store(),
      api: api({ pveClear: vi.fn(async () => { throw new Error('network blip') }) }),
    });
    await mgr.recordClear('ch1_lv1', 2, replay());
    expect(mgr.getPendingClears()).toEqual([
      expect.objectContaining({ levelId: 'ch1_lv1', stars: 2, replayId: expect.any(String) }),
    ]);
    // Optimistic local unlock still stands, so the next level is playable offline.
    expect(mgr.get().progress.cleared).toContain('ch1_lv1');
  });

  it('queues without a replay id when the run recorded no replay', async () => {
    const mgr = new SaveManager({ store: store(), api: api({}, /*hasToken*/ false) });
    await mgr.recordClear('ch1_lv1', 1);
    const [entry] = mgr.getPendingClears();
    expect('replayId' in entry!).toBe(false);
  });
});

// ── flushPending's spot-check path ──────────────────────────────────────────────────────────

describe('flushPending', () => {
  const cloud = makeNewSave('a', 1);

  it('uploads a stored replay for a flushed clear the server spot-checks', async () => {
    const pveVerify = vi.fn(async () => ({ save: cloud }));
    const st = store();
    st.savePending([{ levelId: 'ch1_lv1', stars: 3, ts: 1, replayId: 'r1' }]);
    const loadReplay = vi.fn(() => ({ meta: { recordedAt: 1 }, endFrame: 10, frames: [] } as unknown as Replay));
    const mgr = new SaveManager({
      store: st,
      api: api({ pveClear: vi.fn(async () => ({ save: cloud, needsReplay: true, verifyId: 'v9' })), pveVerify }),
      loadReplay,
    });
    await mgr.refresh();
    expect(loadReplay).toHaveBeenCalledWith('r1');
    expect(pveVerify).toHaveBeenCalledTimes(1);
    expect(mgr.getPendingClears()).toHaveLength(0);
  });

  it('settles the clear anyway when the stored replay has been evicted', async () => {
    // Materials are not credited this round, but the entry must not be stuck in the queue forever
    // waiting for a replay that no longer exists.
    const pveVerify = vi.fn();
    const st = store();
    st.savePending([{ levelId: 'ch1_lv1', stars: 3, ts: 1, replayId: 'gone' }]);
    const mgr = new SaveManager({
      store: st,
      api: api({ pveClear: vi.fn(async () => ({ save: cloud, needsReplay: true, verifyId: 'v9' })), pveVerify }),
      loadReplay: () => null,
    });
    await mgr.refresh();
    expect(pveVerify).not.toHaveBeenCalled();
    expect(mgr.getPendingClears()).toHaveLength(0);
  });

  it('skips the upload when the queued entry has no replay id, or no loader is wired', async () => {
    const pveVerify = vi.fn();
    const pveClear = vi.fn(async () => ({ save: cloud, needsReplay: true, verifyId: 'v9' }));

    const noId = store();
    noId.savePending([{ levelId: 'ch1_lv1', stars: 3, ts: 1 }]);
    await new SaveManager({ store: noId, api: api({ pveClear, pveVerify }), loadReplay: () => null }).refresh();
    expect(pveVerify).not.toHaveBeenCalled();

    const noLoader = store();
    noLoader.savePending([{ levelId: 'ch1_lv1', stars: 3, ts: 1, replayId: 'r1' }]);
    await new SaveManager({ store: noLoader, api: api({ pveClear, pveVerify }) }).refresh();
    expect(pveVerify).not.toHaveBeenCalled();
  });
});

// ── progress.best merge (the one local-display field reconcile still unions) ────────────────

describe('progress.best merge', () => {
  it('keeps a local best the cloud has never seen, and takes the better of the two otherwise', async () => {
    const local = makeNewSave('a', 1);
    local.progress.best = {
      ch1_lv1: { timeMs: 40_000, leaked: 0 },  // faster than cloud → local wins
      ch1_lv9: { timeMs: 90_000, leaked: 2 },  // cloud has no entry → local carried through
    };
    const cloud = makeNewSave('a', 1);
    cloud.progress.best = {
      ch1_lv1: { timeMs: 55_000, leaked: 0 },
      ch1_lv2: { timeMs: 30_000, leaked: 1 },  // local has no entry → cloud carried through
    };
    const mgr = new SaveManager({ store: store(local), api: api({ getSave: async () => ({ save: cloud }) }) });
    await mgr.refresh();

    const best = mgr.get().progress.best;
    expect(best.ch1_lv1!.timeMs).toBe(40_000);
    expect(best.ch1_lv2!.timeMs).toBe(30_000);
    expect(best.ch1_lv9!.timeMs).toBe(90_000);
  });

  it('lets the local entry win a tie it deserves, and treats every missing metric as worst', async () => {
    const local = makeNewSave('a', 1);
    local.progress.best = {
      localWins: { timeMs: 50_000, leaked: 0 },   // same time, fewer leaks → local
      localNoLeak: { timeMs: 50_000 } as never,   // no leaked count → loses the tie
      cloudNoTime: { timeMs: 70_000, leaked: 4 }, // cloud has no time at all → local wins
      cloudNoLeak: { timeMs: 50_000, leaked: 2 }, // same time, cloud has no leak count → local
    };
    const cloud = makeNewSave('a', 1);
    cloud.progress.best = {
      localWins: { timeMs: 50_000, leaked: 2 },
      localNoLeak: { timeMs: 50_000, leaked: 1 },
      cloudNoTime: { leaked: 0 } as never,
      cloudNoLeak: { timeMs: 50_000 } as never,
    };
    const mgr = new SaveManager({ store: store(local), api: api({ getSave: async () => ({ save: cloud }) }) });
    await mgr.refresh();

    const best = mgr.get().progress.best;
    expect(best.localWins!.leaked).toBe(0);
    expect(best.localNoLeak!.leaked).toBe(1);
    expect(best.cloudNoTime!.timeMs).toBe(70_000);
    expect(best.cloudNoLeak!.leaked).toBe(2);
  });

  it('breaks a tie on time by fewer leaked units, and treats a missing metric as worst', async () => {
    const local = makeNewSave('a', 1);
    local.progress.best = {
      tie: { timeMs: 50_000, leaked: 3 },
      noTime: {} as never,
    };
    const cloud = makeNewSave('a', 1);
    cloud.progress.best = {
      tie: { timeMs: 50_000, leaked: 1 },
      noTime: { timeMs: 10_000, leaked: 0 },
    };
    const mgr = new SaveManager({ store: store(local), api: api({ getSave: async () => ({ save: cloud }) }) });
    await mgr.refresh();

    expect(mgr.get().progress.best.tie!.leaked).toBe(1);
    // An entry with no timeMs at all loses to any recorded time (Infinity vs 10 s).
    expect(mgr.get().progress.best.noTime!.timeMs).toBe(10_000);
  });
});

// ── SaveStore: the two offline queues' parsers ──────────────────────────────────────────────

describe('LocalSaveStore queue parsing', () => {
  function raw(): { st: LocalSaveStore; mem: MemStorage } {
    const mem = new MemStorage();
    return { st: new LocalSaveStore(mem), mem };
  }

  it('round-trips both queues and removes the key entirely when a queue empties', () => {
    const { st, mem } = raw();
    st.savePending([{ levelId: 'a', stars: 3, ts: 7, replayId: 'r1' }]);
    st.savePendingStamina([{ levelId: 'a', cost: 5, ts: 7 }]);
    expect(st.loadPending()).toEqual([{ levelId: 'a', stars: 3, ts: 7, replayId: 'r1' }]);
    expect(st.loadPendingStamina()).toEqual([{ levelId: 'a', cost: 5, ts: 7 }]);

    // Writing an empty list must clear the key, not leave a `[]` behind for the next boot to parse.
    const keysBefore = mem.map.size;
    st.savePending([]);
    st.savePendingStamina([]);
    expect(mem.map.size).toBeLessThan(keysBefore);
    expect(st.loadPending()).toEqual([]);
    expect(st.loadPendingStamina()).toEqual([]);
  });

  it('treats corrupt or non-array queue storage as an empty queue rather than throwing', () => {
    // A half-written localStorage value must not brick startup: the manager reads both queues in
    // its constructor, so a throw here is a black screen on launch.
    for (const bad of ['{not json', '{"a":1}', '"a string"', '42', 'null']) {
      const { st, mem } = raw();
      mem.map.set('nw_pending_clears_v1', bad);
      mem.map.set('nw_pending_stamina_v1', bad);
      expect(st.loadPending(), bad).toEqual([]);
      expect(st.loadPendingStamina(), bad).toEqual([]);
    }
  });

  it('drops entries missing their identifying fields and defaults a missing timestamp to 0', () => {
    const { st, mem } = raw();
    mem.map.set('nw_pending_clears_v1', JSON.stringify([
      null,
      { stars: 3 },                              // no levelId
      { levelId: 'a' },                          // no stars
      { levelId: 'b', stars: '3' },              // stars of the wrong type
      { levelId: 'c', stars: 2 },                // no ts / no replayId
      { levelId: 'd', stars: 1, ts: 'soon', replayId: 5 }, // both of the wrong type
    ]));
    expect(st.loadPending()).toEqual([
      { levelId: 'c', stars: 2, ts: 0 },
      { levelId: 'd', stars: 1, ts: 0 },
    ]);

    mem.map.set('nw_pending_stamina_v1', JSON.stringify([
      undefined,
      { cost: 5 },
      { levelId: 'a' },
      { levelId: 'b', cost: '5' },
      { levelId: 'c', cost: 5 },
      { levelId: 'd', cost: 5, ts: null },
    ]));
    expect(st.loadPendingStamina()).toEqual([
      { levelId: 'c', cost: 5, ts: 0 },
      { levelId: 'd', cost: 5, ts: 0 },
    ]);
  });
});
