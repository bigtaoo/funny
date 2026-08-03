// Regression coverage for the 2026-08-01 "pay coins, instantly complete a return march" feature
// (SLG_DESIGN_LOG §46): the march list's kind==='return' rows get an instantReturnRect button
// instead of a recall button, with a coin cost computed from remaining travel time.
//
// Mirrors the minimal-harness pattern used by worldMapHeaderProduction.ui.ts (renderHud) — runs
// under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { MARCH_RETURN_SPEEDUP_SECS_PER_COIN } from '@nw/shared';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { MarchView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 600];
const TOP_INSET = 86;
const NOW = 1_000_000;

function buildHarness(marches: MarchView[]): { ctx: WorldMapContext; panels: WorldMapPanels } {
  const ctx = {
    w: W, h: H,
    topInset: TOP_INSET,
    backRect: { x: 0, y: 0, w: 160, h: TOP_INSET },
    hudLayer: new PIXI.Container(),
    headerHudLayer: new PIXI.Container(),
    worldChatLatest: null,
    worldChatUnread: 0,
    zoom: 1 as const,
    me: { joined: true, troops: 10, troopCap: 100, territoryCount: 1, resources: {}, yieldRate: {} },
    marches,
    marchesExpanded: true,
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[1]), Number(p[2])]; },
    cb: { accountId: 'me', getCoins: () => 0, worldId: 'w1' },
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  return { ctx, panels };
}

describe('WorldMapPanels march list — instant-return button (SLG_DESIGN_LOG §46)', () => {
  it('a kind:"attack" row gets a recallRect and no instantReturnRect', () => {
    const marches: MarchView[] = [
      { marchId: 'm1', kind: 'attack', fromTile: 'w1:5:5', toTile: 'w1:10:5', troops: 50, departAt: NOW, arriveAt: NOW + 60_000, status: 'marching', mine: true },
    ];
    const { ctx, panels } = buildHarness(marches);
    panels.renderHud();

    expect(ctx.marchRowRects).toHaveLength(1);
    expect(ctx.marchRowRects[0]!.recallRect).not.toBeNull();
    expect(ctx.marchRowRects[0]!.instantReturnRect).toBeNull();
  });

  it('a kind:"return" row gets an instantReturnRect and no recallRect', () => {
    const remainingSec = 300; // exactly divisible by MARCH_RETURN_SPEEDUP_SECS_PER_COIN, sanity-checked below
    expect(remainingSec % MARCH_RETURN_SPEEDUP_SECS_PER_COIN).toBe(0);
    const marches: MarchView[] = [
      { marchId: 'm2', kind: 'return', fromTile: 'w1:10:5', toTile: 'w1:5:5', troops: 30, departAt: NOW, arriveAt: NOW + remainingSec * 1000, status: 'marching', mine: true },
    ];
    const { ctx, panels } = buildHarness(marches);
    panels.renderHud();

    expect(ctx.marchRowRects).toHaveLength(1);
    const row = ctx.marchRowRects[0]!;
    expect(row.recallRect).toBeNull();
    expect(row.instantReturnRect).not.toBeNull();
  });

  it('multiple marches each get their own correctly-typed row (attack + return mixed)', () => {
    const marches: MarchView[] = [
      { marchId: 'm3', kind: 'occupy', fromTile: 'w1:5:5', toTile: 'w1:8:5', troops: 20, departAt: NOW, arriveAt: NOW + 30_000, status: 'marching', mine: true },
      { marchId: 'm4', kind: 'return', fromTile: 'w1:8:5', toTile: 'w1:5:5', troops: 20, departAt: NOW, arriveAt: NOW + 45_000, status: 'marching', mine: true },
    ];
    const { ctx, panels } = buildHarness(marches);
    panels.renderHud();

    expect(ctx.marchRowRects).toHaveLength(2);
    expect(ctx.marchRowRects[0]!.marchId).toBe('m3');
    expect(ctx.marchRowRects[0]!.recallRect).not.toBeNull();
    expect(ctx.marchRowRects[0]!.instantReturnRect).toBeNull();
    expect(ctx.marchRowRects[1]!.marchId).toBe('m4');
    expect(ctx.marchRowRects[1]!.recallRect).toBeNull();
    expect(ctx.marchRowRects[1]!.instantReturnRect).not.toBeNull();
  });
});

// Regression coverage (2026-08-03 fix): each march row's `worldId` used to be parsed from the wrong
// toTile segment (`m.toTile.split(':')[2]`, the tile's Y-coordinate, not the world id — `toTile` is
// `{worldId}:{x}:{y}` everywhere else in this codebase). That worldId feeds straight into
// WorldMapInput → WorldMapNet.doRecall/doInstantReturn → worldApi.recallMarch/instantReturnMarch's
// request body, which the server matches against `{_id, worldId, ownerId}` — a y-coordinate string
// essentially never matches the real worldId, so the lookup missed and every Recall/Instant-Return
// tap failed with MARCH_NOT_FOUND. Fixed by reading `ctx.cb.worldId` (the authoritative current world
// id already available in scope) instead of re-parsing it out of the destination tile.
describe('WorldMapPanels march list — row worldId (2026-08-03 fix)', () => {
  it('an attack-row worldId is the current world id, not the destination tile\'s y-coordinate', () => {
    // toTile's y-coordinate ('5') deliberately differs from the world id ('w1') so a regression to
    // the old parsing bug would be caught, not accidentally masked by a coincidental match.
    const marches: MarchView[] = [
      { marchId: 'm1', kind: 'attack', fromTile: 'w1:5:5', toTile: 'w1:10:5', troops: 50, departAt: NOW, arriveAt: NOW + 60_000, status: 'marching', mine: true },
    ];
    const { ctx, panels } = buildHarness(marches);
    panels.renderHud();

    expect(ctx.marchRowRects[0]!.worldId).toBe('w1');
    expect(ctx.marchRowRects[0]!.worldId).not.toBe('5'); // the old (buggy) toTile-segment-2 value
  });

  it('a return-row (instant-return) worldId is also the current world id, not the tile\'s y-coordinate', () => {
    const marches: MarchView[] = [
      { marchId: 'm2', kind: 'return', fromTile: 'w1:10:5', toTile: 'w1:5:5', troops: 30, departAt: NOW, arriveAt: NOW + 300_000, status: 'marching', mine: true },
    ];
    const { ctx, panels } = buildHarness(marches);
    panels.renderHud();

    expect(ctx.marchRowRects[0]!.worldId).toBe('w1');
    expect(ctx.marchRowRects[0]!.worldId).not.toBe('5');
  });
});
