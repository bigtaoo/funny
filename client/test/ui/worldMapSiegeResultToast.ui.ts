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

  const ctx = {
    destroyed: false,
    marchTokenRuntimes: new Map(),
    marchAttackUntil: new Map(),
    view: { renderMap: vi.fn() },
    panels: { showModal, showToast },
    cb: { onReplaySiege, accountId: ME },
  } as unknown as WorldMapContext;

  const net = new WorldMapNet(ctx);
  // The three fire-and-forget refetches in applySiegeResult are pure side-effects; stub them out.
  vi.spyOn(net, 'loadMapViewport').mockResolvedValue(undefined);
  vi.spyOn(net, 'refreshMe').mockResolvedValue(undefined);
  vi.spyOn(net, 'refreshMarches').mockResolvedValue(undefined);
  return { ctx, net, showModal, showToast, onReplaySiege };
}

describe('WorldMapNet.applySiegeResult — role is server-authoritative (attackerId/marchKind), not client memory', () => {
  let h: ReturnType<typeof buildHarness>;
  beforeEach(() => { h = buildHarness(); });

  it('a won occupy (mine) shows "occupy secured" toast — NOT "Territory lost", and no siege modal', () => {
    h.net.applySiegeResult(siege('attacker_win', ME, 'occupy'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.occupyWin'), expect.anything());
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
    expect(h.showModal).not.toHaveBeenCalled();
  });

  it('a lost occupy (mine) shows "occupation failed" toast — NOT "Defense held"', () => {
    h.net.applySiegeResult(siege('defender_win', ME, 'occupy'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.occupyLoss'), expect.anything());
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.defendHeld'), expect.anything());
  });

  it('a repeat/late delivery of the same occupy result still classifies correctly — no client-side "consumed" state to go stale (this is what used to break: the scene rebuilding between dispatch and arrival, or a re-delivered push, wiped the old myOccupyTiles bookkeeping)', () => {
    h.net.applySiegeResult(siege('attacker_win', ME, 'occupy'));
    h.showToast.mockClear();
    h.net.applySiegeResult(siege('attacker_win', ME, 'occupy'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.occupyWin'), expect.anything());
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
  });

  it('a won attack (mine) still opens the siege modal with replay, not a toast', () => {
    h.net.applySiegeResult(siege('attacker_win', ME, 'attack'));
    expect(h.showModal).toHaveBeenCalledTimes(1);
    const lines = h.showModal.mock.calls[0][0] as string[];
    expect(lines[0]).toBe(t('world.siegeWin').replace('{loot}', ''));
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it('when someone else\'s march took our tile, we are the defender → "Territory lost"', () => {
    h.net.applySiegeResult(siege('attacker_win', OTHER, 'occupy'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
    expect(h.showModal).not.toHaveBeenCalled();
  });

  it('a repelled attack on our tile → "Defense held"', () => {
    h.net.applySiegeResult(siege('defender_win', OTHER, 'attack'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.defendHeld'), expect.anything());
  });
});
