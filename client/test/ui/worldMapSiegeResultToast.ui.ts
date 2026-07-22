// Coverage for applySiegeResult classification (2026-07-22 bug fix).
//
// The bug: occupying a neutral tile runs a PvE battle server-side (ADR-037) and pushes a SiegeResult with
// outcome 'attacker_win' back to the OCCUPIER. applySiegeResult decided "did I attack or did I defend?" purely
// via myAttackTiles.has(tile) — but occupy marches were never recorded there, so a player's own successful
// land-grab fell into the defender branch and showed "Territory lost" (world.defendLost). A failed occupy was
// equally wrong (showed "Defense held"). Fix: track occupy targets in myOccupyTiles and give them their own
// toast (world.occupyWin / world.occupyLoss), distinct from both the attack-siege modal and the defender toast.
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

function siege(outcome: string, tile = TILE): SiegeResult {
  // marchId '' skips the attack-animation block (marchTokenRuntimes lookup); irrelevant to classification.
  return { siegeId: 's1', tile, outcome, lootSummary: '', replayRef: '', marchId: '' };
}

function buildHarness() {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const onReplaySiege = vi.fn();

  const ctx = {
    destroyed: false,
    myAttackTiles: new Set<string>(),
    myOccupyTiles: new Set<string>(),
    marchTokenRuntimes: new Map(),
    marchAttackUntil: new Map(),
    view: { renderMap: vi.fn() },
    panels: { showModal, showToast },
    cb: { onReplaySiege },
  } as unknown as WorldMapContext;

  const net = new WorldMapNet(ctx);
  // The three fire-and-forget refetches in applySiegeResult are pure side-effects; stub them out.
  vi.spyOn(net, 'loadMapViewport').mockResolvedValue(undefined);
  vi.spyOn(net, 'refreshMe').mockResolvedValue(undefined);
  vi.spyOn(net, 'refreshMarches').mockResolvedValue(undefined);
  return { ctx, net, showModal, showToast, onReplaySiege };
}

describe('WorldMapNet.applySiegeResult — occupy is our own action, not a defensive loss', () => {
  let h: ReturnType<typeof buildHarness>;
  beforeEach(() => { h = buildHarness(); });

  it('a won occupy shows "occupy secured" toast — NOT "Territory lost", and no siege modal', () => {
    h.ctx.myOccupyTiles.add(TILE);
    h.net.applySiegeResult(siege('attacker_win'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.occupyWin'), expect.anything());
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
    expect(h.showModal).not.toHaveBeenCalled();
  });

  it('a lost occupy shows "occupation failed" toast — NOT "Defense held"', () => {
    h.ctx.myOccupyTiles.add(TILE);
    h.net.applySiegeResult(siege('defender_win'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.occupyLoss'), expect.anything());
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.defendHeld'), expect.anything());
  });

  it('the occupy tile is consumed on receipt — a stray repeat does not re-fire the occupy toast', () => {
    h.ctx.myOccupyTiles.add(TILE);
    h.net.applySiegeResult(siege('attacker_win'));
    expect(h.ctx.myOccupyTiles.has(TILE)).toBe(false);
    // A duplicate result for the same tile now classifies as a bystander/defender event, not our occupy.
    h.showToast.mockClear();
    h.net.applySiegeResult(siege('attacker_win'));
    expect(h.showToast).not.toHaveBeenCalledWith(t('world.occupyWin'), expect.anything());
  });
});

describe('WorldMapNet.applySiegeResult — attack + defender paths still behave (regression)', () => {
  let h: ReturnType<typeof buildHarness>;
  beforeEach(() => { h = buildHarness(); });

  it('a won attack still opens the siege modal with replay, not a toast', () => {
    h.ctx.myAttackTiles.add(TILE);
    h.net.applySiegeResult(siege('attacker_win'));
    expect(h.showModal).toHaveBeenCalledTimes(1);
    const lines = h.showModal.mock.calls[0][0] as string[];
    expect(lines[0]).toBe(t('world.siegeWin').replace('{loot}', ''));
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it('when a tile we neither attacked nor occupied is taken, we are the defender → "Territory lost"', () => {
    h.net.applySiegeResult(siege('attacker_win'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.defendLost'), expect.anything());
    expect(h.showModal).not.toHaveBeenCalled();
  });

  it('a repelled attack on our tile → "Defense held"', () => {
    h.net.applySiegeResult(siege('defender_win'));
    expect(h.showToast).toHaveBeenCalledWith(t('world.defendHeld'), expect.anything());
  });
});
