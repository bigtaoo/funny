// Coverage for applySiegeResult classification (2026-07-22 bug fix, reworked 2026-08-02).
//
// The original bug: occupying a neutral tile runs a PvE battle server-side (ADR-037) and pushes a SiegeResult
// with outcome 'attacker_win' back to the OCCUPIER. applySiegeResult decided "did I attack or did I defend?"
// purely via myAttackTiles.has(tile) — but occupy marches were never recorded there, so a player's own
// successful land-grab fell into the defender branch and showed "Territory lost" (world.defendLost). A failed
// occupy was equally wrong (showed "Defense held").
//
// The 2026-07-22 fix tracked occupy targets in a client-side myOccupyTiles Set, populated only at dispatch
// time inside the same WorldMapContext instance. That Set is wiped every time WorldMapScene is rebuilt (leaving
// and re-entering the SLG, or a page reload) — so a march dispatched, then the scene torn down and rebuilt
// before the (possibly minutes-later) arrival push landed, reproduced the exact same "Territory lost" bug.
//
// The 2026-08-02 fix removes the client-side Set entirely: SiegeResult now always carries `attackerId` (who
// dispatched the offensive/occupy march) and `marchKind` (attack | occupy | ...), both sourced straight from
// the persisted SiegeDoc — server-authoritative, so the client never needs to remember its own past action.
//
// These drive applySiegeResult directly against a mock ctx (the network side-effects — loadMapViewport /
// refreshMe / refreshMarches — are stubbed; we only assert which message the classification produced).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initI18n, t } from '../../src/i18n';
import { WorldMapNet } from '../../src/scenes/worldmap/WorldMapNet';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { SiegeResult } from '../../src/net/proto/transport';

// 2026-08-13 (claudedocs/client-modules.md "单文件 500 行收敛" split): applySiegeResult's own
// loadMapViewport/refreshMe/refreshMarches calls (in net/push.ts) are now direct module-scope calls
// into net/loaders.ts, not `this.xxx` — the old `vi.spyOn(net, 'loadMapViewport')` etc. no longer
// intercepts them. None of the tests in this file assert call counts on these three (they're only
// stubbed so the fake `ctx` — which has no `worldApi`/`view.viewportCenter` wired — doesn't crash),
// so a straight no-op module mock (not wrapping the real implementation) is enough here.
vi.mock('../../src/scenes/worldmap/net/loaders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/scenes/worldmap/net/loaders')>();
  return { ...actual, loadMapViewport: vi.fn(async () => {}), refreshMe: vi.fn(async () => {}), refreshMarches: vi.fn(async () => {}) };
});

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const TILE = 'world:1:0:20:20';
const ME = 'acct-me';
const OTHER = 'acct-other';

function siege(outcome: string, attackerId: string, marchKind: string, tile = TILE): SiegeResult {
  // marchId '' skips the attack-animation block (marchTokenRuntimes lookup); irrelevant to classification.
  return { siegeId: 's1', tile, outcome, lootSummary: '', replayRef: '', marchId: '', attackerId, marchKind };
}

function buildHarness() {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const onReplaySiege = vi.fn();
  // 2026-08-09: the attack-win branch now looks up the just-refetched target tile's `contestedByMe`
  // (server-authoritative — same field the occupy branch already relies on) to tell an
  // occupation-hold start apart from an instant final outcome. Keyed like the real tileCache ("x:y").
  const tileCache = new Map<string, { contestedByMe?: boolean }>();

  const ctx = {
    destroyed: false,
    marchTokenRuntimes: new Map(),
    marchAttackUntil: new Map(),
    tileCache,
    parseTileId: (tileId: string): [number, number] => {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: vi.fn() },
    panels: { showModal, showToast },
    cb: { onReplaySiege, accountId: ME },
  } as unknown as WorldMapContext;

  const net = new WorldMapNet(ctx);
  // loadMapViewport/refreshMe/refreshMarches are stubbed no-ops at the module level (see the
  // vi.mock('.../net/loaders') block above) — applySiegeResult awaits loadMapViewport (2026-08-09:
  // no longer fire-and-forget, the attack-win branch needs the refetch to land before classifying),
  // refreshMe/refreshMarches stay fire-and-forget.
  return { ctx, net, showModal, showToast, onReplaySiege, tileCache };
}

describe('WorldMapNet.applySiegeResult — role is server-authoritative (attackerId/marchKind), not client memory', () => {
  let h: ReturnType<typeof buildHarness>;
  beforeEach(() => { h = buildHarness(); });

  it('a won occupy (mine) shows "occupy secured" toast — NOT "Territory lost", and no siege modal', async () => {
    await h.net.applySiegeResult(siege('attacker_win', ME, 'occupy'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.occupyWin'), expect.anything());
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
    expect(h.showModal).not.toHaveBeenCalled();
  });

  it('a lost occupy (mine) shows "occupation failed" toast — NOT "Defense held"', async () => {
    await h.net.applySiegeResult(siege('defender_win', ME, 'occupy'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.occupyLoss'), expect.anything());
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.defendHeld'), expect.anything());
  });

  it('a repeat/late delivery of the same occupy result still classifies correctly — no client-side "consumed" state to go stale (this is what used to break: the scene rebuilding between dispatch and arrival, or a re-delivered push, wiped the old myOccupyTiles bookkeeping)', async () => {
    await h.net.applySiegeResult(siege('attacker_win', ME, 'occupy'));
    h.showToast.mockClear();
    await h.net.applySiegeResult(siege('attacker_win', ME, 'occupy'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.occupyWin'), expect.anything());
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
  });

  it('surviving a WorldMapScene rebuild (leaving/re-entering the SLG mid-march, or a page reload): a fresh WorldMapContext with zero dispatch history still classifies its own occupy win correctly — this is the exact scenario the 2026-07-22 myAttackTiles/myOccupyTiles fix could not survive, since those Sets lived on the scene instance and were gone by the time a long-traveling march\'s result arrived', async () => {
    // Simulate the OLD harness (the one that would have "dispatched" the march) going away entirely —
    // a brand-new WorldMapContext/WorldMapNet pair, as WorldMapScene's app.ts showWorldMap() constructs on
    // every fresh entry into the SLG, with no shared state whatsoever from whatever dispatched the march.
    const rebuilt = buildHarness();
    await rebuilt.net.applySiegeResult(siege('attacker_win', ME, 'occupy'));
    expect(rebuilt.showToast).toHaveBeenCalledWith(t('world.occupyWin'), expect.anything());
    expect(rebuilt.showToast).not.toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
    expect(rebuilt.showModal).not.toHaveBeenCalled();
  });

  it('a won attack that finalizes instantly (base siege / structure chip / PvE stronghold-or-crossing — target tile has no contestedByMe) still opens the siege modal with replay, not a toast', async () => {
    await h.net.applySiegeResult(siege('attacker_win', ME, 'attack'));
    expect(h.showModal).toHaveBeenCalledTimes(1);
    const lines = h.showModal.mock.calls[0][0] as string[];
    expect(lines[0]).toBe(t('world.siegeWin').replace('{loot}', ''));
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it('2026-08-09: a won attack that starts an occupation hold — either a fresh capture of a PLAYER\'s territory (worldsvc landSiege) or an occupation-expulsion win (applyOccupationExpulsion) — both leave the target tile refetched with contestedByMe=true, and both get the same lightweight toast as an occupy win, no blocking modal', async () => {
    h.tileCache.set('20:20', { contestedByMe: true }); // TILE = 'world:1:0:20:20' → x=20,y=20
    await h.net.applySiegeResult(siege('attacker_win', ME, 'attack'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.siegeWinHold'), expect.anything());
    expect(h.showModal).not.toHaveBeenCalled();
  });

  it('a LOST attack (defender_win) never shows the hold toast even if the target tile happens to carry a stale contestedByMe from an unrelated hold — the hold branch only applies to an attacker_win outcome', async () => {
    h.tileCache.set('20:20', { contestedByMe: true });
    await h.net.applySiegeResult(siege('defender_win', ME, 'attack'));
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.siegeWinHold'), expect.anything());
    expect(h.showModal).toHaveBeenCalledTimes(1);
  });

  it('when someone else\'s march took our tile, we are the defender → "Territory lost"', async () => {
    await h.net.applySiegeResult(siege('attacker_win', OTHER, 'occupy'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
    expect(h.showModal).not.toHaveBeenCalled();
  });

  it('a repelled attack on our tile → "Defense held"', async () => {
    await h.net.applySiegeResult(siege('defender_win', OTHER, 'attack'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.defendHeld'), expect.anything());
  });
});

// SLG_DESIGN_LOG §53: field encounters (marchKind='move', ADR-051 §2.2, server/worldsvc/src/combatSiege/
// encounter.ts — our marching team bumps an enemy stationed team / another march / a garrison mid-transit)
// were §51's deliberately-left residual gap — with only 'attack'/'occupy' branches, a 'move' result always
// fell through to the defender/bystander wording even when we were the one who initiated it: a marcher who
// WON read "Territory lost", one who LOST read "Defense held" — backwards both ways, and no territory
// actually changes hands in a field encounter (that's occupy's job).
describe('WorldMapNet.applySiegeResult — field encounters (marchKind=move) get their own valence-correct toast', () => {
  let h: ReturnType<typeof buildHarness>;
  beforeEach(() => { h = buildHarness(); });

  it('winning a field encounter shows "skirmish won" — NOT "Territory lost", and no siege modal', async () => {
    await h.net.applySiegeResult(siege('attacker_win', ME, 'move'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.encounterWin'), expect.anything());
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
    expect(h.showModal).not.toHaveBeenCalled();
  });

  it('losing a field encounter shows "skirmish lost" — NOT "Defense held"', async () => {
    await h.net.applySiegeResult(siege('defender_win', ME, 'move'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.encounterLoss'), expect.anything());
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.defendHeld'), expect.anything());
  });

  it('someone else\'s field encounter (not ours) still classifies us as defender/bystander, unaffected', async () => {
    await h.net.applySiegeResult(siege('attacker_win', OTHER, 'move'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.encounterWin'), expect.anything());
  });

  it('a losing field encounter never opens the siege modal either (toast only, same as a win)', async () => {
    await h.net.applySiegeResult(siege('defender_win', ME, 'move'));
    expect(h.showModal).not.toHaveBeenCalled();
  });

  it('our OWN march with an unrecognized kind (e.g. sweep) is NOT treated as a field encounter — the branch keys on marchKind===\'move\' specifically, not just "any action we initiated that isn\'t attack/occupy"', async () => {
    await h.net.applySiegeResult(siege('attacker_win', ME, 'sweep'));
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.encounterWin'), expect.anything());
    expect(h.showToast).toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
  });
});
