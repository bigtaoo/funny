// worldsvc combat domain: marches (S8-2) — start / recall / list + arrival processing & dispatch.
// Peeled out of CombatService (2026-07-03). Depends on WorldCore for shared state, vision, push/schedule
// infra and nations (applyNationChange); attack/sweep arrivals are dispatched to SiegeService. No behavior change.
import {
  proceduralTile,
  tileId,
  marchId,
  playerWorldId,
  findMarchPath,
  marchDurationFromPath,
  marchMoraleFromPath,
  OCCUPY_MIN_TROOPS,
  MARCH_MIN_TROOPS,
  isInVision,
  marchInterpPos,
  baseFootprintCells,
  satchelCarryCapFor,
  SlgError,
  type PathCell,
  type MarchKind,
} from '@nw/shared';
import type { MarchDoc, ArmyEntry } from './db';
import { WorldCore, MARCHABLE_KINDS } from './core';
import type { MarchView } from './worldTypes';
import { refundTroops } from './combatShared';
import type { SiegeService } from './combatSiege';

export class MarchService {
  constructor(
    private readonly core: WorldCore,
    private readonly siege: SiegeService,
  ) {}

  /**
   * A* pathfinding for marches: pre-fetch all occupied crossing (bridge/plankway) tiles, assemble passableGateKeys, then call findMarchPath.
   * Crossing passage rules (S8-4): crossings occupied by the requester and crossings occupied by members of the same family are passable
   * (allied sect passage is S8-4+ with the alliance system pending; currently only within the same family).
   * No path found → throw PATH_BLOCKED (HTTP 400).
   */
  private async computeMarchPath(
    worldId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    requesterId: string,
  ): Promise<PathCell[]> {
    // Retrieve the requester's current family (if any); crossings occupied by fellow family members are also passable.
    const requesterPw = await this.core.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, requesterId) });
    const allyFamilyId = requesterPw?.familyId;

    // Crossings (bridge/plankway) are sparse; fetch all occupied ones at once and filter, to avoid async calls inside A*.
    const gateTiles = await this.core.deps.cols.tiles
      .find({ worldId, type: { $in: ['bridge', 'plankway'] } })
      .project<{ _id: string; x: number; y: number; ownerId: string | undefined; familyId: string | undefined }>({
        _id: 1, x: 1, y: 1, ownerId: 1, familyId: 1,
      })
      .toArray();
    const passableGateKeys = new Set<string>(
      gateTiles
        .filter((g) =>
          g.ownerId === requesterId ||
          (allyFamilyId && g.familyId === allyFamilyId),
        )
        .map((g) => `${g.x}:${g.y}`),
    );
    // ADR-025: other players' 3×3 capitals are solid buildings that block pathing (path-blocking); the marcher
    // routes around them but can still march ONTO an enemy base tile to besiege it (findMarchPath exempts
    // the destination). The marcher's own base cells are excluded so owners march in/out freely.
    // When the destination IS an enemy base cell (a siege), also exclude THAT base's whole footprint so
    // every one of its 9 cells — including the center, which is otherwise walled in by its own ring — is
    // reachable ("attack any cell = attack the base"). Only that one base opens up; all others still block.
    const destTile = await this.core.deps.cols.tiles.findOne({ _id: tileId(worldId, toX, toY) });
    const siegeBaseOwner = destTile?.type === 'base' ? destTile.ownerId : undefined;
    const excludeOwners = siegeBaseOwner ? [requesterId, siegeBaseOwner] : [requesterId];
    const blockedBaseTiles = await this.core.deps.cols.tiles
      .find({ worldId, type: 'base', ownerId: { $nin: excludeOwners } })
      .project<{ x: number; y: number }>({ x: 1, y: 1 })
      .toArray();
    const blockedBaseKeys = new Set<string>(blockedBaseTiles.map((b) => `${b.x}:${b.y}`));
    // Always keep the requester's own capital footprint passable, derived from mainBaseTile rather than
    // per-cell ownerId: a legacy base whose ring cells lost their ownerId would otherwise be treated as an
    // enemy building (missing ownerId matches the $nin above) and wall the owner's army inside its own city.
    if (requesterPw?.mainBaseTile) {
      const bx = this.core.coordX(requesterPw.mainBaseTile), by = this.core.coordY(requesterPw.mainBaseTile);
      if (Number.isFinite(bx) && Number.isFinite(by)) {
        for (const c of baseFootprintCells(bx, by)) blockedBaseKeys.delete(`${c.x}:${c.y}`);
      }
    }
    const path = findMarchPath(
      worldId,
      this.core.deps.mapW,
      this.core.deps.mapH,
      fromX,
      fromY,
      toX,
      toY,
      passableGateKeys,
      blockedBaseKeys,
    );
    if (!path) throw new SlgError('PATH_BLOCKED', 'No viable path found');
    return path;
  }

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
  ): Promise<MarchView> {
    const { cols, now } = this.core.deps;
    if (!MARCHABLE_KINDS.has(kind)) {
      throw new SlgError('NOT_IMPLEMENTED', `March kind ${kind} is not implemented (siege S8-3)`);
    }
    // Scout temporarily disabled (2026-07-21): entry point hidden client-side; reject here too in case of a stale client or direct API call.
    if (kind === 'scout') {
      throw new SlgError('NOT_IMPLEMENTED', 'Scout is temporarily disabled');
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
    if ((kind === 'attack' || kind === 'occupy') && teamId) {
      const team = (pw.teams ?? []).find((t) => t.id === teamId);
      if (!team || team.army.length === 0) throw new SlgError('BAD_REQUEST', 'Team does not exist or is empty');
      // Idle-team gate (2026-07-15): a team already committed to an active (non-recalled) march must not accept
      // a new order — same "out" predicate as the defender-skip check in combatSiege/arrival.ts (ADR-026 §2).
      // Marches are deleted from the collection once processed (combatMarch.ts claim-and-delete), so "marching"
      // covers transit; a won occupy/siege then hands the team off to an OccupationDoc for the hold countdown
      // (combatSiege/occupation.ts) — check both so the team stays "out" end-to-end until the player recalls it
      // (recall mid-hold is out of scope here; the hold simply has to run its course today).
      const [busyMarch, busyHold] = await Promise.all([
        cols.marches.findOne({ worldId, ownerId: accountId, teamId, status: { $ne: 'recalled' } }),
        cols.occupations.findOne({ worldId, ownerId: accountId, teamId }),
      ]);
      if (busyMarch || busyHold) throw new SlgError('TEAM_BUSY', 'Team is already marching or occupying; recall it first');
      army = team.army;
      troops = team.army.reduce((s, e) => s + Math.max(1, Math.floor(e.initialHp ?? 0)), 0);
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
    if (!fromTile || fromTile.ownerId !== accountId) {
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
    if (!hasCardArmy && pw.troops < troops) throw new SlgError('NO_TROOPS', 'Insufficient troops');

    const path = await this.computeMarchPath(worldId, fromX, fromY, toX, toY, accountId);
    const departAt = t;
    const arriveAt = departAt + marchDurationFromPath(path) * 1000;
    // Morale (行军疲劳 — see SLG_DESIGN.md §4.4; distinct from the card "士气加成" bonus): 1 point lost per tile moved, computed once from the full path since marches don't tick
    // live in transit (single scheduled arrival event). Scales combat power on arrival — see moraleCombatMultiplier.
    const morale = marchMoraleFromPath(path);
    const mid = marchId(worldId, accountId, departAt, ++this.core.marchSeq);
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
      // ADR-026: record the deployed team slot so it is skipped as a defender while out (meaningful for both team-based attacks and, since 2026-07-15, occupy marches).
      ...((kind === 'attack' || kind === 'occupy') && teamId ? { teamId } : {}),
      departAt,
      arriveAt,
      status: 'marching',
      rev: 0,
    };
    // The partial-unique index on {worldId,ownerId,teamId} (db.ts) is the atomic backstop for the idle-team
    // gate above: two concurrent dispatches of the same team both clear the findOne pre-check, but only one insert
    // wins — the loser hits E11000 and is reported as TEAM_BUSY. Non-team (flat-pool) marches carry no teamId and
    // are unaffected. No pool troops were deducted yet, so a rejected insert leaves player state untouched.
    try {
      await cols.marches.insertOne(doc);
    } catch (e) {
      if (teamId && (e as { code?: number }).code === 11000) {
        throw new SlgError('TEAM_BUSY', 'Team is already marching or occupying; recall it first');
      }
      throw e;
    }
    // Deduct troops on departure (in-transit; not in the pool) — skipped for card armies, whose strength
    // already lives in cardState.currentTroops and never touches playerWorld.troops (see hasCardArmy above).
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      hasCardArmy
        ? { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } }
        : { $set: { resources, lastTickAt: t }, $inc: { troops: -troops, rev: 1 } },
    );
    await this.core.scheduleMarch(worldId, mid, arriveAt);
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
    const claimed = await cols.marches.findOneAndUpdate(
      { _id: mid, status: 'marching', kind: { $ne: 'return' } },
      {
        $set: {
          kind: 'return',
          fromTile: m.toTile,
          toTile: m.fromTile,
          departAt: t,
          arriveAt: backArrive,
        },
        $inc: { rev: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!claimed) throw new SlgError('MARCH_NOT_FOUND', 'March has already arrived or been recalled');
    await this.core.scheduleMarch(worldId, mid, backArrive); // update score on the same member (ZSET)
    const view = this.core.marchView(claimed);
    void this.core.pushMarch(accountId, view);
    return view;
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
    const others = await cols.marches.find({ worldId, status: 'marching' }).toArray();
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
   * The Mongo `arriveAt` index scan is authoritative (works across worlds and without Redis); the Redis ZSET is only a precise wake-up hint
   * (maintained by scheduleMarch, §14.4). Returns the number of marches processed. worldsvc single-consumer (U12; single-process is acceptable for early stage).
   */
  async processDueArrivals(nowMs?: number): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();
    const due = await cols.marches
      .find({ status: 'marching', arriveAt: { $lte: t } })
      .limit(500)
      .toArray();
    let n = 0;
    for (const m of due) {
      // Atomic claim + delete (transient document consumed on arrival); skip if lost to a recall or concurrent processor.
      const claimed = await cols.marches.findOneAndDelete({ _id: m._id, status: 'marching' });
      if (!claimed) continue;
      await this.core.unscheduleMarch(claimed.worldId, claimed._id);
      await this.applyArrival(claimed, t);
      n++;
    }
    return n;
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

    if (m.kind === 'scout') {
      await this.autoReturnScout(m, t);
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
      // Reinforcement target is no longer own territory (captured / abandoned) → refund troops.
      await refundTroops(this.core, pw, m.troops, t);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      return;
    }
    await cols.tiles.updateOne({ _id: m.toTile }, { $inc: { garrison: m.troops, rev: 1 } });
    void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
    const after = await cols.tiles.findOne({ _id: m.toTile });
    if (after) void this.core.pushTile(m.ownerId, after);
  }

  /**
   * Scout march arrives at the target: no fighting or occupation; automatically flip to a return leg (same troops take the same route back to the origin tile, providing vision along the way);
   * on return arrival, troops are refunded to the troop pool. Return travel time = outbound travel time (symmetric approximation; avoids recomputing the path).
   */
  private async autoReturnScout(m: MarchDoc, t: number): Promise<void> {
    const { cols } = this.core.deps;
    const back: MarchDoc = {
      _id: marchId(m.worldId, m.ownerId, t, ++this.core.marchSeq),
      worldId: m.worldId,
      ownerId: m.ownerId,
      fromTile: m.toTile,
      toTile: m.fromTile,
      kind: 'return',
      troops: m.troops,
      departAt: t,
      arriveAt: t + Math.max(0, m.arriveAt - m.departAt),
      status: 'marching',
      rev: 0,
    };
    await cols.marches.insertOne(back);
    await this.core.scheduleMarch(m.worldId, back._id, back.arriveAt);
    void this.core.pushMarch(m.ownerId, this.core.marchView(back));
  }
}
