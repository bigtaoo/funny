// WorldMapNet's server-error → i18n copy mapping, extracted as form① (claudedocs/client-modules.md
// "单文件 500 行收敛") — pure function of the caught error, shared by every net/*.ts sibling.
import { t } from '../../../i18n';
import { WorldApiError } from '../../../net/WorldApiClient';

export function errorMsg(e: unknown): string {
  if (e instanceof WorldApiError) {
    // worldsvc reuses TILE_OCCUPIED for both "someone else already owns this exact tile" and "the 3×3
    // capital footprint doesn't fit/fully fit here" (ADR-025) — the generic "tile occupied" copy is
    // misleading for the latter (client cache can go stale between the pre-check and this round trip),
    // so match on the server's distinguishing message text before falling back to the generic mapping.
    if (e.code === 'TILE_OCCUPIED' && /3.3/.test(e.message)) return t('world.err.footprintBlocked');
    const map: Record<string, string> = {
      WORLD_FULL:    t('world.err.worldFull'),
      NO_TROOPS:     t('world.err.noTroops'),
      TILE_OCCUPIED: t('world.err.occupied'),
      PROTECTED:     t('world.err.protected'),
      ALLY_TILE:     t('world.err.allyTile'),
      OUT_OF_RANGE:  t('world.err.outOfRange'),
      NOT_OWNER:     t('world.err.notOwner'),
      NOT_IMPLEMENTED: t('world.err.notImpl'),
      TROOP_CAP_REACHED:      t('world.err.troopCap'),
      // Per-card cap (2026-08-19): distinct from TROOP_CAP_REACHED, which is the BASE pool's cap.
      CARD_TROOP_CAP_EXCEEDED: t('world.err.cardTroopCap'),
      INSUFFICIENT_RESOURCES: t('world.err.noInk'),
      PATH_BLOCKED:  t('world.err.pathBlocked'),
      TERRITORY_NOT_CONNECTED: t('world.err.notConnected'),
      TEAM_BUSY:     t('world.team.busy'),
      SATCHEL_CAP_EXCEEDED: t('world.err.satchelCap'),
      // Optimistic-lock miss on the player's world doc (2026-08-24). startMarch — which produced the great
      // majority of these — no longer writes to playerWorld on dispatch at all, so this should now be rare;
      // but the guarded resource spenders can still lose a race, and without an entry here the raw English
      // server string ("Concurrent update, please retry") leaked straight into a localised toast.
      REV_CONFLICT:  t('world.err.revConflict'),
      // battle_pass single-slot gate (2026-08-01 fix) — same copy as the pre-emptively greyed-out shop row.
      ALREADY_ACTIVE: t('world.shopAlreadyActive'),
    };
    return map[e.code] ?? e.message;
  }
  return String(e);
}
