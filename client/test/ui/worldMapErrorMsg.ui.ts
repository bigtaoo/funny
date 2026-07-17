// Regression coverage for WorldMapNet.errorMsg's SLG error-code → localized message mapping
// (ADR-039, SLG_DESIGN §4.1): the new TERRITORY_NOT_CONNECTED code (occupy/attack march rejected
// because the target doesn't border the player's sect territory) must map to a real i18n string,
// not fall through to the server's raw English message, and must not collide with the special-cased
// TILE_OCCUPIED + /3.3/ "footprint blocked" branch that precedes the generic map.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles); errorMsg is pure (no PIXI,
// no network), so this is a plain unit test dressed as a `.ui.ts` file to sit alongside the rest of
// the WorldMap client suite (mirrors worldMapBaseClick.ui.ts's harness pattern).

import { describe, it, expect } from 'vitest';
import { initI18n, t } from '../../src/i18n';
import { WorldMapNet } from '../../src/scenes/worldmap/WorldMapNet';
import { WorldApiError } from '../../src/net/WorldApiClient';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// errorMsg is pure and touches no ctx fields, so an empty stub is enough to construct WorldMapNet.
const net = new WorldMapNet({} as WorldMapContext);

describe('WorldMapNet.errorMsg — SLG error-code mapping', () => {
  it('TERRITORY_NOT_CONNECTED (ADR-039) maps to its own localized message', () => {
    expect(net.errorMsg(new WorldApiError('TERRITORY_NOT_CONNECTED', 'Target tile must be adjacent to your sect\'s territory')))
      .toBe(t('world.err.notConnected'));
  });

  it('does not collide with the TILE_OCCUPIED + /3.3/ footprint-blocked special case', () => {
    // Same underlying "can't place/act here" family, but a distinct code and message shape —
    // must not accidentally match the footprint-blocked regex or vice versa.
    expect(net.errorMsg(new WorldApiError('TILE_OCCUPIED', 'needs a clear 3×3 area')))
      .toBe(t('world.err.footprintBlocked'));
    expect(net.errorMsg(new WorldApiError('TERRITORY_NOT_CONNECTED', 'not adjacent to sect territory')))
      .not.toBe(t('world.err.footprintBlocked'));
  });

  it('other known codes still map correctly (regression: adding TERRITORY_NOT_CONNECTED did not break the map)', () => {
    expect(net.errorMsg(new WorldApiError('ALLY_TILE', 'x'))).toBe(t('world.err.allyTile'));
    expect(net.errorMsg(new WorldApiError('PATH_BLOCKED', 'x'))).toBe(t('world.err.pathBlocked'));
    expect(net.errorMsg(new WorldApiError('TILE_OCCUPIED', 'x'))).toBe(t('world.err.occupied'));
  });

  it('SATCHEL_CAP_EXCEEDED maps to a localized message, not the raw satchel-cap English text (2026-07-17)', () => {
    // A team carrying more troops than the no-satchel carry cap (SATCHEL_CARRY_BASE=2000) is rejected
    // server-side; before the map entry existed this fell through to the raw "Team carries N troops,
    // exceeds satchel cap of M" English string. It must now render the actionable localized copy.
    const mapped = net.errorMsg(new WorldApiError('SATCHEL_CAP_EXCEEDED', 'Team carries 2160 troops, exceeds satchel cap of 2000'));
    expect(mapped).toBe(t('world.err.satchelCap'));
    expect(mapped).not.toContain('satchel cap of');
  });

  it('unmapped code falls back to the raw server message', () => {
    expect(net.errorMsg(new WorldApiError('SOME_UNMAPPED_CODE', 'raw server text')))
      .toBe('raw server text');
  });

  it('non-WorldApiError falls back to String(e)', () => {
    expect(net.errorMsg(new Error('plain error'))).toBe(String(new Error('plain error')));
  });
});
