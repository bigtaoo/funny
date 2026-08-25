// worldsvc march domain: startMarch's per-kind target validation (occupy/reinforce/attack/move/sweep).
// Split out of command.ts (2026-08-10, 独立函数模块 form — command.ts is dominated by one long method,
// startMarch; this self-contained validation switch only ever needed `core` (a plain WorldCore
// instance, not a protected mixin-base member — no structural-typing wall to work around, unlike
// pve.ts/liveops.ts's mixin-chain split) plus the handful of locals startMarch had already computed by
// this point, so it lifts out verbatim as a free function taking them as explicit parameters). No
// behavior change: returns the resolved `defenderId` (attack only) or throws the same SlgError as before.
import { proceduralTile, isCityGroundTile, SlgError, OCCUPY_MIN_TROOPS, type MarchKind } from '@nw/shared';
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
    // City ground (ADR-074): a wild city's whole footprint is indivisible and can only be taken by siege.
    // Until ADR-074 `familyKeep` had NO branch in this switch at all — every cell of a city plot was an
    // ordinary occupy target (see SLG_CITY_SIEGE_DESIGN §1.3). `center` is handled by its own branch above.
    if (proc.type === 'familyKeep') throw new SlgError('TILE_OCCUPIED', 'Cities cannot be occupied; use attack siege to capture');
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
    //
    // NOTE the ordering: the wild-city branch below runs BEFORE any `center` check, because
    // `isCityGroundTile` covers `center` as well as `familyKeep` — the world center IS a city (the biggest
    // one). A pre-ADR-074 guard here read `if (proc.type === 'center') throw 'World center is contested by
    // sects and cannot be sieged'`, which was true when a city was a sprite; leaving it in front made the
    // world center — the one objective the whole shard fights over (§8.3: +5% siege value, -10% march time,
    // a server-wide announcement) — the single city P1 could not besiege at all, and turned
    // `settleCityDamage`'s world-channel announcement into dead code. Caught by the e2e case that captures
    // the world center; the other 21 cases all used graded cities and never noticed.
    //
    // Wild city (ADR-074 P1). Three gates, in this order:
    //   1. the besieger must be in a sect (decision 1) — checked FIRST so a sect-less player gets the
    //      actionable error rather than a connectivity one they cannot fix;
    //   2. the city must exist as an entity and not already belong to the besieger's own sect;
    //   3. it must not be inside its post-capture protection window.
    // ADR-039 connectivity is checked by the shared tail below, against the whole footprint.
    if (isCityGroundTile(proc.type)) {
      const sectId = await core.requireSect(worldId, accountId);
      const city = await core.cityAt(worldId, toX, toY);
      // No city document: a world opened before P1 and never reset. Refuse rather than let a march fly at
      // a target that cannot be settled (`applyCitySiege` would treat it as a miss on arrival anyway).
      if (!city) throw new SlgError('BAD_REQUEST', 'This city is not yet initialized in this world');
      if (city.ownerSectId === sectId) throw new SlgError('ALLY_TILE', 'Your sect already holds this city');
      if ((city.protectedUntil ?? 0) > now()) throw new SlgError('PROTECTED', 'This city is under post-capture protection');
      // A city's footprint is 3-9 cells wide, so connectivity must be tested against the whole plot, not
      // the single landed cell — `targetFootprintCells` only knows about a base's 3x3 ring, so the city
      // case supplies its own cells.
      const r = (city.footprint - 1) / 2;
      const cells: { x: number; y: number }[] = [];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) cells.push({ x: city.x + dx, y: city.y + dy });
      if (!(await core.isConnectedToSectTerritory(worldId, accountId, cells))) {
        throw new SlgError('TERRITORY_NOT_CONNECTED', "The city must border your sect's territory");
      }
      if (!hasCardArmy && troops < OCCUPY_MIN_TROOPS) throw new SlgError('NO_TROOPS', `Siege requires at least ${OCCUPY_MIN_TROOPS} troops`);
      return undefined; // no single defender account: a city is held by a sect (no under_attack warning)
    }
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
    // City ground (ADR-074): captured by siege, never merely stood on — same rule as the world center and
    // the PvE-only chokes (stronghold/bridge/plankway) checked further down this branch.
    if (proc.type === 'familyKeep') throw new SlgError('TILE_OCCUPIED', 'Cannot move onto a city; capture it by siege');
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
    // City ground (ADR-074): no farmable NPC garrison inside a city plot — the city's own garrison waves
    // only exist on the siege path, so sweeping it must not be a cheap loot route around them.
    if (proc.type === 'familyKeep') throw new SlgError('TILE_OCCUPIED', 'Cities must be captured via attack siege; sweeping is not allowed');
    // Stronghold (G8): ultra-strong system garrison; cannot be swept for loot — must be captured via attack siege.
    if (proc.type === 'stronghold') throw new SlgError('TILE_OCCUPIED', 'Strongholds must be captured via attack siege; sweeping is not allowed');
    // Crossings (bridge/plankway): garrisoned choke buildings; cannot be swept — must be captured via attack siege.
    if (proc.type === 'bridge' || proc.type === 'plankway') throw new SlgError('TILE_OCCUPIED', 'Bridges/plankways must be captured via attack siege; sweeping is not allowed');
    if (toTile?.ownerId) throw new SlgError('TILE_OCCUPIED', 'Target is already occupied (use attack siege to take it)');
  }
  return defenderId;
}
