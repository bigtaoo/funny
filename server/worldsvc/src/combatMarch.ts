// worldsvc combat domain: marches (S8-2) — start / recall / list + arrival processing & dispatch.
// Peeled out of CombatService (2026-07-03). Depends on WorldCore for shared state, vision, push/schedule
// infra and nations (applyNationChange); attack/sweep arrivals are dispatched to SiegeService. No behavior change.
import {
  proceduralTile,
  tileId,
  marchId,
  playerWorldId,
  marchDurationFromPath,
  marchStepArriveAt,
  marchMoraleFromPath,
  OCCUPY_MIN_TROOPS,
  MARCH_MIN_TROOPS,
  isInVision,
  marchInterpPos,
  satchelCarryCapFor,
  SlgError,
  MARCH_RETURN_SPEEDUP_SECS_PER_COIN,
  type MarchKind,
} from '@nw/shared';
import type { MarchDoc, ArmyEntry, StationedDoc, PlayerWorldDoc } from './db';
import { WorldCore, MARCHABLE_KINDS } from './core';
import type { MarchView, StationedView, PlayerWorldView } from './worldTypes';
import { refundTroops, computeMarchPath, parkMarchInPlace, startReturnMarch } from './combatShared';
import { legBox, sourcesBoundingBox } from './core/helpers';
import type { SiegeService } from './combatSiege';
import { resolveLeaderUnitType } from './leaderUnit';

export class MarchService {
  constructor(
    private readonly core: WorldCore,
    private readonly siege: SiegeService,
  ) {}

  // ── S8-2: march / recall / arrival processing ──────────────────────────

  /**
   * Start a march (occupy / reinforce; attack/sweep = siege S8-3). Troops are **immediately deducted from the pool** on departure (in-transit);
   * on arrival they are applied according to kind (occupy writes TileDoc / reinforce adds garrison); on failure or recall, troops are refunded to the pool.
   * Validation (at departure): joined + valid kind + from/to in bounds + from is own tile + enough troops +
   *   occupy: target is an empty tile (not center / unoccupied) and troops ≥ OCCUPY_MIN_TROOPS / reinforce: target is own tile.
   */
  async startMarch(
    worldId: string,
    accountId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    kind: MarchKind,
    troops: number,
    teamId?: string,
    stationMode?: 'idle' | 'garrison',
  ): Promise<MarchView> {
    const { cols, now } = this.core.deps;
    if (!MARCHABLE_KINDS.has(kind)) {
      throw new SlgError('NOT_IMPLEMENTED', `March kind ${kind} is not implemented (siege S8-3)`);
    }
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    if (!this.core.inBounds(fromX, fromY) || !this.core.inBounds(toX, toY)) {
      throw new SlgError('OUT_OF_RANGE', 'Coordinates out of bounds');
    }
    // Siege with a team (G3-2c; occupy also since 2026-07-15 SLG_DESIGN §4.2): draw the army from the saved
    // attack formation template; committed troops = sum of troops assigned to each unit. The team can be edited
    // after departure without affecting the in-transit march (the army snapshot is persisted with MarchDoc).
    // Neither attack nor occupy, or no team → use flat troops (synthesized generic units at combat time).
    let army: ArmyEntry[] | undefined;
    // March-token art (2026-07-26): resolved once at dispatch from the deployed team's leader card, frozen onto
    // the march (see MarchDoc.leaderUnitType) so it renders identically for the owner and for enemies viewing it
    // in vision (who cannot otherwise read the owner's cardInv). See leaderUnit.ts::resolveLeaderUnitType.
    let leaderUnitType: string | undefined;
    // ADR-051 (P3c): re-dispatch of an *idle* (停留) field team — commanded again straight from where it stands
    // (move/occupy), without recalling home first. Set inside the team block below; drives the origin override,
    // the from-tile ownership skip, the pool-deduction skip, and the atomic StationedDoc claim before insert.
    let idleRedispatch = false;
    // 'move' (2026-07-23) is always team-based — "选中的部队" is a team, and a moved team parks on the tile as a
    // whole (unlike reinforce's faceless garrison), so there is no flat-pool move path.
    if (kind === 'move' && !teamId) throw new SlgError('BAD_REQUEST', 'Move requires a team');
    if ((kind === 'attack' || kind === 'occupy' || kind === 'move') && teamId) {
      const team = (pw.teams ?? []).find((t) => t.id === teamId);
      if (!team || team.army.length === 0) throw new SlgError('BAD_REQUEST', 'Team does not exist or is empty');
      // Idle-team gate (2026-07-15): a team already committed to an active (non-recalled) march must not accept
      // a new order — same "out" predicate as the defender-skip check in combatSiege/arrival.ts (ADR-026 §2).
      // Marches are deleted from the collection once processed (combatMarch.ts claim-and-delete), so "marching"
      // covers transit; a won occupy/siege then hands the team off to an OccupationDoc for the hold countdown
      // (combatSiege/occupation.ts). Since 2026-07-23 a settled team can also STAY stationed on a tile (a
      // StationedDoc) — check all three so the team stays "out" end-to-end until the player recalls it.
      const [busyMarch, busyHold, busyStationed] = await Promise.all([
        cols.marches.findOne({ worldId, ownerId: accountId, teamId, status: { $ne: 'recalled' } }),
        cols.occupations.findOne({ worldId, ownerId: accountId, teamId }),
        cols.stationed.findOne({ worldId, ownerId: accountId, teamId }),
      ]);
      // ADR-051 (P3c): a 停留 idle field team is NOT busy — it can be re-commanded in place (move/occupy) straight
      // from where it stands (§4.3). A 驻扎 garrison stays locked (must recall first), as do marching/holding teams.
      idleRedispatch = !!busyStationed && busyStationed.mode !== 'garrison' && (kind === 'occupy' || kind === 'move');
      if (busyMarch || busyHold || (busyStationed && !idleRedispatch)) {
        throw new SlgError('TEAM_BUSY', 'Team is already marching, occupying, or stationed; recall it first');
      }
      if (idleRedispatch) {
        // Depart from where the team STANDS (ignore any client-supplied origin — an idle field team is not at the
        // base) and carry its STATIONED snapshot forward: army + troops reflect field-encounter losses (P2b/P3b),
        // not the roster template. Mirrors recallStationed, which likewise forwards claimed.army/claimed.troops.
        // Troops already left the pool at the original dispatch and satchel was validated then (can only shrink),
        // so no pool deduction and no satchel re-check below.
        fromX = busyStationed!.x;
        fromY = busyStationed!.y;
        army = busyStationed!.army;
        troops = busyStationed!.troops;
        leaderUnitType = busyStationed!.leaderUnitType;
      } else {
        army = team.army;
        troops = team.army.reduce((s, e) => s + Math.max(1, Math.floor(e.initialHp ?? 0)), 0);
        const attackerSave = await this.core.meta.getSaveFields(accountId, ['cardInv', 'equipmentInv']).catch(() => null);
        leaderUnitType = resolveLeaderUnitType(team, attackerSave?.cardInv ?? {}, attackerSave?.equipmentInv ?? {});
        // D-CITY-9: satchel gates how many troops a SINGLE team may carry per march/siege — independent of the
        // total troopCap pool (troopCapFor/drillYard). Card-army teams carry real strength in cardState.currentTroops
        // (the flat `troops` above degenerates to card count for them, per the CC-3 note below), so sum that instead.
        const teamHasCardArmy = team.army.some((e) => !!e.cardInstanceId);
        const carried = teamHasCardArmy
          ? team.army.reduce((s, e) => s + (e.cardInstanceId ? (pw.cardState?.[e.cardInstanceId]?.currentTroops ?? 0) : 0), 0)
          : troops;
        const satchelCap = satchelCarryCapFor(pw.buildings);
        if (carried > satchelCap) {
          throw new SlgError('SATCHEL_CAP_EXCEEDED', `Team carries ${carried} troops, exceeds satchel cap of ${satchelCap}`);
        }
      }
    }
    // CC-3 card-based team (cardInstanceId entries): committed strength lives entirely in cardState.currentTroops
    // (§6.1/§9 of CHARACTER_CARDS_DESIGN — a ledger fully independent of playerWorld.troops), so `troops` above
    // is not a meaningful pool quantity for this march (it degenerates to "card count" since ArmyEntry carries no
    // initialHp for card entries). §7.2 of that doc explicitly allows a 0-troop card to deploy (it just dies on
    // contact) — there is no server-side minimum-troops gate for card armies, only the legacy flat-troop path below.
    const hasCardArmy = !!army?.some((e) => !!e.cardInstanceId);
    if (!hasCardArmy) {
      if (!Number.isFinite(troops) || troops < MARCH_MIN_TROOPS) {
        throw new SlgError('NO_TROOPS', 'Invalid march troop count');
      }
      troops = Math.floor(troops);
      if (kind === 'occupy' && troops < OCCUPY_MIN_TROOPS) {
        throw new SlgError('NO_TROOPS', `Occupation requires at least ${OCCUPY_MIN_TROOPS} troops`);
      }
    } else {
      troops = Math.floor(Math.max(0, troops));
    }

    const fromTid = tileId(worldId, fromX, fromY);
    const fromTile = await cols.tiles.findOne({ _id: fromTid });
    // ADR-051 (P3c): an idle re-dispatch departs from the team's stationed cell, which is often neutral (unowned)
    // land — skip the own-territory requirement for it. The cell is legal by construction (the team stands there),
    // and fromX/fromY were overridden above to the StationedDoc's coordinates, so `fromTid` is that exact cell.
    if (!idleRedispatch && (!fromTile || fromTile.ownerId !== accountId)) {
      throw new SlgError('TILE_NOT_OWNED', 'Can only march from your own tile');
    }

    // Validate the target tile at departure (will be re-validated on arrival since state may have changed).
    const toTid = tileId(worldId, toX, toY);
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
      if (!(await this.core.isConnectedToSectTerritory(worldId, accountId, [{ x: toX, y: toY }]))) {
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
        if ((await this.core.friendlyAccountIds(worldId, accountId)).has(toTile.ownerId)) {
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
      if (!(await this.core.isConnectedToSectTerritory(worldId, accountId, this.core.targetFootprintCells(toTile, toX, toY)))) {
        throw new SlgError('TERRITORY_NOT_CONNECTED', 'Target tile must be adjacent to your sect\'s territory');
      }
      // Card armies have no server-side minimum-troops gate (see hasCardArmy note above) — only the legacy flat-troop path checks this.
      if (!hasCardArmy && troops < OCCUPY_MIN_TROOPS) throw new SlgError('NO_TROOPS', `Siege requires at least ${OCCUPY_MIN_TROOPS} troops`);
    } else if (kind === 'move') {
      // Move (2026-07-23): reposition a team to a tile with NO combat — it walks over and STANDS there (stationed).
      // Two legal targets (user decision): (a) the player's OWN tile (territory/base), or (b) an EMPTY neutral tile
      // (no owner, not mid-hold, not a PvE-only choke — center/stronghold/bridge/plankway are captured via attack,
      // never merely stood on). A tile that already holds a stationed team (anyone's) is rejected: one park per tile.
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot move onto the world center');
      const stationedHere = await cols.stationed.findOne({ _id: toTid });
      if (stationedHere) throw new SlgError('TILE_OCCUPIED', 'A team is already stationed on this tile');
      if (toTile?.ownerId) {
        if (toTile.ownerId !== accountId) throw new SlgError('TILE_OCCUPIED', 'Cannot move onto another player\'s tile (use attack)');
        // own tile → fine
      } else {
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

    const t = now();
    const resources = this.core.settle(pw, t);
    // ADR-051 (P3c): a re-dispatched idle team's troops already left the pool at its original dispatch (they are
    // "out in the field"), so there is no pool balance to check or deduct — same exemption as a card army.
    if (!hasCardArmy && !idleRedispatch && pw.troops < troops) throw new SlgError('NO_TROOPS', 'Insufficient troops');

    const path = await computeMarchPath(this.core, worldId, fromX, fromY, toX, toY, accountId);
    const departAt = t;
    const arriveAt = departAt + marchDurationFromPath(path) * 1000;
    // Morale (行军疲劳 — see SLG_DESIGN.md §4.4; distinct from the card "士气加成" bonus): 1 point lost per tile moved, computed once from the full path since marches don't tick
    // live in transit (single scheduled arrival event). Scales combat power on arrival — see moraleCombatMultiplier.
    const morale = marchMoraleFromPath(path);
    const mid = marchId(worldId, accountId, departAt, ++this.core.marchSeq);
    // ADR-051 (P1): persist the full A* path + stepping cursor so the march can advance tile-by-tile for
    // real-time encounter checks (P2). stepIndex 0 = at fromTile (path[0]); nextStepAt = when it reaches path[1].
    // A same-tile path (length 1, e.g. reinforce on self) has no next step → nextStepAt = arriveAt so it still
    // settles. These fields are additive in P1 (the scheduler still drives arrival off arriveAt); the step scan
    // is wired in P2.
    const nextStepAt = path.length > 1 ? marchStepArriveAt(departAt, 1) : arriveAt;
    const doc: MarchDoc = {
      _id: mid,
      worldId,
      ownerId: accountId,
      fromTile: fromTid,
      toTile: toTid,
      kind,
      troops,
      morale,
      ...(army && army.length > 0 ? { army } : {}),
      // ADR-026: record the deployed team slot so it is skipped as a defender while out (meaningful for team-based
      // attacks, occupy marches (2026-07-15), and move orders (2026-07-23) — a moved team stays out until recalled).
      ...((kind === 'attack' || kind === 'occupy' || kind === 'move') && teamId ? { teamId } : {}),
      ...(leaderUnitType ? { leaderUnitType } : {}),
      // ADR-051 (P3a): a 'move' dispatched with garrison intent parks as a garrison on arrival (applyMove reads
      // this). Default (absent / 'idle') keeps the pre-split 停留 idle behavior.
      ...(kind === 'move' && stationMode === 'garrison' ? { stationMode: 'garrison' as const } : {}),
      departAt,
      arriveAt,
      path,
      stepIndex: 0,
      nextStepAt,
      status: 'marching',
      ...legBox(fromX, fromY, toX, toY),
      rev: 0,
    };
    // ADR-051 (P3c): for an idle re-dispatch, atomically claim (remove) the StationedDoc *before* inserting the new
    // march. This frees the field cell and doubles as the team lock: two racing re-dispatches of the same team both
    // pass the findOne gate above, but only one findOneAndDelete wins — the loser gets TEAM_BUSY. The parked team's
    // occupancy entry is dropped too (idle teams register no cover, so there is nothing to remove from that index).
    // Ordering: the path was already computed (read-only) above, so nothing between here and the insert can throw
    // and orphan the team. A same-tile occupy (to === from) is an in-place occupation (§4.3): the length-1 path
    // settles instantly and flows through the normal applyOccupy pipeline.
    if (idleRedispatch) {
      const claim = await cols.stationed.findOneAndDelete({ worldId, ownerId: accountId, teamId });
      if (!claim) throw new SlgError('TEAM_BUSY', 'Team is no longer stationed (already re-commanded); recall it first');
      await this.core.clearOccupancy(worldId, claim.tile, claim.tile);
    }
    // The partial-unique index on {worldId,ownerId,teamId} (db.ts) is the atomic backstop for the idle-team
    // gate above: two concurrent dispatches of the same team both clear the findOne pre-check, but only one insert
    // wins — the loser hits E11000 and is reported as TEAM_BUSY. Non-team (flat-pool) marches carry no teamId and
    // are unaffected. No pool troops were deducted yet, so a rejected insert leaves player state untouched.
    try {
      await cols.marches.insertOne(doc);
    } catch (e) {
      if (teamId && (e as { code?: number }).code === 11000) {
        throw new SlgError('TEAM_BUSY', 'Team is already marching, occupying, or stationed; recall it first');
      }
      throw e;
    }
    // Deduct troops on departure (in-transit; not in the pool) — skipped for card armies, whose strength
    // already lives in cardState.currentTroops and never touches playerWorld.troops (see hasCardArmy above).
    // The `pw.troops < troops` check above is only a fast-fail on a possibly-stale read; the real guard is
    // this atomic `troops: {$gte: troops}` filter — without it, two concurrent dispatches can both pass the
    // early check and both $inc, driving troops negative (over-deploying more troops than the account has).
    if (hasCardArmy || idleRedispatch) {
      await cols.playerWorld.updateOne({ _id: pw._id }, { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } });
    } else {
      const deducted = await cols.playerWorld.updateOne(
        { _id: pw._id, troops: { $gte: troops } },
        { $set: { resources, lastTickAt: t }, $inc: { troops: -troops, rev: 1 } },
      );
      if (deducted.matchedCount === 0) {
        // Lost the race the fast-fail check above couldn't catch: roll back the march just inserted so the
        // account isn't left with a phantom in-flight march that drained no pool troops.
        await cols.marches.deleteOne({ _id: mid });
        throw new SlgError('NO_TROOPS', 'Insufficient troops');
      }
    }
    const view = this.core.marchView(doc);
    void this.core.pushMarch(accountId, view);
    // G5-2 reverse vision push: push this march to observers whose vision covers its path (enemy march entering your vision triggers a push, V4).
    // Reuse the already-computed path; one reverse query (not per tick). The defender (attack) already receives under_attack separately, so exclude them from observers.
    const observers = await this.core.visionObservers(worldId, path, new Set([accountId, ...(defenderId ? [defenderId] : [])]));
    for (const acct of observers) void this.core.pushMarch(acct, view);
    // Siege: push an under_attack warning to the defender immediately on departure (§5 / §14.5).
    if (kind === 'attack' && defenderId) {
      const did = defenderId;
      void (this.core.meta.available
        ? this.core.meta.getProfile(accountId).catch(() => null)
        : Promise.resolve(null)
      ).then((p) => this.core.gateway.push(did, {
        kind: 'under_attack',
        tile: toTid,
        attackerName: p?.displayName ?? '',
        attackerPublicId: p?.publicId ?? '',
        arriveAt,
        troopsHint: troops,
      }));
    }
    return view;
  }

  /**
   * Recall a march: flip an in-transit outbound march into a return leg (troops travel back to the origin tile and are refunded to the troop pool).
   * Return travel time = time already elapsed (min(elapsed, total)). Troops are refunded on the return arrival. Already arrived / already recalled → MARCH_NOT_FOUND.
   */
  async recallMarch(worldId: string, accountId: string, mid: string): Promise<MarchView> {
    const { cols, now } = this.core.deps;
    const m = await cols.marches.findOne({ _id: mid, worldId, ownerId: accountId });
    if (!m || m.status !== 'marching' || m.kind === 'return') {
      throw new SlgError('MARCH_NOT_FOUND', 'March not found or cannot be recalled');
    }
    const t = now();
    const total = m.arriveAt - m.departAt;
    const traveled = Math.max(0, Math.min(t - m.departAt, total));
    const backArrive = t + traveled;
    // Atomic claim (prevents race with arrival processing): only an outbound march still in 'marching' state is flipped to a return leg.
    // ADR-051 (P1): drop the stepping cursor ($unset path/stepIndex/nextStepAt) — the return leg reverts to the
    // legacy single-arrival model (arriveAt-driven; it does not step tile-by-tile and so is not subject to P2
    // en-route encounters, per the agreed scope). backArrive keeps the existing time-based return semantics.
    // Query-optimization (2026-07-29): the box is swap-invariant (swapping the two endpoints yields the same
    // min/max), so a doc that already carries minX/maxX/minY/maxY needs no change here — but recomputing it
    // unconditionally from the pre-flip from/toTile also means a pre-migration legacy doc (missing the fields
    // entirely) self-heals the moment it is recalled, instead of staying invisible to enemy vision queries for
    // the rest of its lifetime.
    const box = legBox(this.core.coordX(m.fromTile), this.core.coordY(m.fromTile), this.core.coordX(m.toTile), this.core.coordY(m.toTile));
    const claimed = await cols.marches.findOneAndUpdate(
      { _id: mid, status: 'marching', kind: { $ne: 'return' } },
      {
        $set: {
          kind: 'return',
          fromTile: m.toTile,
          toTile: m.fromTile,
          departAt: t,
          arriveAt: backArrive,
          ...box,
        },
        $unset: { path: '', stepIndex: '', nextStepAt: '' },
        $inc: { rev: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!claimed) throw new SlgError('MARCH_NOT_FOUND', 'March has already arrived or been recalled');
    // Clear the occupancy entry the outbound leg left on the cell it had reached (best-effort; match-guarded).
    if (m.path && m.stepIndex != null) {
      const cur = m.path[m.stepIndex];
      if (cur) await this.core.clearOccupancy(worldId, tileId(worldId, cur.x, cur.y), mid);
    }
    const view = this.core.marchView(claimed);
    void this.core.pushMarch(accountId, view);
    return view;
  }

  /**
   * 2026-08-01 (SLG_DESIGN_LOG §46): pay coins to instantly complete an in-transit 'return' march — the paid
   * counterpart to the new default "returns take travel time" model. Cost is always the server-computed full
   * remaining-time price (user decision: no partial buy-down like speedupTraining/speedupBuild's client-chosen
   * coin amount — this is a single "finish now" action). Settles the return leg's arrival immediately on
   * success, mirroring applyArrival's kind==='return' branch (refund + push).
   */
  async instantReturnMarch(worldId: string, accountId: string, mid: string, clientPlatform?: string): Promise<PlayerWorldView> {
    const { cols, now } = this.core.deps;
    const m = await cols.marches.findOne({ _id: mid, worldId, ownerId: accountId, kind: 'return', status: 'marching' });
    if (!m) throw new SlgError('MARCH_NOT_FOUND', 'No in-transit return march found');
    const t = now();
    const remainingSec = Math.max(0, (m.arriveAt - t) / 1000);
    const coins = Math.max(1, Math.ceil(remainingSec / MARCH_RETURN_SPEEDUP_SECS_PER_COIN));
    const orderId = `slg_march_instant_return:${worldId}:${mid}:${t}`;
    await this.core.commercial.spend(accountId, coins, orderId, clientPlatform);

    // Atomic claim: only an in-transit return leg still in 'marching' state settles here. A lost race (the leg
    // arrived naturally between the read above and this claim) means the coins bought nothing extra — same
    // accepted "money path" edge case as speedupTraining/speedupBuild (city.ts), not specially compensated.
    const claimed = await cols.marches.findOneAndDelete({ _id: mid, worldId, ownerId: accountId, status: 'marching', kind: 'return' });
    if (claimed) {
      const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
      if (pw) await refundTroops(this.core, pw, claimed.troops, t);
      void this.core.pushMarch(accountId, this.core.marchView({ ...claimed, status: 'recalled' }));
    }
    return this.core.getMe(worldId, accountId);
  }

  /** List of all in-transit marches in the player's current world (the scheduler deletes them on arrival, so all results are marches that have not yet arrived). */
  async getMarches(worldId: string, accountId: string): Promise<MarchView[]> {
    const { cols, mapW, mapH, now } = this.core.deps;
    const own = await cols.marches.find({ worldId, ownerId: accountId }).sort({ arriveAt: 1 }).toArray();
    const result: MarchView[] = own.map((d) => ({ ...this.core.marchView(d), mine: true }));

    // G5: enemy marches within vision (after reverse-push, the client renders these via refreshMarches). Family ally marches are excluded
    // (ally determination relies on the family set); only genuinely non-family others' in-transit marches whose interpolated current position falls within our vision are included.
    const family = await this.core.familyMemberIds(worldId, accountId);
    const sources = await this.core.computeVisionSources(worldId, accountId, 0, mapW - 1, 0, mapH - 1);
    const t = now();
    // Query-optimization (2026-07-29): this used to be `find({worldId,status:'marching'})` — every in-transit
    // march in the whole world, filtered by interpolated position in JS. Push a coarse "does this march's
    // whole visited range even overlap the viewer's vision bounding box" filter into Mongo first (see
    // MarchDoc.minX/maxX/minY/maxY doc comment); the exact per-position isInVision check below still runs on
    // the (now much smaller) candidate set. No vision sources at all (e.g. not yet joined) → nothing could
    // possibly be visible, skip the query entirely.
    const box = sourcesBoundingBox(sources);
    const others = box
      ? await cols.marches
          .find({
            worldId,
            status: 'marching',
            minX: { $lte: box.hiX },
            maxX: { $gte: box.loX },
            minY: { $lte: box.hiY },
            maxY: { $gte: box.loY },
          })
          .toArray()
      : [];
    for (const d of others) {
      if (family.has(d.ownerId)) continue; // own / family — no duplicate and not treated as enemy
      const pos = marchInterpPos(
        this.core.coordX(d.fromTile), this.core.coordY(d.fromTile),
        this.core.coordX(d.toTile), this.core.coordY(d.toTile),
        d.departAt, d.arriveAt, t,
      );
      if (isInVision(sources, pos.x, pos.y)) result.push({ ...this.core.marchView(d), mine: false });
    }
    return result;
  }

  /**
   * Arrival processing: scan all in-transit marches with arriveAt ≤ now, atomically claim them (findOneAndDelete), then apply effects by kind.
   * The Mongo `arriveAt` index scan is the sole mechanism (2026-07-27: the Redis ZSET wake-up hint this docstring
   * used to describe was write-only — nothing ever read it back — and was removed as dead I/O; see core/push.ts history).
   * Returns the number of marches processed. worldsvc single-consumer (U12; single-process is acceptable for early stage).
   */
  async processDueArrivals(nowMs?: number): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();
    // ADR-051 (P1): a march needs processing when its next per-tile step is due (stepping marches carry
    // `nextStepAt`) or — for legacy docs and 'return' legs that carry no stepping cursor — when its final arrival
    // is due (`arriveAt`). Stepping marches advance tile-by-tile (updating the occupancy index for the P2
    // encounter check) and only settle when they reach the final path cell; the net arrival timing is unchanged
    // (path[last] is reached at arriveAt), so callers that jump the clock past arriveAt still settle in one call.
    const due = await cols.marches
      .find({
        status: 'marching',
        $or: [
          { nextStepAt: { $lte: t } },
          { nextStepAt: { $exists: false }, arriveAt: { $lte: t } },
        ],
      })
      .limit(500)
      .toArray();
    let n = 0;
    for (const m of due) {
      if (m.path && m.stepIndex != null && m.nextStepAt != null) {
        // Stepping march: advance cell-by-cell up to t; settles (and counts) only on reaching the final cell.
        if (await this.advanceMarch(m, t)) n++;
      } else {
        // Legacy / return leg: single-arrival model (unchanged). Atomic claim + delete; skip if lost to a recall
        // or concurrent processor.
        const claimed = await cols.marches.findOneAndDelete({ _id: m._id, status: 'marching' });
        if (!claimed) continue;
        await this.applyArrival(claimed, t);
        n++;
      }
    }
    return n;
  }

  /**
   * ADR-051 (P1/P2b): advance a stepping march tile-by-tile up to time `t`, writing the occupancy index at each
   * cell entered and (P2b) resolving a field encounter whenever the cell already holds an ENEMY unit. Returns
   * true iff the march is fully handled and must not be rescheduled — either it reached its final path cell and
   * its arrival was applied (claimed+deleted), or it was destroyed by a lost en-route encounter (also deleted).
   * Otherwise the step cursor (stepIndex/nextStepAt) is persisted; the next processDueArrivals scan (Mongo
   * nextStepAt) picks it up. The occupancy write stays best-effort (Redis-absent = no encounters, arrival still
   * correct via Mongo).
   */
  private async advanceMarch(m: MarchDoc, t: number): Promise<boolean> {
    const { cols } = this.core.deps;
    const path = m.path!;
    const last = path.length - 1;
    let idx = m.stepIndex!;
    // ADR-051 (P2b): the marcher's world doc — needed for friend/foe (familyId) on the encounter check and for
    // its card/pool survivor ledger inside resolveFieldEncounter (which keeps pw.cardState in sync across a
    // multi-encounter step batch). Loaded once per advance; a missing pw simply disables encounters this tick.
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, m.ownerId) });
    const familyId = pw?.familyId;
    // Step through every cell whose arrival time has already elapsed by t. Each hop vacates the cell just left
    // (match-guarded clear) and occupies the new one, so the index holds exactly the march's CURRENT cell — never
    // a trail of stale entries.
    while (idx < last && marchStepArriveAt(m.departAt, idx + 1) <= t) {
      const left = path[idx]!;
      idx++;
      const cell = path[idx]!;
      await this.core.clearOccupancy(m.worldId, tileId(m.worldId, left.x, left.y), m._id);
      const tid = tileId(m.worldId, cell.x, cell.y);

      // ADR-051 tile-entry encounter check. Two enemy sources, resolved through the same runSiegeBattle path:
      //   P2b — occ: an enemy unit standing ON this cell (leaveAt still overlapping). scenario 1 = a parked
      //         stationed team; scenario 2 = an earlier-arriving march still on the cell.
      //   P3b — cover: this cell falls inside an enemy GARRISON's 3×3 defended footprint (scenario 3) — the
      //         garrison sits on a different (center) cell but intercepts anyone passing its 9 cells.
      // The occ check runs first (a fight there settles the cell); only if it did not fight do we consult cover.
      // A FRIENDLY occ resident is passed peacefully, but we must NOT clobber its occ entry (a stationed ally
      // would otherwise vanish from the index), so we skip writing our own occ on that one cell.
      let skipOwnOcc = false;
      if (pw) {
        let enc: Awaited<ReturnType<typeof this.siege.resolveFieldEncounter>> | null = null;
        const occ = await this.core.getOccupancy(m.worldId, tid);
        if (occ && occ.id !== m._id && occ.leaveAt > t) {
          if (occ.ownerId !== m.ownerId && !(familyId && occ.familyId === familyId)) {
            enc = await this.siege.resolveFieldEncounter(m, pw, occ, tid, t);
          } else {
            skipOwnOcc = true; // friendly resident — leave its occ untouched
          }
        }
        // No occ fight → consult the coverage index (§3.4). Two kinds of enemy cover, resolved in order:
        //   P5 (§5.2) arrow tower → chip the marcher's army (pass-through damage, no stop). Applied first so a
        //             marcher shot down by tower fire never reaches the melee; a flat army wiped to 0 dies here.
        //   P3b garrison → the FIRST enemy garrison covering this cell intercepts with a real battle.
        if (!enc) {
          const covers = await this.core.getCover(m.worldId, tid);
          const enemyCovers = covers.filter((c) => c.ownerId !== m.ownerId && !(familyId && c.familyId === familyId));
          for (const tower of enemyCovers) {
            if (tower.kind !== 'tower') continue;
            const dmg = await this.siege.applyTowerDamage(m, pw, tower, t);
            if (!dmg.applied) continue;
            m.troops = dmg.marcherTroops;
            if (dmg.marcherArmy !== undefined) m.army = dmg.marcherArmy;
            await cols.marches.updateOne(
              { _id: m._id, status: 'marching', kind: { $ne: 'return' } },
              { $set: { troops: m.troops, ...(dmg.marcherArmy !== undefined ? { army: dmg.marcherArmy } : {}) }, $inc: { rev: 1 } },
            );
            if (dmg.marcherDestroyed) {
              // Wiped by tower fire mid-route: delete the march. `left` is already vacated; no occ was written on `tid`.
              const claimed = await cols.marches.findOneAndDelete({ _id: m._id, status: 'marching' });
              if (claimed) {
                void this.core.pushMarch(m.ownerId, this.core.marchView({ ...claimed, status: 'recalled' }));
              }
              return true; // fully handled (removed) — do not reschedule
            }
          }
          const garCover = enemyCovers.find((c) => c.kind === 'garrison');
          if (garCover) {
            const garrisonOcc = {
              kind: 'stationed' as const,
              id: garCover.sourceTile,
              ownerId: garCover.ownerId,
              ...(garCover.familyId ? { familyId: garCover.familyId } : {}),
              ...(garCover.teamId ? { teamId: garCover.teamId } : {}),
              tile: garCover.sourceTile,
              leaveAt: Number.MAX_SAFE_INTEGER,
            };
            enc = await this.siege.resolveFieldEncounter(m, pw, garrisonOcc, garCover.sourceTile, t);
          }
        }
        if (enc && enc.fought && !enc.marcherContinues) {
          // Marcher destroyed en route: delete the march first (its cardState/pool ledger was already folded
          // back by the encounter). `left` is already vacated and we never wrote our occ on `tid`, so nothing
          // to clear. Only AFTER the delete do we spawn a travel-time return leg (2026-08-01, SLG_DESIGN_LOG
          // §46) when returnTroops is set — both docs share teamId, and creating the new leg before removing
          // the old one would collide with the {worldId,ownerId,teamId} uniqueness guard.
          const claimed = await cols.marches.findOneAndDelete({ _id: m._id, status: 'marching' });
          if (claimed) {
            void this.core.pushMarch(m.ownerId, this.core.marchView({ ...claimed, status: 'recalled' }));
            if (enc.returnTroops !== undefined) {
              await startReturnMarch(this.core, {
                worldId: claimed.worldId, ownerId: claimed.ownerId, fromTile: tid,
                x: this.core.coordX(tid), y: this.core.coordY(tid),
                troops: enc.returnTroops, army: claimed.army, teamId: claimed.teamId, leaderUnitType: claimed.leaderUnitType,
              }, t);
            }
          }
          return true; // fully handled (removed) — do not reschedule
        }
        if (enc && enc.fought) {
          // Marcher won → carry survivors forward. Persist onto the MarchDoc (and the in-memory `m`) so a later
          // encounter this batch, and the final arrival settlement, use the reduced force. The resident defender
          // (occ) or garrison (cover) + its indexes were already removed by resolveFieldEncounter.
          m.troops = enc.marcherTroops;
          if (enc.marcherArmy !== undefined) m.army = enc.marcherArmy;
          await cols.marches.updateOne(
            { _id: m._id, status: 'marching', kind: { $ne: 'return' } },
            { $set: { troops: m.troops, ...(enc.marcherArmy !== undefined ? { army: enc.marcherArmy } : {}) }, $inc: { rev: 1 } },
          );
          // 2026-08-01 (SLG_DESIGN_LOG §46 root cause): "won" only means this SINGLE encounter's own troop-count
          // comparison went the marcher's way — for a card army, m.troops is a stale snapshot (real strength
          // lives in pw.cardState.currentTroops, per CC-3) and was never re-derived here. Repeated attrition
          // across several encounters this batch can grind every card in the army down to 0 real troops while
          // this per-encounter check keeps reporting a "win"; the march would otherwise carry an empty shell all
          // the way to its destination and lose a real siege battle it had no way to win (see the (33,293)
          // Atk·Loss investigation). Re-check the army's actual current strength right after each encounter and,
          // if every card is now at 0, treat it exactly like `!enc.marcherContinues` above (full wipe, no
          // survivors to send home — matches the existing convention that a full wipe never has a return leg).
          const cardArmy = (m.army ?? []).filter((e) => !!e.cardInstanceId);
          const cardArmyWiped =
            cardArmy.length > 0 &&
            cardArmy.every((e) => (pw.cardState?.[e.cardInstanceId!]?.currentTroops ?? 0) <= 0);
          if (cardArmyWiped) {
            const claimed = await cols.marches.findOneAndDelete({ _id: m._id, status: 'marching' });
            if (claimed) {
              void this.core.pushMarch(m.ownerId, this.core.marchView({ ...claimed, status: 'recalled' }));
            }
            return true; // fully handled (removed) — do not reschedule
          }
        }
      }

      if (!skipOwnOcc) {
        const leaveAt = idx < last ? marchStepArriveAt(m.departAt, idx + 1) : Number.MAX_SAFE_INTEGER;
        await this.core.setOccupancy(m.worldId, tid, {
          kind: 'march',
          id: m._id,
          ownerId: m.ownerId,
          ...(familyId ? { familyId } : {}),
          teamId: m.teamId,
          tile: tid,
          leaveAt,
        });
      }
    }
    if (idx >= last) {
      // Reached the destination cell → settle arrival (atomic claim + delete, then apply by kind). Clear the
      // occupancy entry for the final cell (applyArrival may re-register it as a stationed team via P3).
      const claimed = await cols.marches.findOneAndDelete({ _id: m._id, status: 'marching' });
      if (!claimed) return false; // lost to a concurrent recall / processor
      await this.core.clearOccupancy(claimed.worldId, claimed.toTile, claimed._id);
      await this.applyArrival(claimed, t);
      return true;
    }
    // Mid-route: persist the new cursor. Guard on status:'marching' AND kind≠return so a concurrent recall
    // (which flips to a return leg and $unsets the cursor) is never clobbered back. The next processDueArrivals
    // scan (Mongo nextStepAt) picks up the advance from here.
    const nextStepAt = marchStepArriveAt(m.departAt, idx + 1);
    await cols.marches.updateOne(
      { _id: m._id, status: 'marching', kind: { $ne: 'return' } },
      { $set: { stepIndex: idx, nextStepAt }, $inc: { rev: 1 } },
    );
    return false;
  }

  /** Apply the effects of a single arrived march (already removed from marches collection). */
  private async applyArrival(m: MarchDoc, t: number): Promise<void> {
    const { cols } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, m.ownerId) });
    if (!pw) return; // player state missing (should not happen); troops are lost with it; exit safely.

    if (m.kind === 'return') {
      await refundTroops(this.core, pw, m.troops, t);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      return;
    }

    if (m.kind === 'attack') {
      await this.siege.applySiege(m, pw, t);
      return;
    }

    if (m.kind === 'sweep') {
      await this.siege.applySweep(m, pw, t);
      return;
    }

    if (m.kind === 'move') {
      await this.applyMove(m, pw, t);
      return;
    }

    if (m.kind === 'occupy') {
      // ADR-037 (§5.4): occupy arrival now fights the target's system garrison (or an in-progress occupier's held
      // garrison, if expelling) via the same deterministic engine siege uses, and — on victory — starts a delayed
      // occupation hold instead of writing ownership immediately. See combatSiege/occupation.ts.
      await this.siege.applyOccupy(m, pw, t);
      return;
    }

    // reinforce
    const target = await cols.tiles.findOne({ _id: m.toTile });
    if (!target || target.ownerId !== m.ownerId) {
      // Reinforcement target is no longer own territory (captured / abandoned) → target invalidated on arrival,
      // same disposition as the siege/occupy miss branches (2026-08-01, SLG_DESIGN_LOG §46): park in place for
      // a team-dispatched march, else keep the old instant refund.
      if (m.teamId) {
        await parkMarchInPlace(this.core, m, m.troops, t);
      } else {
        await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      }
      return;
    }
    await cols.tiles.updateOne({ _id: m.toTile }, { $inc: { garrison: m.troops, rev: 1 } });
    void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
    const after = await cols.tiles.findOne({ _id: m.toTile });
    if (after) void this.core.pushTile(m.ownerId, after);
  }

  /**
   * Move arrival (2026-07-23): no combat — the team simply STANDS on the target tile. Re-validate the tile is
   * still a legal stand (own tile, or an empty neutral not since owned / mid-hold / already parked); on success
   * write a StationedDoc so the team stays "out" here until recalled, and push.
   * 2026-08-01 fix (SLG_DESIGN_LOG §46): the destination becoming blocked between dispatch and arrival used to
   * just push a 'recalled' status with no other effect — no StationedDoc, no refund — silently deleting the
   * team's troops (advanceMarch/processDueArrivals already removed the MarchDoc before calling this). 'move'
   * is always team-based (startMarch throws BAD_REQUEST without a team) and, unlike attack/occupy, never
   * resolves into combat — there is no "survivors" concept to refund, only a team that has nowhere to land.
   * Park it back at its own departure tile instead (same StationedDoc/occupancy/cover writes as a successful
   * arrival, just retargeted) so the team is never worse off than if it had stayed put. Only if the origin has
   * ALSO become unavailable in the meantime (e.g. captured while the team was in transit) do we fall back to
   * refunding the pool — mirroring the miss-handling in combatSiege/arrival.ts and occupation.ts.
   */
  private async applyMove(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
    if (!m.teamId) {
      // Unreachable in practice (startMarch guarantees a team for every 'move'); kept only because
      // MarchDoc.teamId is typed optional. A card army's strength lives in cardState regardless of this refund.
      const hasCardArmy = (m.army ?? []).some((e) => !!e.cardInstanceId);
      if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      return;
    }
    const toX = this.core.coordX(m.toTile);
    const toY = this.core.coordY(m.toTile);
    if (await this.tryParkTeam(m, m.teamId, pw, m.toTile, toX, toY, t, 'arrived')) return;

    const fromX = this.core.coordX(m.fromTile);
    const fromY = this.core.coordY(m.fromTile);
    if (await this.tryParkTeam(m, m.teamId, pw, m.fromTile, fromX, fromY, t, 'recalled')) return;

    const hasCardArmy = (m.army ?? []).some((e) => !!e.cardInstanceId);
    if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
    void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
  }

  /**
   * Try to park m's team as a StationedDoc on `tile` (x,y): same legality check applyMove always used for its
   * destination (not the world center, not already stationed-on by anyone, not another owner's tile, not mid
   * occupation-hold) — reused here for both the intended destination and, on a miss, the fallback origin tile.
   * Returns false (no writes at all) if `tile` is currently blocked.
   */
  private async tryParkTeam(
    m: MarchDoc,
    teamId: string,
    pw: PlayerWorldDoc,
    tile: string,
    x: number,
    y: number,
    t: number,
    pushStatus: 'arrived' | 'recalled',
  ): Promise<boolean> {
    const { cols } = this.core.deps;
    const proc = proceduralTile(m.worldId, x, y);
    const [occ, stationedHere] = await Promise.all([
      cols.tiles.findOne({ _id: tile }),
      cols.stationed.findOne({ _id: tile }),
    ]);
    const blocked =
      proc.type === 'center' ||
      !!stationedHere ||
      (occ?.ownerId != null && occ.ownerId !== m.ownerId) ||
      (!occ?.ownerId && !!occ?.contestedBy && (occ.contestedUntil ?? 0) > t);
    if (blocked) return false;
    // ADR-051 (P3a): the dispatch intent decides 停留 idle vs 驻扎 garrison on arrival.
    const mode: 'idle' | 'garrison' = m.stationMode === 'garrison' ? 'garrison' : 'idle';
    const doc: StationedDoc = {
      _id: tile,
      worldId: m.worldId,
      ownerId: m.ownerId,
      ...(pw.familyId ? { familyId: pw.familyId } : {}),
      tile,
      x,
      y,
      teamId,
      army: m.army ?? [],
      troops: m.troops,
      sinceAt: t,
      mode,
      ...(m.leaderUnitType ? { leaderUnitType: m.leaderUnitType } : {}),
    };
    await cols.stationed.updateOne({ _id: tile }, { $set: doc }, { upsert: true });
    // ADR-051 (P2): register the parked team in the occupancy index (leaveAt=∞) so an enemy march entering this
    // tile detects it as an occupant (scenario 1). Cleared on recall (recallStationed) or capture (abandonTile).
    await this.core.setOccupancy(m.worldId, tile, {
      kind: 'stationed',
      id: tile,
      ownerId: m.ownerId,
      ...(pw.familyId ? { familyId: pw.familyId } : {}),
      teamId,
      tile,
      leaveAt: Number.MAX_SAFE_INTEGER,
    });
    // ADR-051 (P3a): a garrison also covers its 3×3 footprint in the reverse index so P3b can intercept enemies
    // passing any of the 9 cells. An idle team only defends its own cell (via the occ scenario-1 check) → no cover.
    if (mode === 'garrison') {
      await this.core.addCover(m.worldId, x, y, {
        kind: 'garrison',
        sourceTile: tile,
        ownerId: m.ownerId,
        ...(pw.familyId ? { familyId: pw.familyId } : {}),
        teamId,
      });
    }
    void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: pushStatus }));
    const after = await cols.tiles.findOne({ _id: tile });
    if (after) void this.core.pushTile(m.ownerId, after);
    return true;
  }

  /**
   * Recall a stationed team home (2026-07-23): claim-and-delete the StationedDoc, then dispatch a 'return' leg
   * tile→base carrying the SAME teamId so the team stays "out" through the trip (freed only when the return
   * arrives and the shared return handler deletes the doc). A flat army's troops are refunded to the pool on
   * arrival; a card army carries 0 here (its strength lives in cardState) so the return credits nothing.
   */
  async recallStationed(worldId: string, accountId: string, teamId: string): Promise<MarchView | Record<string, never>> {
    const { cols, now } = this.core.deps;
    const claimed = await cols.stationed.findOneAndDelete({ worldId, ownerId: accountId, teamId });
    if (!claimed) throw new SlgError('MARCH_NOT_FOUND', 'No stationed team to recall');
    // ADR-051 (P2): the parked team leaves the field → drop its occupancy entry (match-guarded on tileId).
    await this.core.clearOccupancy(worldId, claimed.tile, claimed.tile);
    // ADR-051 (P3a): a recalled garrison also drops its 9-cell coverage from the reverse index.
    if (claimed.mode === 'garrison') await this.core.removeCover(worldId, claimed.x, claimed.y, claimed.tile);
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw?.mainBaseTile) return {}; // no home to return to (should not happen) — team is simply freed
    const bx = this.core.coordX(pw.mainBaseTile);
    const by = this.core.coordY(pw.mainBaseTile);
    const hasCardArmy = (claimed.army ?? []).some((e) => !!e.cardInstanceId);
    const t = now();
    const path = await computeMarchPath(this.core, worldId, claimed.x, claimed.y, bx, by, accountId);
    const arriveAt = t + marchDurationFromPath(path) * 1000;
    const back: MarchDoc = {
      _id: marchId(worldId, accountId, t, ++this.core.marchSeq),
      worldId,
      ownerId: accountId,
      fromTile: claimed.tile,
      toTile: pw.mainBaseTile,
      kind: 'return',
      troops: hasCardArmy ? 0 : claimed.troops,
      ...(claimed.army && claimed.army.length > 0 ? { army: claimed.army } : {}),
      teamId,
      ...(claimed.leaderUnitType ? { leaderUnitType: claimed.leaderUnitType } : {}),
      departAt: t,
      arriveAt,
      status: 'marching',
      ...legBox(claimed.x, claimed.y, bx, by),
      rev: 0,
    };
    await cols.marches.insertOne(back);
    const view = this.core.marchView(back);
    void this.core.pushMarch(accountId, view);
    return view;
  }

  /** List the player's own stationed teams (2026-07-23: field-stationing status + recall affordance + idle-sprite rendering). */
  async getStationed(worldId: string, accountId: string): Promise<StationedView[]> {
    const { cols, mapW, mapH } = this.core.deps;
    const own = await cols.stationed.find({ worldId, ownerId: accountId }).toArray();
    const result: StationedView[] = own.map((d) => ({
      tile: d.tile, x: d.x, y: d.y, teamId: d.teamId, troops: d.troops, sinceAt: d.sinceAt, mode: d.mode ?? 'idle', mine: true,
      ...(d.leaderUnitType ? { leaderUnitType: d.leaderUnitType } : {}),
    }));

    // ADR-051 (P4): enemy stationed teams within vision, so the client can render enemy field troops + their
    // garrison defense zones (mirrors getMarches' vision-gated enemy-march inclusion). Family allies are excluded
    // (they're rendered as own-side / not enemies); a team standing on a fixed tile is either in vision or not, so
    // the position test is a plain isInVision on its cell. teamId is blanked — it is the enemy's slot, not ours,
    // and leaking it would collide with our own slot ids in the client's team-busy gate.
    const family = await this.core.familyMemberIds(worldId, accountId);
    const sources = await this.core.computeVisionSources(worldId, accountId, 0, mapW - 1, 0, mapH - 1);
    // Query-optimization (2026-07-29): this used to be `find({worldId, ownerId:{$ne:accountId}})` — every
    // stationed team in the whole world (`$ne` falls outside the {worldId,ownerId} index prefix, so it
    // degenerated to a per-world scan). Stationed teams don't move, so their (x,y) is exact (no derived box
    // needed, unlike marches): push the viewer's vision bounding box straight into the query, then exclude
    // self in-memory on the now much smaller result (cheaper than trying to index around `$ne`).
    const box = sourcesBoundingBox(sources);
    const others = box
      ? await cols.stationed
          .find({ worldId, x: { $gte: box.loX, $lte: box.hiX }, y: { $gte: box.loY, $lte: box.hiY } })
          .toArray()
      : [];
    for (const d of others) {
      if (d.ownerId === accountId) continue; // self — already listed above as `mine:true`
      if (family.has(d.ownerId)) continue; // own / family — not treated as enemy
      if (!isInVision(sources, d.x, d.y)) continue;
      result.push({
        tile: d.tile, x: d.x, y: d.y, teamId: '', troops: d.troops, sinceAt: d.sinceAt, mode: d.mode ?? 'idle', mine: false,
        ...(d.leaderUnitType ? { leaderUnitType: d.leaderUnitType } : {}),
      });
    }
    return result;
  }
}
