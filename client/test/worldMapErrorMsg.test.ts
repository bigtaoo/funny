// Coverage for `client/src/scenes/worldmap/net/errors.ts` — the server-error → toast-copy
// mapping every `scenes/worldmap/net/*.ts` sibling routes its failures through.
//
// It was 0% until now, and the shape of the bug it exists to prevent is not "the wrong
// translation" but "no translation": an unmapped code falls through to `e.message`, which is
// the server's raw English ("Concurrent update, please retry"), rendered inside an otherwise
// localised toast. That fallback is deliberate — a code nobody anticipated should still say
// *something* — which is exactly why nothing about a missing entry is visibly broken in dev,
// where the tester reads English anyway. So the assertions below are mostly about which codes
// are claimed, not about the wording.
import { describe, it, expect, beforeEach } from 'vitest';
import { errorMsg } from '../src/scenes/worldmap/net/errors';
import { WorldApiError } from '../src/net/WorldApiClient';
import { setLocale, t } from '../src/i18n';

/** Every code the mapping claims. A code dropped from here without a matching src change is a
 *  silent regression to raw server English, so the list is spelled out rather than derived. */
const MAPPED: ReadonlyArray<[code: string, key: Parameters<typeof t>[0]]> = [
  ['WORLD_FULL', 'world.err.worldFull'],
  ['NO_TROOPS', 'world.err.noTroops'],
  ['TILE_OCCUPIED', 'world.err.occupied'],
  ['PROTECTED', 'world.err.protected'],
  ['ALLY_TILE', 'world.err.allyTile'],
  ['OUT_OF_RANGE', 'world.err.outOfRange'],
  ['NOT_OWNER', 'world.err.notOwner'],
  ['NOT_IMPLEMENTED', 'world.err.notImpl'],
  ['TROOP_CAP_REACHED', 'world.err.troopCap'],
  ['CARD_TROOP_CAP_EXCEEDED', 'world.err.cardTroopCap'],
  ['INSUFFICIENT_RESOURCES', 'world.err.noInk'],
  ['PATH_BLOCKED', 'world.err.pathBlocked'],
  ['TERRITORY_NOT_CONNECTED', 'world.err.notConnected'],
  ['TEAM_BUSY', 'world.team.busy'],
  ['TEAM_EXHAUSTED', 'world.err.teamExhausted'],
  ['SATCHEL_CAP_EXCEEDED', 'world.err.satchelCap'],
  ['REV_CONFLICT', 'world.err.revConflict'],
  ['ALREADY_ACTIVE', 'world.shopAlreadyActive'],
];

describe('worldmap errorMsg', () => {
  beforeEach(() => { setLocale('zh'); });

  it.each(MAPPED)('maps %s to its own copy', (code, key) => {
    // The raw message is deliberately distinctive: if the mapping ever fell through, the
    // assertion below would be comparing against it instead of the localised string.
    expect(errorMsg(new WorldApiError(code, 'raw server text'))).toBe(t(key));
  });

  it('gives every mapped code a distinct string', () => {
    // Two codes sharing one line means the player cannot tell two different failures apart —
    // and it is how a copy-paste in the map above would otherwise go unnoticed. TEAM_BUSY and
    // ALREADY_ACTIVE deliberately reuse copy from elsewhere in the app, but not from each other.
    const copies = MAPPED.map(([code]) => errorMsg(new WorldApiError(code, 'raw')));
    expect(new Set(copies).size).toBe(MAPPED.length);
  });

  // ADR-025: worldsvc answers TILE_OCCUPIED for two different situations — the tile itself is
  // taken, and a 3×3 capital footprint does not fit here. The generic copy is actively wrong for
  // the second (the player's own cache can go stale between the pre-check and this round trip, so
  // they see "occupied" pointing at a tile that looks free), which is why the mapping sniffs the
  // server's message text before consulting the table.
  describe('the 3×3 footprint case, which shares TILE_OCCUPIED', () => {
    it('reads the footprint copy when the server says 3×3', () => {
      const e = new WorldApiError('TILE_OCCUPIED', 'the 3x3 capital footprint does not fit');
      expect(errorMsg(e)).toBe(t('world.err.footprintBlocked'));
    });

    it('matches the × form too, not just the ASCII x', () => {
      // The regex is `/3.3/` — deliberately loose, because the server has spelled this both ways.
      const e = new WorldApiError('TILE_OCCUPIED', '3×3 footprint blocked');
      expect(errorMsg(e)).toBe(t('world.err.footprintBlocked'));
    });

    it('still reads the generic copy for a plain occupied tile', () => {
      expect(errorMsg(new WorldApiError('TILE_OCCUPIED', 'tile is occupied'))).toBe(t('world.err.occupied'));
    });

    it('only special-cases TILE_OCCUPIED, not every 3×3 message', () => {
      // A different code whose message happens to mention 3x3 must keep its own copy.
      expect(errorMsg(new WorldApiError('NO_TROOPS', 'need 3x3 troops'))).toBe(t('world.err.noTroops'));
    });
  });

  it('falls back to the server message for a code it has never heard of', () => {
    // Deliberate: an unmapped code still has to say something. The cost is that the string is
    // raw server English inside a localised toast — see the file header.
    expect(errorMsg(new WorldApiError('SOME_NEW_CODE', 'Concurrent update, please retry')))
      .toBe('Concurrent update, please retry');
  });

  it('stringifies anything that is not a WorldApiError', () => {
    // Network failures and thrown non-Errors both land here (`fetch` rejects with TypeError).
    expect(errorMsg(new TypeError('Failed to fetch'))).toBe('TypeError: Failed to fetch');
    expect(errorMsg('plain string')).toBe('plain string');
    expect(errorMsg(undefined)).toBe('undefined');
  });

  it('follows the active locale rather than baking Chinese in at import time', () => {
    // The map is rebuilt per call for exactly this reason — a module-level table would freeze
    // whatever locale happened to be current when the module first loaded.
    const zh = errorMsg(new WorldApiError('NO_TROOPS', 'raw'));
    setLocale('en');
    const en = errorMsg(new WorldApiError('NO_TROOPS', 'raw'));
    expect(en).not.toBe(zh);
    expect(en).toBe(t('world.err.noTroops'));
  });
});
