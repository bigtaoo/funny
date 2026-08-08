// worldsvc march domain: the player-issued commands — start a march, recall one mid-flight,
// pay to return one instantly, and list the caller's own marches (S8-2).
import { proceduralTile, tileId, marchId, playerWorldId, marchDurationFromPath, marchStepArriveAt, marchMoraleFromPath, OCCUPY_MIN_TROOPS, MARCH_MIN_TROOPS, isInVision, marchInterpPos, satchelCarryCapFor, SlgError, MARCH_RETURN_SPEEDUP_SECS_PER_COIN, type MarchKind } from '@nw/shared';
import type { MarchDoc, ArmyEntry, StationedDoc } from '../db';
import { MARCHABLE_KINDS } from '../core';
import type { MarchView, PlayerWorldView } from '../worldTypes';
import { refundTroops, computeMarchPath } from '../combatShared';
import { legBox, sourcesBoundingBox } from '../core/helpers';
import { resolveLeaderUnitType } from '../leaderUnit';
import type { Constructor, MarchServiceBaseCtor } from './base';

export interface CommandHandlers {
  startMarch( worldId: string, accountId: string, fromX: number, fromY: number, toX: number, toY: number, kind: MarchKind, troops: number, teamId?: string, stationMode?: 'idle' | 'garrison', ): Promise<MarchView>;
  recallMarch(worldId: string, accountId: string, mid: string): Promise<MarchView>;
  instantReturnMarch(worldId: string, accountId: string, mid: string, clientPlatform?: string): Promise<PlayerWorldView>;
  getMarches(worldId: string, accountId: string): Promise<MarchView[]>;
}

export function CommandMixin<TBase extends MarchServiceBaseCtor>(Base: TBase): TBase & Constructor<CommandHandlers> {
  return class extends Base {
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
      // ADR-051 (P3c, scope extended 2026-08-08 to include attack): re-dispatch of an *idle* (停留) field team —
      // commanded again straight from where it stands (attack/move/occupy), without recalling home first. Set
      // inside the team block below; drives the origin override, the from-tile ownership skip, the
      // pool-deduction skip, and the atomic StationedDoc claim before insert.
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
        // ADR-051 (P3c): a 停留 idle field team is NOT busy — it can be re-commanded straight from where it stands,
        // for any of attack/occupy/move (2026-08-08: attack added — user wanted parity with occupy, a
        // forward-stationed team should be usable to launch a fresh siege without a round trip home first).
        // A 驻扎 garrison stays locked (must recall first), as do marching/holding teams.
        idleRedispatch = !!busyStationed && busyStationed.mode !== 'garrison' && (kind === 'occupy' || kind === 'move' || kind === 'attack');
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
            const isFriendly = isGarrison && (await this.core.friendlyAccountIds(worldId, accountId)).has(toTile.ownerId);
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
      // `resources` was computed above from the `pw` snapshot read at the top of this function, and several
      // awaits have run since (computeMarchPath's Mongo scans, the idle-redispatch claim). Both branches below
      // guard the write on `rev: pw.rev` (2026-08-04 fix, closing the same stale-read-then-blind-`$set` lost-update
      // class that combatShared.ts's refundTroops and combatSiege/helpers.ts's transferLoot were already guarded
      // against): without it, a concurrent settlement for this same account (e.g. this march's own eventual
      // return-leg refund, or another siege/occupation landing at the same tick) that bumped rev in between would
      // have its already-applied resources delta silently overwritten by this call's stale-computed value.
      if (hasCardArmy || idleRedispatch) {
        const settled = await cols.playerWorld.updateOne(
          { _id: pw._id, rev: pw.rev },
          { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
        );
        if (settled.matchedCount === 0) {
          await cols.marches.deleteOne({ _id: mid });
          throw new SlgError('REV_CONFLICT', 'Concurrent update, please retry');
        }
      } else {
        const deducted = await cols.playerWorld.updateOne(
          { _id: pw._id, troops: { $gte: troops }, rev: pw.rev },
          { $set: { resources, lastTickAt: t }, $inc: { troops: -troops, rev: 1 } },
        );
        if (deducted.matchedCount === 0) {
          // Lost the race the fast-fail check above couldn't catch: roll back the march just inserted so the
          // account isn't left with a phantom in-flight march that drained no pool troops. Disambiguate the
          // two possible causes (the combined filter can't tell them apart) with one fresh read: genuinely
          // insufficient troops vs. a stale rev (some other concurrent mutation landed in between).
          await cols.marches.deleteOne({ _id: mid });
          const fresh = await cols.playerWorld.findOne({ _id: pw._id });
          if (fresh && fresh.troops < troops) throw new SlgError('NO_TROOPS', 'Insufficient troops');
          throw new SlgError('REV_CONFLICT', 'Concurrent update, please retry');
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
        // A card-army team's committed strength lives entirely in cardState.currentTroops and never
        // touched playerWorld.troops on departure (see hasCardArmy in startMarch) — claimed.troops here
        // degenerates to "card count" for such a march (§CC-3), so crediting it to the pool would be a
        // free-troops dupe. Every other refund site in this module (applySiege/applyOccupy/encounter/
        // applyMove) checks this first; this one previously didn't.
        const claimedHasCardArmy = !!claimed.army?.some((e) => !!e.cardInstanceId);
        if (!claimedHasCardArmy) {
          const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
          if (pw) await refundTroops(this.core, pw, claimed.troops, t);
        }
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
  };
}
