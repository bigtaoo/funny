// Coverage for `client/src/scenes/worldmap/net/push.ts` — the five live-push handlers
// (worldsvc → gateway → NetSession → here, §14.5).
//
// 0% until now, and the reason that matters is that **there is nothing behind these five.** The 5s
// setInterval that used to re-fetch marches/occupations/stationed/worldChannel was deleted in
// comm-audit-2026-07-27 P1-2, on the explicit grounds that the push channel already fires on every
// real state change — `WorldMapNet.start()`/`destroy()` are no-ops today and say so. So a handler
// that drops or mis-routes its push does not cost a few seconds of freshness; the state stays wrong
// until something unrelated happens to refetch it, in practice until the player leaves the SLG and
// comes back. That failure has already shipped once in exactly this shape: occupation settlement
// pushes `tile_update` only, `applyTileUpdate` refetches tiles only, and every settled occupation
// stayed in `ctx.occupations` forever — marking its team permanently busy, so the team picker
// listed nothing at all (SLG_LOG_2026-08 §523). Nothing threw; the report was "I can't select any
// team".
//
// `applySiegeResult` is worse still, because it is the only thing that TELLS the player who won.
// Telling someone who just took a territory that they lost one is the 2026-08-02 bug, from back
// when the initiator check came from a per-scene in-memory Set that a scene rebuild wiped.
//
// So the assertions below are about branch SELECTION and payload PROVENANCE, not about wording:
//   · every handler drops the push when the scene is already torn down;
//   · the initiator/kind classification comes from the payload (`attackerId` / `marchKind`) and
//     nothing else — that is what the 2026-08-02 fix bought;
//   · the attack-win split between "hold started" (toast) and "final outcome" (modal + replay)
//     reads the freshly refetched tile's `contestedByMe`, which is why the refetch is awaited;
//   · the damage vignette fires only on our own base and only when hp actually dropped — it is
//     diffed around the refetch because TileUpdate carries no hp;
//   · an attacker-controlled display name reaches the toast verbatim (the 2026-08-03 fix).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Two stubs, and both are seams rather than conveniences. `render/sketchUi` is the only
// pixi.js-legacy import in the module — it is used purely for two palette entries, so distinctive
// sentinels make the win/loss COLOUR assertable (a toast with the right words and the wrong colour
// is a real regression: green-on-loss reads as a win at a glance). `./loaders` is the network +
// redraw boundary; stubbing it is what lets a case control what the refetch leaves in tileCache.
// The literals are repeated inside the factory on purpose: vi.mock is hoisted above every
// top-level binding, so a factory referencing RED/DARK throws at import time.
vi.mock('../src/render/sketchUi', () => ({ ui: { red: 0xff0001, dark: 0x000002 } }));
const RED = 0xff0001;
const DARK = 0x000002;

const loadMapViewport = vi.fn(async (_ctx: unknown) => {});
const refreshMarches = vi.fn(async (_ctx: unknown) => {});
const refreshMe = vi.fn(async (_ctx: unknown) => {});
vi.mock('../src/scenes/worldmap/net/loaders', () => ({
  loadMapViewport: (ctx: unknown) => loadMapViewport(ctx),
  refreshMarches: (ctx: unknown) => refreshMarches(ctx),
  refreshMe: (ctx: unknown) => refreshMe(ctx),
}));

import {
  applyMarchUpdate, applyNationMsg, applyTileUpdate, applyUnderAttack, applySiegeResult,
} from '../src/scenes/worldmap/net/push';
import { setLocale, t } from '../src/i18n';
import type { WorldMapContext } from '../src/scenes/worldmap/WorldMapContext';
import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult, NationMsg } from '../src/net/proto/transport';

const ME = 'acct-me';
const OTHER = 'acct-other';

interface Fake {
  ctx: WorldMapContext;
  toasts: Array<{ msg: string; color?: number }>;
  modals: Array<{ lines: Array<{ text: string }>; buttons: Array<{ label: string; action: () => void }> }>;
  hudRenders: number;
  mapRenders: number;
  vignettes: number;
  closes: number;
  replays: string[];
  tiles: Map<string, { hp?: number; contestedByMe?: boolean }>;
}

function fake(over: Partial<{ destroyed: boolean; mainBaseTile: string; seenTs: number; unread: number }> = {}): Fake {
  const f: Fake = {
    toasts: [], modals: [], hudRenders: 0, mapRenders: 0, vignettes: 0, closes: 0, replays: [],
    tiles: new Map(), ctx: null as unknown as WorldMapContext,
  };
  const ctx = {
    destroyed: over.destroyed ?? false,
    me: over.mainBaseTile ? { mainBaseTile: over.mainBaseTile } : null,
    cb: { accountId: ME, onReplaySiege: (id: string) => f.replays.push(id) },
    worldChatLatest: null as unknown,
    worldChatUnread: over.unread ?? 0,
    getWorldChatSeenTs: () => over.seenTs ?? 0,
    // `w1:12:34` — the same three-part shape the real parseTileId splits (its own behaviour,
    // including the (0,0) fallback, is not this file's subject).
    parseTileId: (id: string) => {
      const [, x, y] = id.split(':');
      return [Number(x), Number(y)] as [number, number];
    },
    tileCache: f.tiles,
    view: {
      renderMap: () => { f.mapRenders++; },
      flashDamageVignette: () => { f.vignettes++; },
    },
    panels: {
      renderHud: () => { f.hudRenders++; },
      showToast: (msg: string, color?: number) => { f.toasts.push({ msg, color }); },
      showModal: (lines: never, buttons: never) => { f.modals.push({ lines, buttons }); },
      closeModal: () => { f.closes++; },
    },
    marchTokenRuntimes: new Map(),
    marchAttackUntil: new Map<string, number>(),
  };
  f.ctx = ctx as unknown as WorldMapContext;
  return f;
}

/**
 * Makes the stubbed refetch land its cache mutation on a LATER tick, the way a real one does.
 * This matters more than it looks: `async () => { cache.set(...) }` runs its body synchronously up
 * to the first await, so a stub written that way stays correct even if the production code stops
 * awaiting `loadMapViewport` — i.e. it silently stops testing the thing the 2026-08-09 change was
 * about (the classification below needs the FRESH tile, which is why that call is awaited while
 * refreshMe/refreshMarches are not).
 */
function viewportLands(mutate: () => void): void {
  loadMapViewport.mockImplementation(async () => {
    await new Promise<void>((r) => { setTimeout(r, 0); });
    mutate();
  });
}

function siege(over: Partial<SiegeResult> = {}): SiegeResult {
  return {
    siegeId: 's1', tile: 'w1:12:34', attackerId: ME, marchKind: 'attack',
    outcome: 'attacker_win', ...over,
  } as SiegeResult;
}

beforeEach(() => {
  setLocale('zh');
  loadMapViewport.mockReset();
  refreshMarches.mockReset();
  refreshMe.mockReset();
  loadMapViewport.mockResolvedValue(undefined);
  refreshMarches.mockResolvedValue(undefined);
  refreshMe.mockResolvedValue(undefined);
});

describe('worldmap push — teardown', () => {
  // A push in flight when the player leaves the SLG is the normal case, not an edge one: the
  // handlers are wired to the live NetSession and gateway keeps sending until the socket notices.
  // Every one of them has to be a no-op afterwards, and "it did nothing" is invisible either way.
  it('every handler ignores its push once ctx.destroyed', async () => {
    const f = fake({ destroyed: true, mainBaseTile: 'w1:1:1', unread: 0 });
    applyMarchUpdate(f.ctx, {} as MarchUpdate);
    applyNationMsg(f.ctx, { ts: 99, fromPublicId: 'p9', fromName: 'n', text: 'hi' } as NationMsg);
    applyTileUpdate(f.ctx, { tileId: 'w1:1:1' } as TileUpdate);
    applyUnderAttack(f.ctx, { tile: 'w1:1:1', arriveAt: Date.now() + 5000 } as UnderAttack);
    await applySiegeResult(f.ctx, siege());

    expect(loadMapViewport).not.toHaveBeenCalled();
    expect(refreshMarches).not.toHaveBeenCalled();
    expect(refreshMe).not.toHaveBeenCalled();
    expect(f.toasts).toEqual([]);
    expect(f.modals).toEqual([]);
    expect(f.hudRenders).toBe(0);
    expect(f.mapRenders).toBe(0);
    expect(f.ctx.worldChatUnread).toBe(0);
    expect(f.ctx.worldChatLatest).toBeNull();
  });
});

describe('worldmap push — applyMarchUpdate', () => {
  it('refetches marches (authoritative) rather than merging the payload', () => {
    const f = fake();
    applyMarchUpdate(f.ctx, { marchId: 'm1' } as MarchUpdate);
    expect(refreshMarches).toHaveBeenCalledTimes(1);
    expect(refreshMarches).toHaveBeenCalledWith(f.ctx);
  });
});

describe('worldmap push — applyNationMsg', () => {
  it('fills the HUD from the push payload and repaints it', () => {
    // Before this handler existed the push was dropped and a 5s poll re-fetched the same message.
    // That is the shape of "invisible": the HUD was right, just late.
    const f = fake({ seenTs: 500 });
    applyNationMsg(f.ctx, { ts: 700, fromPublicId: 'p7', fromName: '路人甲', text: '集合' } as NationMsg);

    expect(f.ctx.worldChatLatest).toEqual({
      id: 'push:700:p7', senderId: 'p7', senderPublicId: 'p7',
      senderName: '路人甲', body: '集合', ts: 700,
    });
    expect(f.ctx.worldChatUnread).toBe(1);
    expect(f.hudRenders).toBe(1);
  });

  it('does not raise the unread badge for a message at or below the seen marker', () => {
    // The read-marker comparison is strict `>`. Counting an already-read message would leave a
    // badge the player cannot clear by reading — they already did.
    for (const ts of [500, 499]) {
      const f = fake({ seenTs: 500, unread: 0 });
      applyNationMsg(f.ctx, { ts, fromPublicId: 'p1', fromName: 'n', text: 'x' } as NationMsg);
      expect(f.ctx.worldChatUnread).toBe(0);
      // ...but the latest-message line still updates: it is "latest", not "latest unread".
      expect(f.ctx.worldChatLatest).not.toBeNull();
      expect(f.hudRenders).toBe(1);
    }
  });

  it('accumulates the badge across several pushes', () => {
    const f = fake({ seenTs: 0, unread: 3 });
    applyNationMsg(f.ctx, { ts: 10, fromPublicId: 'p1', fromName: 'a', text: '1' } as NationMsg);
    applyNationMsg(f.ctx, { ts: 20, fromPublicId: 'p2', fromName: 'b', text: '2' } as NationMsg);
    expect(f.ctx.worldChatUnread).toBe(5);
    expect((f.ctx.worldChatLatest as { body: string }).body).toBe('2');
  });
});

describe('worldmap push — applyTileUpdate', () => {
  /** Wires the stub so the refetch "lands" a new hp for the given tile key. */
  function withRefetch(f: Fake, key: string, hp: number | undefined): void {
    viewportLands(() => {
      if (hp === undefined) f.tiles.delete(key);
      else f.tiles.set(key, { ...(f.tiles.get(key) ?? {}), hp });
    });
  }

  it('flashes the damage vignette when our own base lost durability', async () => {
    // D-CITY-8. TileUpdate carries no hp (see transport.proto), so the only way to know is to diff
    // the cache around the refetch — which means the diff has to be captured BEFORE awaiting.
    const f = fake({ mainBaseTile: 'w1:5:6' });
    f.tiles.set('5:6', { hp: 900 });
    withRefetch(f, '5:6', 700);

    applyTileUpdate(f.ctx, { tileId: 'w1:5:6' } as TileUpdate);
    await vi.waitFor(() => expect(f.mapRenders).toBe(1));
    expect(f.vignettes).toBe(1);
  });

  it('does not flash when our base hp is unchanged or repaired', async () => {
    for (const nextHp of [900, 950]) {
      const f = fake({ mainBaseTile: 'w1:5:6' });
      f.tiles.set('5:6', { hp: 900 });
      withRefetch(f, '5:6', nextHp);
      applyTileUpdate(f.ctx, { tileId: 'w1:5:6' } as TileUpdate);
      await vi.waitFor(() => expect(f.mapRenders).toBe(1));
      expect(f.vignettes).toBe(0);
    }
  });

  it('does not flash for a tile that is not our base, even if its hp dropped', async () => {
    // Someone else's wall taking damage inside our vision is a normal sight. A full-screen red
    // vignette for it would be a lie about being attacked.
    const f = fake({ mainBaseTile: 'w1:5:6' });
    f.tiles.set('9:9', { hp: 900 });
    withRefetch(f, '9:9', 100);
    applyTileUpdate(f.ctx, { tileId: 'w1:9:9' } as TileUpdate);
    await vi.waitFor(() => expect(f.mapRenders).toBe(1));
    expect(f.vignettes).toBe(0);
  });

  it('does not flash when the before or after hp is unknown', async () => {
    // Base tile outside the current viewport (nothing cached yet), or dropped from cache by the
    // refetch. "Unknown → assume damage" would flash on every pan back to base.
    const uncached = fake({ mainBaseTile: 'w1:5:6' });
    withRefetch(uncached, '5:6', 700); // prevHp undefined
    applyTileUpdate(uncached.ctx, { tileId: 'w1:5:6' } as TileUpdate);
    await vi.waitFor(() => expect(uncached.mapRenders).toBe(1));
    expect(uncached.vignettes).toBe(0);

    const evicted = fake({ mainBaseTile: 'w1:5:6' });
    evicted.tiles.set('5:6', { hp: 900 });
    withRefetch(evicted, '5:6', undefined); // nowHp undefined
    applyTileUpdate(evicted.ctx, { tileId: 'w1:5:6' } as TileUpdate);
    await vi.waitFor(() => expect(evicted.mapRenders).toBe(1));
    expect(evicted.vignettes).toBe(0);
  });

  it('does not flash, redraw or throw when the player has no base yet', async () => {
    const f = fake(); // me === null
    withRefetch(f, '0:0', 1);
    applyTileUpdate(f.ctx, { tileId: 'w1:5:6' } as TileUpdate);
    await vi.waitFor(() => expect(f.mapRenders).toBe(1));
    expect(f.vignettes).toBe(0);
  });

  it('drops a refetch that lands after teardown', async () => {
    const f = fake({ mainBaseTile: 'w1:5:6' });
    f.tiles.set('5:6', { hp: 900 });
    viewportLands(() => {
      f.tiles.set('5:6', { hp: 1 });
      (f.ctx as unknown as { destroyed: boolean }).destroyed = true;
    });
    applyTileUpdate(f.ctx, { tileId: 'w1:5:6' } as TileUpdate);
    await vi.waitFor(() => expect(loadMapViewport).toHaveBeenCalledTimes(1));
    expect(f.mapRenders).toBe(0);
    expect(f.vignettes).toBe(0);
  });
});

describe('worldmap push — applyUnderAttack', () => {
  it('renders the attacker name, tile and countdown into one toast', () => {
    const f = fake();
    const now = Date.now();
    applyUnderAttack(f.ctx, { tile: 'w1:3:4', arriveAt: now + 12_400, attackerName: '张三' } as UnderAttack);

    expect(f.toasts).toHaveLength(1);
    const { msg, color } = f.toasts[0]!;
    expect(color).toBe(RED);
    expect(msg).toContain(t('world.underAttack'));
    expect(msg).toContain('张三');
    expect(msg).toContain('(3,4)');
    // ceil of 12.4s
    expect(msg).toContain('13');
  });

  it('inserts an attacker-controlled name VERBATIM, including replacement-pattern characters', () => {
    // The 2026-08-03 fix. This used to be chained `String.replace(str, str)` calls, whose second
    // argument is a *pattern*: a display name of `$&` expanded to the matched placeholder text
    // instead of being inserted. Routing through t()'s single-pass callback makes values literal.
    // Player-chosen names are the one input here an attacker fully controls.
    for (const name of ['$&', '$`', "$'", '$$', '{sec}', '{tile}']) {
      const f = fake();
      applyUnderAttack(f.ctx, { tile: 'w1:1:2', arriveAt: Date.now() + 1000, attackerName: name } as UnderAttack);
      expect(f.toasts[0]!.msg).toContain(name);
    }
  });

  it('clamps an already-arrived countdown to 0 instead of showing a negative', () => {
    const f = fake();
    applyUnderAttack(f.ctx, { tile: 'w1:1:2', arriveAt: Date.now() - 30_000, attackerName: 'x' } as UnderAttack);
    expect(f.toasts[0]!.msg).toContain('0');
    expect(f.toasts[0]!.msg).not.toContain('-');
  });

  it('falls back to #publicId, then #?, when the attacker has no display name', () => {
    const withId = fake();
    applyUnderAttack(withId.ctx, { tile: 'w1:1:2', arriveAt: Date.now(), attackerName: '', attackerPublicId: 'p42' } as UnderAttack);
    expect(withId.toasts[0]!.msg).toContain('#p42');

    const anon = fake();
    applyUnderAttack(anon.ctx, { tile: 'w1:1:2', arriveAt: Date.now() } as UnderAttack);
    expect(anon.toasts[0]!.msg).toContain('#?');
  });
});

describe('worldmap push — applySiegeResult role classification', () => {
  it('always refetches the viewport, me and marches, and redraws', async () => {
    const f = fake();
    await applySiegeResult(f.ctx, siege({ marchKind: 'occupy' }));
    expect(loadMapViewport).toHaveBeenCalledTimes(1);
    expect(refreshMe).toHaveBeenCalledTimes(1);
    expect(refreshMarches).toHaveBeenCalledTimes(1);
    expect(f.mapRenders).toBe(1);
  });

  it('our own attack win that STARTED A HOLD is a toast, not a siege-won modal', async () => {
    // 2026-08-09 user decision: a territory win no longer hands ownership over instantly, it opens
    // the same OCCUPY_HOLD_SEC countdown. `contestedByMe` on the freshly refetched tile is the
    // server-authoritative signal — which is the whole reason loadMapViewport is awaited here and
    // fire-and-forget everywhere else in this function.
    const f = fake();
    viewportLands(() => f.tiles.set('12:34', { contestedByMe: true }));
    await applySiegeResult(f.ctx, siege());

    expect(f.toasts).toEqual([{ msg: t('world.siegeWinHold'), color: DARK }]);
    expect(f.modals).toEqual([]);
  });

  it('our own attack win that is FINAL opens the outcome modal with the loot line and a replay button', async () => {
    const f = fake();
    viewportLands(() => f.tiles.set('12:34', {})); // no contestedByMe
    await applySiegeResult(f.ctx, siege({ lootSummary: '墨水 ×120' }));

    expect(f.toasts).toEqual([]);
    expect(f.modals).toHaveLength(1);
    expect(f.modals[0]!.lines[0]!.text).toBe(t('world.siegeWin').replace('{loot}', '墨水 ×120'));
    const replay = f.modals[0]!.buttons.find((b) => b.label === t('world.replaySiege'))!;
    expect(replay).toBeDefined();
    replay.action();
    expect(f.closes).toBe(1);
    expect(f.replays).toEqual(['s1']);

    // Close dismisses and nothing else. Worth its own line because the two buttons differ by one
    // call and the modal is blocking: a close that also fired onReplaySiege would drop the player
    // into a replay they asked to leave.
    const close = f.modals[0]!.buttons.find((b) => b.label === t('common.close'))!;
    expect(close).toBeDefined();
    close.action();
    expect(f.closes).toBe(2);
    expect(f.replays).toEqual(['s1']);
  });

  it.each([
    ['defender_win', 'world.siegeLoss'],
    ['draw', 'world.siegeDraw'],
  ] as const)('our own attack ending %s opens the modal with its own line', async (outcome, key) => {
    const f = fake();
    viewportLands(() => f.tiles.set('12:34', { contestedByMe: true }));
    await applySiegeResult(f.ctx, siege({ outcome: outcome as SiegeResult['outcome'] }));
    // contestedByMe is set on purpose: the hold branch must be reachable only on attacker_win, or
    // a defeat would report itself as "won, countdown started".
    expect(f.toasts).toEqual([]);
    expect(f.modals[0]!.lines[0]!.text).toBe(t(key));
  });

  it.each([
    ['occupy', 'attacker_win', 'world.occupyWin', DARK],
    ['occupy', 'defender_win', 'world.occupyLoss', RED],
    ['move', 'attacker_win', 'world.encounterWin', DARK],
    ['move', 'defender_win', 'world.encounterLoss', RED],
  ] as const)('our own %s ending %s is a lightweight toast', async (kind, outcome, key, color) => {
    const f = fake();
    await applySiegeResult(f.ctx, siege({
      marchKind: kind as SiegeResult['marchKind'], outcome: outcome as SiegeResult['outcome'],
    }));
    expect(f.modals).toEqual([]);
    expect(f.toasts).toEqual([{ msg: t(key), color }]);
  });

  it.each([
    ['attacker_win', 'world.defendLost', RED],
    ['defender_win', 'world.defendHeld', DARK],
  ] as const)('someone ELSE’s attack ending %s is a defender toast with the inverted valence', async (outcome, key, color) => {
    // The valence flips because "attacker won" is our loss here. This is the pair the 2026-08-02
    // bug got backwards: it guessed initiator from a per-scene Set that a WorldMapScene rebuild
    // reset, so a player's own occupy win — with the march still in flight across a page reload —
    // arrived here as 领地失守.
    const f = fake();
    await applySiegeResult(f.ctx, siege({ attackerId: OTHER, outcome: outcome as SiegeResult['outcome'] }));
    expect(f.modals).toEqual([]);
    expect(f.toasts).toEqual([{ msg: t(key), color }]);
  });

  it('classifies by payload, not by which tile we happen to be looking at', async () => {
    // Same tile, same outcome, only attackerId differs — the two must not agree.
    const mine = fake();
    viewportLands(() => mine.tiles.set('12:34', { contestedByMe: true }));
    await applySiegeResult(mine.ctx, siege());

    const theirs = fake();
    await applySiegeResult(theirs.ctx, siege({ attackerId: OTHER }));

    expect(mine.toasts[0]!.msg).toBe(t('world.siegeWinHold'));
    expect(theirs.toasts[0]!.msg).toBe(t('world.defendLost'));
    expect(mine.toasts[0]!.msg).not.toBe(theirs.toasts[0]!.msg);
  });

  it('says nothing at all when the scene is torn down by the refetch', async () => {
    const f = fake();
    viewportLands(() => { (f.ctx as unknown as { destroyed: boolean }).destroyed = true; });
    await applySiegeResult(f.ctx, siege());
    expect(f.mapRenders).toBe(0);
    expect(f.toasts).toEqual([]);
    expect(f.modals).toEqual([]);
    // ...and the two fire-and-forget refreshes below the guard never start either.
    expect(refreshMe).not.toHaveBeenCalled();
    expect(refreshMarches).not.toHaveBeenCalled();
  });
});

describe('worldmap push — applySiegeResult attack-animation beat', () => {
  const NOW = 1_800_000_000_000;
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(NOW); });

  it('holds a stickman token in its attack clip for that clip’s own duration', async () => {
    // The march is about to leave ctx.marches and be torn down by fog.ts. Without this the attack
    // motion never plays: the token vanishes on the same frame the result arrives.
    const f = fake();
    (f.ctx.marchTokenRuntimes as Map<string, unknown>).set('m1', {
      mode: 'stickman', kind: 'swordsman', runtime: { currentDuration: 1.25 },
    });
    await applySiegeResult(f.ctx, siege({ marchId: 'm1' }));
    expect(f.ctx.marchAttackUntil.get('m1')).toBe(NOW + 1250);
  });

  it('falls back to the default beat for a dot token, or a stickman whose .tao has not loaded', async () => {
    for (const entry of [
      { mode: 'dot', kind: 'swordsman', sprite: {} },
      { mode: 'stickman', kind: 'swordsman', runtime: null },
      { mode: 'stickman', kind: 'swordsman', runtime: { currentDuration: 0 } },
    ]) {
      const f = fake();
      (f.ctx.marchTokenRuntimes as Map<string, unknown>).set('m1', entry);
      await applySiegeResult(f.ctx, siege({ marchId: 'm1' }));
      expect(f.ctx.marchAttackUntil.get('m1')).toBe(NOW + 600);
    }
  });

  it('records no beat for a march that has no live token, or no marchId at all', async () => {
    const noToken = fake();
    await applySiegeResult(noToken.ctx, siege({ marchId: 'gone' }));
    expect(noToken.ctx.marchAttackUntil.size).toBe(0);

    const noId = fake();
    await applySiegeResult(noId.ctx, siege({ marchId: '' }));
    expect(noId.ctx.marchAttackUntil.size).toBe(0);
  });
});
