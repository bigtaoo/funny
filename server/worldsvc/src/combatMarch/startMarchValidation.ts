// worldsvc march domain: startMarch's per-kind target validation (occupy/reinforce/attack/move/sweep).
// Split out of command.ts (2026-08-10, 独立函数模块 form — command.ts is dominated by one long method,
// startMarch; this self-contained validation switch only ever needed `core` (a plain WorldCore
// instance, not a protected mixin-base member — no structural-typing wall to work around, unlike
// pve.ts/liveops.ts's mixin-chain split) plus the handful of locals startMarch had already computed by
// this point, so it lifts out verbatim as a free function taking them as explicit parameters). No
// behavior change: returns the resolved `defenderId` (attack only) or throws the same SlgError as before.
import { proceduralTile, SlgError, OCCUPY_MIN_TROOPS, type MarchKind } from '@nw/shared';
import { WorldCore } from '../core';

/**
 * Validate the target tile at departure for `kind` (will be re-validated on arrival since state may
 * have changed) and resolve `defenderId` (attack: the attacked player's accountId, used to push an
 * immediate under_attack warning). Throws SlgError on any validation failure.
 */
export async function validateMarchTarget(
  core: WorldCore,
  worldId: string,
  accountId: string,
  kind: MarchKind,
  toX: number,
  toY: number,
  toTid: string,
  hasCardArmy: boolean,
  troops: number,
  stationMode: 'idle' | 'garrison' | undefined,
): Promise<string | undefined> {
  const { cols, now } = core.deps;
  const proc = proceduralTile(worldId, toX, toY);
  if (proc.type === 'obstacle') throw new SlgError('BAD_REQUEST', 'Cannot march into obstacle terrain');
  const toTile = await cols.tiles.findOne({ _id: toTid });
  let defenderId: string | undefined; // attack: the attacked player's accountId (under_attack warning is pushed immediately on departure)
  if (kind === 'occupy') {
    if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot directly occupy the world center');
    // Stronghold (G8 §3.1): guarded by an extremely powerful system NPC; cannot be directly occupied — must be captured via attack siege.
    if (proc.type === 'stronghold' && !toTile?.ownerId) {
      throw new SlgError('TILE_OCCUPIED', 'Strongholds cannot be directly occupied; use attack siege to capture');
    }
    // Crossings (bridge/plankway): NPC-garrisoned choke buildings; cannot be directly occupied — must be captured via attack siege.
    if ((proc.type === 'bridge' || proc.type === 'plankway') && !toTile?.ownerId) {
      throw new SlgError('TILE_OCCUPIED', 'Bridges/plankways cannot be directly occupied; use attack siege to capture');
    }
    if (toTile?.ownerId === accountId) throw new SlgError('TILE_OCCUPIED', 'This tile is already your territory (use reinforce)');
    if (toTile?.ownerId) {
      if (toTile.protectedUntil && toTile.protectedUntil > now()) {
        throw new SlgError('PROTECTED', 'Target tile is under protection');
      }
      throw new SlgError('TILE_OCCUPIED', 'This tile is already occupied (use attack siege to take it)');
    }
    // ADR-039 territory connectivity ("连地"): the target must border land already held by the player's sect.
    // occupy never targets a capital (bases are runtime-placed, not procedurally occupiable), so a single cell.
    if (!(await core.isConnectedToSectTerritory(worldId, accountId, [{ x: toX, y: toY }]))) {
      throw new SlgError('TERRITORY_NOT_CONNECTED', 'Target tile must be adjacent to your sect\'s territory');
    }
  } else if (kind === 'reinforce') {
    if (!toTile || toTile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Can only reinforce your own tile');
  } else if (kind === 'attack') {
    // Siege: target must be another player's territory/capital, or an ownerless stronghold (G8 PvE to defeat the system garrison). Use occupy/sweep for neutral ownerless tiles.
    if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'World center is contested by sects and cannot be sieged');
    if (!toTile?.ownerId) {
      // ADR-037 (§5.4): no owner but mid occupation-hold (an occupy march already won its PvE battle and is
      // waiting out the hold countdown) — this is a valid expulsion attack target; the pending occupier gets
      // the under_attack warning just like a real owner would.
      if (toTile?.contestedBy && (toTile.contestedUntil ?? 0) > now()) {
        defenderId = toTile.contestedBy;
      } else if (proc.type !== 'stronghold' && proc.type !== 'bridge' && proc.type !== 'plankway') {
        // No owner, not mid-hold: only strongholds and crossings (bridge/plankway) can be sieged (defeating the
        // system NPC garrison); all other ownerless tiles use occupy/sweep.
        throw new SlgError('TILE_NOT_OWNED', 'Siege target has no owner (use occupy/sweep)');
      }
      // Stronghold / crossing PvE: leave defenderId unset (NPC does not receive an under_attack warning).
    } else {
      if (toTile.ownerId === accountId) throw new SlgError('TILE_OCCUPIED', 'Cannot siege your own territory');
      // R-3 (§8.2 / §18.7): friendly-fire block — cannot siege own family / same sect / allied sect territory.
      if ((await core.friendlyAccountIds(worldId, accountId)).has(toTile.ownerId)) {
        throw new SlgError('ALLY_TILE', 'Cannot siege friendly territory (family / sect / alliance)');
      }
      if (toTile.protectedUntil && toTile.protectedUntil > now()) {
        throw new SlgError('PROTECTED', 'Target tile is under protection');
      }
      defenderId = toTile.ownerId;
    }
    // ADR-039 territory connectivity ("连地"): applies uniformly to regular territory, capitals, and
    // bridges/plankways — all siege targets funnel through this same branch. A capital's anchor is only
    // ever bordered by its own ring cells, so a capital target checks against its whole 3×3 footprint
    // (targetFootprintCells), not just the exact (toX,toY) cell.
    if (!(await core.isConnectedToSectTerritory(worldId, accountId, core.targetFootprintCells(toTile, toX, toY)))) {
      throw new SlgError('TERRITORY_NOT_CONNECTED', 'Target tile must be adjacent to your sect\'s territory');
    }
    // Card armies have no server-side minimum-troops gate (see hasCardArmy note in command.ts) — only the legacy flat-troop path checks this.
    if (!hasCardArmy && troops < OCCUPY_MIN_TROOPS) throw new SlgError('NO_TROOPS', `Siege requires at least ${OCCUPY_MIN_TROOPS} troops`);
  } else if (kind === 'move') {
    // Move (2026-07-23): reposition a team to a tile with NO combat — it walks over and STANDS there (stationed).
    // Legal targets depend on intent (驻守 rule, 2026-08-02, user decision): 停留 idle only ever parks on (a)
    // the player's OWN tile, or (b) an EMPTY neutral tile (no owner) — idle has no defensive claim, so any
    // foreign-owned land (ally or not) is off-limits. 驻扎 garrison additionally may target (c) a FRIENDLY
    // account's territory (family / sect / allied sect — the same friendlyAccountIds set the attack branch
    // above uses to block siege) since it actively helps defend that land, but — unlike idle — never a neutral
    // tile (there is nothing there to defend). Either way: not the world center, not a PvE-only choke
    // (stronghold/bridge/plankway — captured via attack, never merely stood on), and not a tile that already
    // holds a stationed team (anyone's) — one park per tile.
    if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot move onto the world center');
    const stationedHere = await cols.stationed.findOne({ _id: toTid });
    if (stationedHere) throw new SlgError('TILE_OCCUPIED', 'A team is already stationed on this tile');
    const isGarrison = stationMode === 'garrison';
    if (toTile?.ownerId) {
      if (toTile.ownerId !== accountId) {
        const isFriendly = isGarrison && (await core.friendlyAccountIds(worldId, accountId)).has(toTile.ownerId);
        if (!isFriendly) throw new SlgError('TILE_OCCUPIED', 'Cannot move onto another player\'s tile (use attack)');
      }
      // own tile, or a friendly (ally) tile under garrison intent → fine
    } else {
      if (isGarrison) throw new SlgError('TILE_OCCUPIED', 'Garrison requires own or allied territory');
      // Unowned target: only plain neutral/resource land may be stood on; PvE-garrisoned specials are attack-only.
      if (proc.type === 'stronghold' || proc.type === 'bridge' || proc.type === 'plankway') {
        throw new SlgError('TILE_OCCUPIED', 'This tile must be captured via attack, not moved onto');
      }
      if (toTile?.contestedBy && (toTile.contestedUntil ?? 0) > now()) {
        throw new SlgError('TILE_OCCUPIED', 'Tile is mid occupation-hold; cannot move onto it');
      }
    }
  } else {
    // sweep: clear NPC garrison from neutral / resource tiles (no occupation; loot is carried back on return).
    if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot sweep the world center');
    // Stronghold (G8): ultra-strong system garrison; cannot be swept for loot — must be captured via attack siege.
    if (proc.type === 'stronghold') throw new SlgError('TILE_OCCUPIED', 'Strongholds must be captured via attack siege; sweeping is not allowed');
    // Crossings (bridge/plankway): garrisoned choke buildings; cannot be swept — must be captured via attack siege.
    if (proc.type === 'bridge' || proc.type === 'plankway') throw new SlgError('TILE_OCCUPIED', 'Bridges/plankways must be captured via attack siege; sweeping is not allowed');
    if (toTile?.ownerId) throw new SlgError('TILE_OCCUPIED', 'Target is already occupied (use attack siege to take it)');
  }
  return defenderId;
}
