// Regression coverage for two 2026-08-09 fixes in WorldMapInput.onTileClick, both against the same
// root cause: the server has always sent `resType`/kept a tile's real `type` regardless of ownership
// or contested state, but the CLIENT only consumed those correctly in the neutral-tile fallthrough
// branch (see worldMapOccupyConnectivity.ui.ts's existing "shows the tile's resource type" case).
//
// 1) resLevelLine (resource type + level info line) is now shown for MINE/ALLY/ENEMY tiles too, not
//    just neutral ones — the info was always there server-side (core/map.ts's tileDocView sends
//    `resType` unconditionally whenever present), the client's mine/ally/enemy branches simply never
//    read it.
// 2) A tile mid occupation-hold (ADR-037 §5.4, widened 2026-08-09 to cover EVERY capture — PvP
//    territory/crossing attacks, PvE stronghold/crossing captures) must show the "occupying, Xs
//    left"/expulsion-offer modal, not whatever type-specific branch it would otherwise match — a
//    contested STRONGHOLD still carries `type:'stronghold'` throughout its hold (writeContestedHold
//    keeps the tile's pre-capture look until settlement), so the `contestedUntil` check had to move
//    ahead of the `type==='stronghold'` branch in onTileClick, or a contested stronghold would wrongly
//    still offer "attack the NPC garrison" instead of the occupying/expulsion flow.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Minimal hand-rolled
// WorldMapContext, mirroring worldMapOccupyConnectivity.ui.ts's harness pattern.

import { describe, it, expect, vi } from 'vitest';
import { initI18n, t } from '../../src/i18n';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { WorldTileView, PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const WORLD_ID = 'world:1:0';
const ANCHOR = { x: 20, y: 20 }; // capital footprint = x19..21, y19..21
const TX = 40, TY = 40; // far from the base footprint — never accidentally matches the mine/isBase branch

type Btn = { label: string; action: () => void };

function makeMe(overrides: Partial<PlayerWorldView> = {}): PlayerWorldView {
  return {
    joined: true,
    mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`,
    troops: 2000,
    ...overrides,
  } as PlayerWorldView;
}

function buildHarness() {
  const showModal = vi.fn();
  const showToast = vi.fn();

  const ctx = {
    mapW: 500,
    mapH: 500,
    tileCache: new Map<string, WorldTileView>(),
    me: makeMe(),
    selectedTile: null,
    stationed: [],
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: () => {} },
    cb: { worldId: WORLD_ID },
    panels: { showModal, showToast, closeModal: vi.fn() },
    net: { showTeamPicker: vi.fn(async () => {}), doRecallStationed: vi.fn() },
  } as unknown as WorldMapContext;

  const input = new WorldMapInput(ctx);
  return { ctx, input, showModal, showToast };
}

describe('WorldMapInput resource-type info line (2026-08-09) — shown for owned tiles too, not just neutral', () => {
  it('mine: resType + level appears in the "mine" tile modal', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${TX}:${TY}`, { occupied: true, mine: true, resType: 'paper', level: 5 } as WorldTileView);
    h.input.onTileClick(TX, TY);
    const lines = h.showModal.mock.calls[0]![0] as string[];
    expect(lines).toContain(t('world.resLevel').replace('{res}', t('world.paper')).replace('{lv}', '5'));
  });

  it('ally: resType + level appears in the "ally" tile modal', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${TX}:${TY}`, { occupied: true, ally: true, resType: 'graphite', level: 2 } as WorldTileView);
    h.input.onTileClick(TX, TY);
    const lines = h.showModal.mock.calls[0]![0] as string[];
    expect(lines).toContain(t('world.resLevel').replace('{res}', t('world.graphite')).replace('{lv}', '2'));
  });

  it('enemy: resType + level appears in the "enemy" tile modal', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${TX}:${TY}`, { occupied: true, resType: 'ink', level: 7 } as WorldTileView);
    h.input.onTileClick(TX, TY);
    const lines = h.showModal.mock.calls[0]![0] as string[];
    expect(lines).toContain(t('world.resLevel').replace('{res}', t('world.ink')).replace('{lv}', '7'));
  });

  it('mine/ally/enemy with no resType at all: no resource line, no crash', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${TX}:${TY}`, { occupied: true, mine: true } as WorldTileView);
    h.input.onTileClick(TX, TY);
    const lines = h.showModal.mock.calls[0]![0] as string[];
    expect(lines.some((l) => l.includes('Lv'))).toBe(false);
  });
});

describe('WorldMapInput contested-hold priority (2026-08-09) — occupying/expulsion UI wins over a stronghold-shaped tile', () => {
  it('an UNCONTESTED stronghold still shows the "attack the NPC garrison" modal (baseline, unaffected)', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${TX}:${TY}`, { type: 'stronghold', level: 8 } as WorldTileView);
    h.input.onTileClick(TX, TY);
    const lines = h.showModal.mock.calls[0]![0] as string[];
    expect(lines[0]).toBe(t('world.stronghold'));
  });

  it('a stronghold mid MY OWN occupation hold shows the "occupying, Xs left" modal — NOT the stronghold-attack modal', () => {
    const h = buildHarness();
    const dueAt = Date.now() + 120_000;
    h.ctx.tileCache.set(`${TX}:${TY}`, { type: 'stronghold', level: 8, contestedUntil: dueAt, contestedByMe: true } as WorldTileView);
    h.input.onTileClick(TX, TY);
    const lines = h.showModal.mock.calls[0]![0] as string[];
    expect(lines[0]).not.toBe(t('world.stronghold'));
    // 'world.occupyingMine' = 'Your occupation holds ({sec}s until it lands)' — assert the static prefix
    // (before the {sec} substitution) rather than the exact second count, which can drift by an epsilon
    // between this test's `Date.now()` call and onTileClick's own.
    const prefix = t('world.occupyingMine').split('{sec}')[0]!;
    expect(lines[0]).toContain(prefix);
  });

  it('a stronghold mid SOMEONE ELSE\'s occupation hold offers the expelling attack, not the stronghold-attack modal', () => {
    const h = buildHarness();
    const dueAt = Date.now() + 60_000;
    h.ctx.tileCache.set(`${TX}:${TY}`, { type: 'stronghold', level: 8, contestedUntil: dueAt } as WorldTileView);
    h.input.onTileClick(TX, TY);
    const lines = h.showModal.mock.calls[0]![0] as string[];
    const buttons = h.showModal.mock.calls[0]![1] as Btn[];
    expect(lines[0]).not.toBe(t('world.stronghold'));
    expect(buttons.find((b) => b.label === t('world.actAttack'))).toBeTruthy();
    buttons.find((b) => b.label === t('world.actAttack'))!.action();
    expect(h.ctx.net.showTeamPicker).toHaveBeenCalledWith(TX, TY, 'attack');
  });
});
