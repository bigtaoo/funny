// Regression coverage for the ADR-074 city-click branch in WorldMapInput.onTileClick — P0's "a city is
// not ordinary land" guarantees plus P1's siege panel.
//
// A wild city's whole footprint is `familyKeep` city ground: indivisible, siege-only, gated on sect
// membership. Before ADR-074 there was NO `familyKeep` branch here at all — a city tile fell through to
// the neutral-tile fallthrough at the bottom of onTileClick and offered a plain 占领 / 移动到此 menu
// against the underlying resource tile's NPC garrison. That is exactly what the user reported on
// 2026-08-25: tapping inside a Lv.8 city's walls popped 「占领 / 墨水 · Lv.2 / 建议兵力 240」.
//
// P1 turns the info box into a real panel: durability (absolute, not just a bar — the curve is
// base-dominated, see SLG_CITY_SIEGE_DESIGN §6.5), owning sect, protection countdown, per-sect siege log,
// and a siege button offered only when every server-side precondition already holds.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Harness mirrors
// worldMapTileResourceInfo.ui.ts.

import { describe, it, expect, vi } from 'vitest';
import { initI18n, t } from '../../src/i18n';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { WorldTileView, PlayerWorldView, WorldCityNodeView } from '../../src/net/WorldApiClient';

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
const ANCHOR = { x: 20, y: 20 };
const TX = 40, TY = 40; // far from the capital footprint

type Btn = { label: string; action: () => void };

function buildHarness(opts: { sectId?: string } = {}) {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const showTeamPicker = vi.fn(async () => {});
  const showDeployDialog = vi.fn();
  const refreshCities = vi.fn(async () => {});

  const ctx = {
    mapW: 500,
    mapH: 500,
    tileCache: new Map<string, WorldTileView>(),
    cityNodes: null as WorldCityNodeView[] | null,
    me: {
      joined: true, mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`, troops: 2000,
      ...(opts.sectId ? { sectId: opts.sectId } : {}),
    } as PlayerWorldView,
    selectedTile: null,
    stationed: [],
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: () => {} },
    cb: { worldId: WORLD_ID },
    panels: { showModal, showToast, closeModal: vi.fn(), showDeployDialog },
    net: { showTeamPicker, doRecallStationed: vi.fn(), doInPlaceOccupy: vi.fn(), refreshCities },
  } as unknown as WorldMapContext;

  return { ctx, input: new WorldMapInput(ctx), showModal, showToast, showTeamPicker, showDeployDialog, refreshCities };
}

/** Put a city-ground tile at (TX,TY) — what the server sends for any cell of a city footprint. */
function setCityTile(ctx: WorldMapContext, level: number): void {
  ctx.tileCache.set(`${TX}:${TY}`, { x: TX, y: TY, type: 'familyKeep', level } as WorldTileView);
}

/** A served city node whose footprint covers (TX,TY). The anchor is deliberately OFF the clicked cell so
 *  the footprint lookup (`cityNodeCovering`) is exercised rather than an accidental exact-coordinate match. */
function cityNode(over: Partial<WorldCityNodeView> = {}): WorldCityNodeView {
  return {
    id: 'garrison-7', kind: 'garrison', x: TX - 2, y: TY + 1, level: 8, footprint: 7,
    durability: 33_200, durabilityMax: 33_200, regenPerHour: 16_000,
    ...over,
  } as WorldCityNodeView;
}

/** Read the modal from the LAST showModal call (the panel redraws once after refreshCities resolves). */
function lastModal(showModal: ReturnType<typeof vi.fn>): [string[], Btn[]] {
  const calls = showModal.mock.calls;
  return calls[calls.length - 1] as [string[], Btn[]];
}

describe('WorldMapInput.onTileClick — wild city ground (ADR-074 P0 guarantees)', () => {
  it('shows the city modal, not the neutral occupy menu', () => {
    const h = buildHarness();
    setCityTile(h.ctx, 8);
    h.input.onTileClick(TX, TY);

    const [lines] = lastModal(h.showModal);
    expect(lines[0]).toBe(t('world.city'));
    expect(lines).toContain(t('world.cityLevel').replace('{lv}', '8'));
    expect(lines).toContain(`(${TX}, ${TY})`);
  });

  it('never offers occupy / sweep / move for a city tile', () => {
    const h = buildHarness({ sectId: 'sect:a' });
    setCityTile(h.ctx, 5);
    h.ctx.cityNodes = [cityNode({ level: 5 })];
    h.input.onTileClick(TX, TY);

    const [, buttons] = lastModal(h.showModal);
    const labels = buttons.map((b) => b.label);
    expect(labels).not.toContain(t('world.actOccupy'));
    expect(labels).not.toContain(t('world.actSweep'));
    expect(labels).not.toContain(t('world.actMove'));
  });

  it('shows no 建议兵力 / resource line — a city plot has no farmable garrison or yield', () => {
    // The reported screenshot's giveaway was exactly these two lines: the city's cell was being described
    // as a level-2 ink tile with a 240-troop recommendation.
    const h = buildHarness();
    setCityTile(h.ctx, 8);
    h.input.onTileClick(TX, TY);
    const [lines] = lastModal(h.showModal);
    for (const line of lines) {
      expect(line).not.toContain(t('world.recommendTroops').replace('{n}', ''));
      expect(line).not.toBe(t('world.actOccupy'));
    }
  });

  it('still shows the world-center toast for center ground (unchanged neighbour branch)', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${TX}:${TY}`, { x: TX, y: TY, type: 'center', level: 10 } as WorldTileView);
    h.input.onTileClick(TX, TY);
    expect(h.showToast).toHaveBeenCalledWith(t('world.center'));
    expect(h.showModal).not.toHaveBeenCalled();
  });

  it('falls back to the info-only box when the server sent no city state at all', () => {
    // A world opened before ADR-074 P1 and never reset has city GROUND but no city document. Offering a
    // siege button there would produce a march the server rejects on departure.
    const h = buildHarness({ sectId: 'sect:a' });
    setCityTile(h.ctx, 8);
    h.ctx.cityNodes = [];
    h.input.onTileClick(TX, TY);
    const [lines, buttons] = lastModal(h.showModal);
    expect(lines).toContain(t('world.cityHint'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.label).toBe('✕');
  });
});

describe('WorldMapInput.onTileClick — wild city siege panel (ADR-074 P1)', () => {
  it('resolves the city by FOOTPRINT, not by exact anchor coordinates', () => {
    // (TX,TY) is two cells off the node's anchor, inside its 7x7 plot. Matching on anchor equality — which
    // is what the pre-ADR-074 generator did and what the P0 writeup calls out — would miss it entirely.
    const h = buildHarness({ sectId: 'sect:a' });
    setCityTile(h.ctx, 8);
    h.ctx.cityNodes = [cityNode({ durability: 12_000 })];
    h.input.onTileClick(TX, TY);
    const [lines] = lastModal(h.showModal);
    expect(lines.some((l) => l.includes('12000'))).toBe(true);
  });

  it('prefers the world center when two footprints overlap the clicked cell', () => {
    // Overlapping plots are real: a map-edge city has its anchor clamped back inside the map. The tie-break
    // must match the server's (`CITY_KIND_RANK`, shared) or the panel would describe a different city than
    // the one the march will actually hit.
    const h = buildHarness({ sectId: 'sect:a' });
    setCityTile(h.ctx, 10);
    h.ctx.cityNodes = [
      cityNode({ id: 'garrison-7', kind: 'garrison', level: 8, durability: 1111 }),
      cityNode({ id: 'worldCenter', kind: 'worldCenter', level: 10, footprint: 9, durability: 2222 }),
    ];
    h.input.onTileClick(TX, TY);
    const [lines] = lastModal(h.showModal);
    expect(lines.some((l) => l.includes('2222'))).toBe(true);
    expect(lines.some((l) => l.includes('1111'))).toBe(false);
  });

  it('shows durability as an ABSOLUTE pair plus the regen rate', () => {
    // Not a percentage: the curve is base-dominated (26,000 + 900/level), so a level-3 city and a level-10
    // capital are within ~22% of each other and a percentage-only readout reads as a bug (§6.5).
    const h = buildHarness({ sectId: 'sect:a' });
    setCityTile(h.ctx, 8);
    h.ctx.cityNodes = [cityNode({ durability: 20_000, durabilityMax: 33_200, regenPerHour: 16_000 })];
    h.input.onTileClick(TX, TY);
    const [lines] = lastModal(h.showModal);
    expect(lines).toContain(t('world.cityDurability').replace('{cur}', '20000').replace('{max}', '33200'));
    expect(lines).toContain(t('world.cityRegen').replace('{n}', '16000'));
  });

  it('offers the siege button to a sect member against an unclaimed city', () => {
    const h = buildHarness({ sectId: 'sect:a' });
    setCityTile(h.ctx, 8);
    h.ctx.cityNodes = [cityNode()];
    h.input.onTileClick(TX, TY);
    const [lines, buttons] = lastModal(h.showModal);
    expect(lines).toContain(t('world.cityUnclaimed'));
    const siege = buttons.find((b) => b.label === t('world.actSiegeCity'));
    expect(siege).toBeDefined();
    siege!.action();
    expect(h.showTeamPicker).toHaveBeenCalledWith(TX, TY, 'attack');
  });

  it('withholds the siege button from a player with no sect, and says why', () => {
    // ADR-074 decision 1: only sect members may besiege. Hidden rather than shown-disabled, matching the
    // occupy button's own convention (2026-08-02) — the panel never invites a rejected march.
    const h = buildHarness();
    setCityTile(h.ctx, 8);
    h.ctx.cityNodes = [cityNode()];
    h.input.onTileClick(TX, TY);
    const [lines, buttons] = lastModal(h.showModal);
    expect(lines).toContain(t('world.cityNeedSect'));
    expect(buttons.map((b) => b.label)).not.toContain(t('world.actSiegeCity'));
  });

  it('withholds the siege button while the city is under post-capture protection', () => {
    const h = buildHarness({ sectId: 'sect:a' });
    setCityTile(h.ctx, 8);
    h.ctx.cityNodes = [cityNode({ ownerSectId: 'sect:b', ownerSectName: 'Rivals', protectedUntil: Date.now() + 90 * 60 * 1000 })];
    h.input.onTileClick(TX, TY);
    const [lines, buttons] = lastModal(h.showModal);
    expect(lines.some((l) => l.startsWith(t('world.cityProtected').split('{d}')[0]!))).toBe(true);
    expect(buttons.map((b) => b.label)).not.toContain(t('world.actSiegeCity'));
  });

  it('withholds the siege button for a city our own sect already holds', () => {
    const h = buildHarness({ sectId: 'sect:a' });
    setCityTile(h.ctx, 8);
    h.ctx.cityNodes = [cityNode({ ownerSectId: 'sect:a', ownerSectName: 'Us' })];
    h.input.onTileClick(TX, TY);
    const [lines, buttons] = lastModal(h.showModal);
    expect(lines).toContain(t('world.cityOwnedByUs').replace('{sect}', 'Us'));
    expect(lines).toContain(t('world.cityOursHint'));
    expect(buttons.map((b) => b.label)).not.toContain(t('world.actSiegeCity'));
  });

  it('names the holding sect for a rival-held, unprotected city and still offers the siege', () => {
    const h = buildHarness({ sectId: 'sect:a' });
    setCityTile(h.ctx, 8);
    h.ctx.cityNodes = [cityNode({ ownerSectId: 'sect:b', ownerSectName: 'Rivals' })];
    h.input.onTileClick(TX, TY);
    const [lines, buttons] = lastModal(h.showModal);
    expect(lines).toContain(t('world.cityOwnedBy').replace('{sect}', 'Rivals'));
    expect(buttons.map((b) => b.label)).toContain(t('world.actSiegeCity'));
  });

  it('lists this round\'s top contributing sects, marking our own', () => {
    // Ownership goes to the LAST hit, not the biggest contributor (ADR-074 decision 2) — this list exists
    // so a sect can see whether it is actually the one doing the work.
    const h = buildHarness({ sectId: 'sect:a' });
    setCityTile(h.ctx, 8);
    h.ctx.cityNodes = [cityNode({ durability: 5_000, siegeLog: { 'sect:a': 4_200, 'sect:b': 9_100 } })];
    h.input.onTileClick(TX, TY);
    const [lines] = lastModal(h.showModal);
    expect(lines).toContain(t('world.citySiegeLog').replace('{sect}', 'sect:b').replace('{n}', '9100'));
    expect(lines).toContain(t('world.citySiegeLog').replace('{sect}', t('world.citySiegeLogUs')).replace('{n}', '4200'));
  });

  it('refreshes the city state once when the panel opens, and only once', () => {
    // The entry-payload snapshot goes stale within minutes (durability regenerates; rivals are hitting the
    // same walls). The redraw must not loop.
    const h = buildHarness({ sectId: 'sect:a' });
    setCityTile(h.ctx, 8);
    h.ctx.cityNodes = [cityNode()];
    h.input.onTileClick(TX, TY);
    expect(h.refreshCities).toHaveBeenCalledTimes(1);
  });
});
