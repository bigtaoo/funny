// Regression coverage for the 2026-07-21 scout ("侦察") removal: none of the four tile-menu
// variants that used to offer an actScout button (enemy tile, stronghold, contested-hold,
// neutral/garrison) should offer it anymore, and doScout must never be called.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Harness mirrors
// worldMapBaseClick.ui.ts's minimal hand-rolled WorldMapContext with panels/cb/net as spies.

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

function makeMe(overrides: Partial<PlayerWorldView> = {}): PlayerWorldView {
  return { joined: true, mainBaseTile: `${WORLD_ID}:20:20`, troops: 2000, ...overrides } as PlayerWorldView;
}

function buildHarness(opts: { me?: PlayerWorldView } = {}) {
  const showModal = vi.fn();
  const doScout = vi.fn();
  const ctx = {
    mapW: 500,
    mapH: 500,
    tileCache: new Map<string, WorldTileView>(),
    me: opts.me ?? makeMe(),
    selectedTile: null,
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: () => {} },
    cb: { worldId: WORLD_ID, onOpenCity: vi.fn(), onOpenDefense: vi.fn() },
    panels: { showModal, showToast: vi.fn(), closeModal: vi.fn(), showDeployDialog: vi.fn() },
    net: { doJoin: vi.fn(), doAbandon: vi.fn(), confirmWatchtower: vi.fn(), doScout, showTeamPicker: vi.fn() },
  } as unknown as WorldMapContext;
  const input = new WorldMapInput(ctx);
  return { ctx, input, showModal, doScout };
}

describe('WorldMapInput.onTileClick — scout entry point removed (2026-07-21)', () => {
  it('enemy tile menu: no scout button', () => {
    const { ctx, input, showModal, doScout } = buildHarness();
    ctx.tileCache.set('40:40', { occupied: true, ownerId: 'other' } as WorldTileView);
    input.onTileClick(40, 40);
    const buttons = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons.map((b) => b.label)).toEqual([t('world.actAttack'), '✕']);
    expect(doScout).not.toHaveBeenCalled();
  });

  it('stronghold menu: no scout button', () => {
    const { ctx, input, showModal, doScout } = buildHarness();
    ctx.tileCache.set('40:40', { type: 'stronghold' } as WorldTileView);
    input.onTileClick(40, 40);
    const buttons = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons.map((b) => b.label)).toEqual([t('world.actAttack'), '✕']);
    expect(doScout).not.toHaveBeenCalled();
  });

  it('contested-hold menu (someone else holding): no scout button', () => {
    const { ctx, input, showModal, doScout } = buildHarness();
    ctx.tileCache.set('40:40', { contestedUntil: Date.now() + 10_000, contestedByMe: false } as WorldTileView);
    input.onTileClick(40, 40);
    const buttons = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons.map((b) => b.label)).toEqual([t('world.actAttack'), '✕']);
    expect(doScout).not.toHaveBeenCalled();
  });

  it('neutral tile with garrison: no scout button', () => {
    const { ctx, input, showModal, doScout } = buildHarness();
    ctx.tileCache.set('40:40', { garrison: 50 } as WorldTileView);
    input.onTileClick(40, 40);
    const buttons = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons.map((b) => b.label)).toEqual([t('world.actOccupy'), t('world.actSweep'), '✕']);
    expect(doScout).not.toHaveBeenCalled();
  });

  it('empty neutral tile: no scout button', () => {
    const { ctx, input, showModal, doScout } = buildHarness();
    ctx.tileCache.set('40:40', {} as WorldTileView);
    input.onTileClick(40, 40);
    const buttons = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons.map((b) => b.label)).toEqual([t('world.actOccupy'), '✕']);
    expect(doScout).not.toHaveBeenCalled();
  });
});
