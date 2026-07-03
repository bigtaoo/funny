// worldsvc combat domain: marches (S8-2) + siege/sweep settlement (S8-3) + defense config (S8-4) + replay (G3-2c).
// Peeled out of the WorldService god-class (2026-07-03). Depends on WorldCore for shared state,
// vision, spawn, push/schedule infra, settle/yield, and nations (applyNationChange). No behavior change.
import {
  proceduralTile,
  tileId,
  marchId,
  siegeId,
  playerWorldId,
  tileYield,
  resolveSiege,
  siegeSeedFromId,
  buildSiegeBattle,
  npcGarrison,
  strongholdGarrison,
  STRONGHOLD_LOOT_PER_LEVEL,
  strongholdMaterialLoot,
  findMarchPath,
  baseFootprintCells,
  baseFootprintInBounds,
  marchDurationFromPath,
  capitalPositions,
  capitalIdxAt,
  nearestCapitalIdx,
  SIEGE_LOOT_RATE,
  SWEEP_LOOT_PER_LEVEL,
  RESOURCE_CAP,
  RESOURCE_TYPES,
  TROOP_CAP_BASE,
  GARRISON_PER_TILE,
  OCCUPY_MIN_TROOPS,
  MARCH_MIN_TROOPS,
  PROTECTION_SEC,
  troopCapFor,
  NATION_BONUS_PRODUCTION,
  NATION_BONUS_DEFENSE,
  nationDefenseStrength,
  wallDefenseMult,
  cabinetLootProtect,
  academyBuff,
  VISION_TERRITORY_RADIUS,
  VISION_BASE_RADIUS,
  VISION_MARCH_RADIUS,
  VISION_SCOUT_RADIUS,
  VISION_WATCHTOWER_RADIUS,
  VISION_MAX_RADIUS,
  isInVision,
  marchInterpPos,
  type VisionSource,
  SIEGE_TEAM_CAP,
  teamSiegeValue,
  type CardInstance,
  waveSeed,
  buildingMaxHp,
  SLG_SIEGE_DAMAGE_DELAY_MS,
  SLG_TEAM_INJURY_MS,
  SECT_LEADER_PENALTY_RATE,
  settleTier,
  CENTER_CAPITAL_IDX,
  CENTER_CAPITAL_MULT,
  SlgError,
  type PathCell,
  type TileType,
  type ResourceType,
  type MarchKind,
  type SiegeOutcome,
  type SiegeResolution,
  type ProceduralTile,
} from '@nw/shared';
import { runSiegeBattle, synthesizeArmy, validateAttackerArmy, validateDefenseConfig, scaleArmyHp, scaleArmyByRatio, sumArmyHp, toDefenderFormation, resolveCardArmy, toEngineCardInstances, computeCardStateUpdates } from './siegeEngine';
import type { GarrisonEntry, EngineEquipmentInput, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { ENGINE_VERSION } from '@nw/engine';
import { refreshFamilyProsperity } from './prosperity';
import type { TileDoc, PlayerWorldDoc, MarchDoc, SiegeDoc, SiegeDamageDoc, NationDoc, DefenseConfig, ArmyEntry, TeamTemplate, CardSLGState } from './db';
import type { PlayerProfile } from './metaClient';
import { WorldCore, lootSummary, emptyResources, MARCHABLE_KINDS } from './core';
import type { SiegeReplayInputs, WorldTileView, MarchView } from './worldTypes';

export class CombatService {
  constructor(private readonly core: WorldCore) {}

  /**
   * A* pathfinding for marches: pre-fetch all occupied gate tiles, assemble passableGateKeys, then call findMarchPath.
   * Gate passage rules (S8-4): gates occupied by the requester and gates occupied by members of the same family are passable
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
    // Retrieve the requester's current family (if any); gates occupied by fellow family members are also passable.
    const requesterPw = await this.core.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, requesterId) });
    const allyFamilyId = requesterPw?.familyId;

    // Gates are sparse (~20–40 across the whole map); fetch all at once and filter, to avoid async calls inside A*.
    const gateTiles = await this.core.deps.cols.tiles
      .find({ worldId, type: 'gate' })
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
    // ADR-025: other players' 3×3 capitals are solid buildings that block pathing (封路); the marcher
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

  /** Viewport tiles: merges procedural defaults (neutral world) with sparse DB overrides (occupied/modified tiles). §14.2. */
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
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    if (!this.core.inBounds(fromX, fromY) || !this.core.inBounds(toX, toY)) {
      throw new SlgError('OUT_OF_RANGE', 'Coordinates out of bounds');
    }
    // Siege with a team (G3-2c): draw the army from the saved attack formation template; committed troops = sum of troops assigned to each unit.
    // The team can be edited after departure without affecting the in-transit march (the army snapshot is persisted with MarchDoc). Not attack or no team → use flat troops.
    let army: ArmyEntry[] | undefined;
    if (kind === 'attack' && teamId) {
      const team = (pw.teams ?? []).find((t) => t.id === teamId);
      if (!team || team.army.length === 0) throw new SlgError('BAD_REQUEST', 'Team does not exist or is empty');
      army = team.army;
      troops = team.army.reduce((s, e) => s + Math.max(1, Math.floor(e.initialHp ?? 0)), 0);
    }
    if (!Number.isFinite(troops) || troops < MARCH_MIN_TROOPS) {
      throw new SlgError('NO_TROOPS', 'Invalid march troop count');
    }
    troops = Math.floor(troops);
    if (kind === 'occupy' && troops < OCCUPY_MIN_TROOPS) {
      throw new SlgError('NO_TROOPS', `Occupation requires at least ${OCCUPY_MIN_TROOPS} troops`);
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
      if (toTile?.ownerId === accountId) throw new SlgError('TILE_OCCUPIED', 'This tile is already your territory (use reinforce)');
      if (toTile?.ownerId) {
        if (toTile.protectedUntil && toTile.protectedUntil > now()) {
          throw new SlgError('PROTECTED', 'Target tile is under protection');
        }
        throw new SlgError('TILE_OCCUPIED', 'This tile is already occupied (use attack siege to take it)');
      }
    } else if (kind === 'reinforce') {
      if (!toTile || toTile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Can only reinforce your own tile');
    } else if (kind === 'attack') {
      // Siege: target must be another player's territory/capital, or an ownerless stronghold (G8 PvE to defeat the system garrison). Use occupy/sweep for neutral ownerless tiles.
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'World center is contested by sects and cannot be sieged');
      if (!toTile?.ownerId) {
        // No owner: only strongholds can be sieged (defeating the ultra-strong system NPC); all other ownerless tiles use occupy/sweep.
        if (proc.type !== 'stronghold') throw new SlgError('TILE_NOT_OWNED', 'Siege target has no owner (use occupy/sweep)');
        // Stronghold PvE: leave defenderId unset (NPC does not receive an under_attack warning).
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
      if (troops < OCCUPY_MIN_TROOPS) throw new SlgError('NO_TROOPS', `Siege requires at least ${OCCUPY_MIN_TROOPS} troops`);
    } else if (kind === 'scout') {
      // Scout: no fighting or occupation; send a small force to any non-obstacle tile (including enemy/protected/neutral/center) to reveal vision, then auto-return.
      // No ownership/center/protection-period restriction — blocking obstacle terrain above is sufficient. No defenderId (no under_attack warning).
    } else {
      // sweep: clear NPC garrison from neutral / resource tiles (no occupation; loot is carried back on return).
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot sweep the world center');
      // Stronghold (G8): ultra-strong system garrison; cannot be swept for loot — must be captured via attack siege.
      if (proc.type === 'stronghold') throw new SlgError('TILE_OCCUPIED', 'Strongholds must be captured via attack siege; sweeping is not allowed');
      if (toTile?.ownerId) throw new SlgError('TILE_OCCUPIED', 'Target is already occupied (use attack siege to take it)');
    }

    const t = now();
    const resources = this.core.settle(pw, t);
    if (pw.troops < troops) throw new SlgError('NO_TROOPS', 'Insufficient troops');

    const path = await this.computeMarchPath(worldId, fromX, fromY, toX, toY, accountId);
    const departAt = t;
    const arriveAt = departAt + marchDurationFromPath(path) * 1000;
    const mid = marchId(worldId, accountId, departAt, ++this.core.marchSeq);
    const doc: MarchDoc = {
      _id: mid,
      worldId,
      ownerId: accountId,
      fromTile: fromTid,
      toTile: toTid,
      kind,
      troops,
      ...(army && army.length > 0 ? { army } : {}),
      // ADR-026: record the deployed team slot so it is skipped as a defender while out (only meaningful for team-based attacks).
      ...(kind === 'attack' && teamId ? { teamId } : {}),
      departAt,
      arriveAt,
      status: 'marching',
      rev: 0,
    };
    await cols.marches.insertOne(doc);
    // Deduct troops on departure (in-transit; not in the pool).
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, lastTickAt: t }, $inc: { troops: -troops, rev: 1 } },
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

  /**
   * ADR-026: settle due delayed building-HP hits (scheduler, every tick; mirrors processDueArrivals). Each SiegeDamageDoc whose
   * dueAt has passed deducts its attacking team's siege value from the target building's HP; at HP≤0 the building is captured
   * (main base → passiveRelocate; other buildings → hand over). Atomic claim-and-delete makes it single-consumer safe.
   */
  async processDueSiegeDamage(nowMs?: number): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();
    const due = await cols.siegeDamage.find({ dueAt: { $lte: t } }).limit(500).toArray();
    let n = 0;
    for (const d of due) {
      const claimed = await cols.siegeDamage.findOneAndDelete({ _id: d._id });
      if (!claimed) continue; // lost to a concurrent processor
      await this.core.unscheduleSiegeDamage(claimed.worldId, claimed._id);
      try {
        await this.settleSiegeDamage(claimed, t);
      } catch (e) {
        console.error('[worldsvc] settleSiegeDamage failed:', { id: claimed._id, err: (e as Error).message });
      }
      n++;
    }
    return n;
  }

  /**
   * Apply one delayed building-HP hit (ADR-026 §4/§6). Deducts damage from the target building's HP (anchor for a base);
   * HP survives → persist reduced HP + refund attacker survivors; HP≤0 → capture (loot + main-base passiveRelocate, or
   * hand over a non-base building). If the target is no longer the same owner / is protected / gone, the hit is voided and
   * attacker survivors are refunded.
   */
  private async settleSiegeDamage(d: SiegeDamageDoc, t: number): Promise<void> {
    const { cols } = this.core.deps;
    const defenderId = d.defenderId;
    const tile = await cols.tiles.findOne({ _id: d.tile });
    const attacker = await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, d.attackerId) });

    // Target must still be the same owner and unprotected; otherwise the siege is stale → void damage, return besiegers.
    const stale = !tile || !defenderId || tile.ownerId !== defenderId || (tile.protectedUntil != null && tile.protectedUntil > t);
    if (stale) {
      if (attacker && d.attackerSurvivors > 0) await this.refundTroops(attacker, d.attackerSurvivors, t);
      return;
    }

    const maxHp = buildingMaxHp(tile.level ?? 1);
    const curHp = tile.hp ?? maxHp;
    const newHp = curHp - Math.max(0, Math.floor(d.damage));

    if (newHp > 0) {
      // Building survives: reduce HP; besiegers return to the pool.
      await cols.tiles.updateOne({ _id: d.tile }, { $set: { hp: newHp }, $inc: { rev: 1 } });
      if (attacker && d.attackerSurvivors > 0) await this.refundTroops(attacker, d.attackerSurvivors, t);
      const after = await cols.tiles.findOne({ _id: d.tile });
      if (after) { void this.core.pushTile(d.attackerId, after); void this.core.pushTile(defenderId, after); }
      return;
    }

    // HP depleted → capture. Loot first (settles both sides' resources).
    const defender = await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, defenderId) });
    if (attacker && defender) await this.transferLoot(defender, attacker, t);

    if (d.isBase) {
      // Main base captured: it cannot be permanently held → besiegers return; sect-leader penalty; passive relocation
      // (all territory lost + shield + a fresh full-HP base at a random tile).
      if (attacker && d.attackerSurvivors > 0) await this.refundTroops(attacker, d.attackerSurvivors, t);
      await this.applySectLeaderPenalty(d.worldId, defenderId, t);
      await this.passiveRelocate(d.worldId, defenderId, t);
    } else {
      // Non-base building handed over: survivors become the new garrison; HP resets to full for the new owner.
      await cols.tiles.updateOne(
        { _id: d.tile },
        {
          $set: { type: 'territory', ownerId: d.attackerId, garrison: d.attackerSurvivors, hp: maxHp },
          $unset: { protectedUntil: '' },
          $inc: { rev: 1 },
        },
      );
      const atkYield = await this.core.recomputeYield(d.worldId, d.attackerId);
      if (attacker) await cols.playerWorld.updateOne({ _id: attacker._id }, { $set: { yieldRate: atkYield, lastTickAt: t }, $inc: { rev: 1 } });
      const defYield = await this.core.recomputeYield(d.worldId, defenderId);
      await cols.playerWorld.updateOne({ _id: playerWorldId(d.worldId, defenderId) }, { $set: { yieldRate: defYield }, $inc: { rev: 1 } });
      void this.core.applyNationChange(d.worldId, tile.x, tile.y, d.attackerId, attacker?.familyId);
    }

    const after = await cols.tiles.findOne({ _id: d.tile });
    if (after) { void this.core.pushTile(d.attackerId, after); void this.core.pushTile(defenderId, after); }
  }
  /** Apply the effects of a single arrived march (already removed from marches collection). */
  private async applyArrival(m: MarchDoc, t: number): Promise<void> {
    const { cols } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, m.ownerId) });
    if (!pw) return; // player state missing (should not happen); troops are lost with it; exit safely.

    if (m.kind === 'return') {
      await this.refundTroops(pw, m.troops, t);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      return;
    }

    if (m.kind === 'attack') {
      await this.applySiege(m, pw, t);
      return;
    }

    if (m.kind === 'sweep') {
      await this.applySweep(m, pw, t);
      return;
    }

    if (m.kind === 'scout') {
      await this.autoReturnScout(m, t);
      return;
    }

    if (m.kind === 'occupy') {
      const proc = proceduralTile(m.worldId, this.core.coordX(m.toTile), this.core.coordY(m.toTile));
      const occ = await cols.tiles.findOne({ _id: m.toTile });
      const blocked =
        proc.type === 'center' ||
        (occ?.ownerId && occ.ownerId !== m.ownerId) ||
        (occ?.ownerId === m.ownerId && occ.type !== 'base'); // already own territory (base is the exception, but the march would never reach here for base)
      if (blocked) {
        // Target is occupied or non-occupiable on arrival → troops refunded to the pool immediately (S8-3 could instead use a return march).
        await this.refundTroops(pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
        return;
      }
      const x = this.core.coordX(m.toTile);
      const y = this.core.coordY(m.toTile);
      const tileDoc: TileDoc = {
        _id: m.toTile,
        worldId: m.worldId,
        x,
        y,
        type: 'territory',
        level: proc.level,
        ...(proc.resType ? { resType: proc.resType } : {}),
        ownerId: m.ownerId,
        garrison: m.troops,
        rev: 0,
      };
      await cols.tiles.updateOne({ _id: m.toTile }, { $set: tileDoc }, { upsert: true });
      // Troops were already deducted on departure → do not modify the pool again; only update the yield rate.
      const resources = this.core.settle(pw, t);
      const yieldRate = await this.core.recomputeYield(m.worldId, m.ownerId);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, yieldRate, lastTickAt: t }, $inc: { rev: 1 } },
      );
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
      void this.core.pushTile(m.ownerId, tileDoc);
      await this.core.pushTileToObservers(tileDoc, new Set([m.ownerId])); // G5-2: occupation arrival is visible to observers
      // Capital tile occupied → trigger nation founding (S8-6.5)
      void this.core.applyNationChange(m.worldId, x, y, m.ownerId, pw.familyId);
      // §17.4 activity increment: occupying new territory → occupier's family +1 (including prosperity refresh).
      void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      return;
    }

    // reinforce
    const target = await cols.tiles.findOne({ _id: m.toTile });
    if (!target || target.ownerId !== m.ownerId) {
      // Reinforcement target is no longer own territory (captured / abandoned) → refund troops.
      await this.refundTroops(pw, m.troops, t);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      return;
    }
    await cols.tiles.updateOne({ _id: m.toTile }, { $inc: { garrison: m.troops, rev: 1 } });
    void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
    const after = await cols.tiles.findOne({ _id: m.toTile });
    if (after) void this.core.pushTile(m.ownerId, after);
  }

  // ── S8-3: siege / sweep arrival settlement (cheap formula, §5.3; decisive battles use engine re-computation in S8-3b via judge) ──

  /**
   * Siege another player's territory/capital (attack arrival). On arrival, re-validate that the target is still enemy-owned and unprotected; otherwise refund troops.
   * Cheap linear settlement resolveSiege(attacker troops, garrison):
   *   - attacker_win + territory → tile changes hands (survivors become the new garrison) + loot defeated player's resources + both sides recompute yield;
   *   - attacker_win + base      → capital cannot be permanently taken: garrison wiped + defeated player gets a protection shield + loot taken + attacker survivors return to troop pool;
   *   - defender_win             → all attacker committed troops destroyed (already deducted on departure, not refunded) + defender garrison takes casualties.
   */
  private async applySiege(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
    const { cols } = this.core.deps;
    const target = await cols.tiles.findOne({ _id: m.toTile });
    // Stronghold PvE capture (G8 §3.1): target has no owner and procedural type is stronghold → fight the ultra-strong system NPC garrison;
    // victory captures it as territory + grants a one-time rich reward; defeat causes surviving attackers to retreat and return. Intercept before the "miss and refund" branch.
    if (!target?.ownerId) {
      const proc = proceduralTile(m.worldId, this.core.coordX(m.toTile), this.core.coordY(m.toTile));
      if (proc.type === 'stronghold') {
        await this.applyStrongholdSiege(m, pw, t, proc);
        return;
      }
    }
    // On arrival, target is no longer enemy-owned (abandoned / transferred to own / ownerless) or is now protected → treat as a miss; refund and return troops.
    if (
      !target?.ownerId ||
      target.ownerId === m.ownerId ||
      (target.protectedUntil && target.protectedUntil > t)
    ) {
      await this.refundTroops(pw, m.troops, t);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      return;
    }

    const defenderId = target.ownerId;
    // ADR-025 unified defense: attacking ANY of the 9 base cells besieges the whole base. If the attacker
    // landed on a ring cell, resolve garrison + defense config against the ANCHOR (which holds them); the
    // attacker still marched to m.toTile. Falls back to target if the anchor is somehow missing.
    const baseTile = target.baseRing
      ? ((await cols.tiles.findOne({ _id: target.baseAnchor })) ?? target)
      : target;
    // Nation defense bonus (§2.4 / G1): if the garrison tile is within the Voronoi region of a capital the defender occupies → effective garrison strength is increased.
    const capIdx = nearestCapitalIdx(baseTile.x, baseTile.y, this.core.capitals);
    const nation = await cols.nations.findOne({ _id: `nation:${m.worldId}:${capIdx}` });
    const inOwnNation = !!nation?.ownerId && nation.ownerId === defenderId;
    const effGarrison = nationDefenseStrength(baseTile.garrison ?? 0, inOwnNation);

    // E8/CC-3: fetch attacker's progression snapshot early (needed for card army resolution + blueprint injection).
    const attackerSave = await this.core.meta.getSaveFields(m.ownerId).catch(() => null);

    // Attacker formation (G3-2c): marched with a team → use the real formation snapshot (m.army); otherwise synthesize from flat troop count as fallback (v1 bridge).
    // CC-3: when army entries carry cardInstanceId, resolve to engine GarrisonEntry[] via cardState.currentTroops + CARD_DEFS.unitType.
    const rawArmy = m.army ?? [];
    const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);
    const attackerArmy: GarrisonEntry[] =
      hasCardArmy
        ? resolveCardArmy(rawArmy, pw.cardState ?? {}, attackerSave?.cardInv ?? {})
        : (rawArmy.length > 0 ? (rawArmy as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker'));
    // CC-3: extract EngineCardInstance[] from the attacker's card army for blueprint injection (level + gear); shared by both paths.
    let cardInstances: EngineCardInstance[] | undefined;
    let cardEquipInv: EngineEquipInv | undefined;
    if (hasCardArmy && attackerSave) {
      const { cardInstances: ci, engEquipInv } = toEngineCardInstances(rawArmy, attackerSave.cardInv, attackerSave.equipmentInv);
      cardInstances = ci;
      cardEquipInv = engEquipInv;
    }
    // P2 academy: attacker's academy building gives a seasonal blueprint HP/damage/siege buff (both paths).
    const atkAcademy = academyBuff(pw.buildings);
    const siegeAcademy = (atkAcademy.hp > 0 || atkAcademy.damage > 0 || atkAcademy.siege > 0) ? atkAcademy : undefined;

    // Fetch defender world state before the battle (wave teams, wall/academy buffs, cabinet loot protection).
    const defender = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, defenderId) });

    // C7/§17.9: mid-season engine drift detection (non-blocking; warning only — replays may drift frame by frame; ops treatment in §17.9).
    const wv = await cols.worlds.findOne({ _id: m.worldId }, { projection: { engineVersion: 1 } });
    if (wv?.engineVersion != null && wv.engineVersion !== ENGINE_VERSION) {
      console.warn('[worldsvc] siege engineVersion drift (engine upgraded mid-season without reopening the shard)', {
        worldId: m.worldId, pinned: wv.engineVersion, runtime: ENGINE_VERSION,
      });
    }

    // ADR-026: a main base uses the wave-defender + building-HP + delayed-siege-value model. Attacking any of the 9
    // footprint cells lands here with target.type==='base' (anchor resolution already done above); territory tiles keep
    // the pre-ADR-026 single-battle instant path below.
    if (target.type === 'base') {
      await this.applyBaseSiege(
        m, pw, baseTile, defenderId, defender, inOwnNation,
        attackerArmy, cardInstances, cardEquipInv, siegeAcademy, attackerSave?.cardInv ?? {}, t,
      );
      return;
    }

    // ── Territory tile (non-base): single deterministic battle + immediate settlement (unchanged, §16) ──
    const defenderConfig = this.buildDefenderConfig(baseTile, effGarrison, inOwnNation);
    const tileLevel = baseTile.level ?? 1;
    const seed = siegeSeedFromId(m._id);

    // Bad formation / engine error → fall back to cheap resolveSiege; a single siege must never stall a march.
    let res: SiegeResolution;
    let replay: SiegeReplayInputs | null = { seed, attackerArmy, defenderConfig, tileLevel };
    try {
      res = runSiegeBattle({ attackerArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv, siegeAcademy });
    } catch (err) {
      console.error('[worldsvc] siege engine failed — fallback to cheap resolve', { tile: m.toTile, err: (err as Error).message });
      res = resolveSiege(m.troops, effGarrison);
      replay = null; // cheap fallback result is inconsistent with engine replay → do not store replay inputs (replay button degrades to hidden).
    }
    // Replay inputs: persisted to SiegeDoc; the client uses seed + both sides' formations to replay the battle locally for spectating (§16.3).
    await this.landSiege(m, pw, target, defenderId, defender, res, t, replay);
  }

  /**
   * ADR-026 main-base siege: in-base, non-injured defender teams (t1..t5) fight the attacker in waves; the attacker's
   * surviving troops carry over between waves. Clearing all defenders (or none present) is a garrison win → schedule a
   * delayed building-HP hit (SiegeDamageDoc, +SLG_SIEGE_DAMAGE_DELAY_MS) equal to the attacking team's siege value.
   * Each defeated defender team is injured for SLG_TEAM_INJURY_MS (never defends until healed). An attacker wiped
   * mid-waves fails the siege (no HP damage) and retreats immediately. The real building HP (TileDoc.hp on the anchor)
   * is only reduced later by processDueSiegeDamage → capture (passiveRelocate) at HP≤0.
   */
  private async applyBaseSiege(
    m: MarchDoc,
    pw: PlayerWorldDoc,
    baseTile: TileDoc,
    defenderId: string,
    defender: PlayerWorldDoc | null,
    inOwnNation: boolean,
    attackerArmy: GarrisonEntry[],
    cardInstances: EngineCardInstance[] | undefined,
    cardEquipInv: EngineEquipInv | undefined,
    siegeAcademy: { hp: number; damage: number; siege: number } | undefined,
    attackerCardInv: Record<string, CardInstance>,
    t: number,
  ): Promise<void> {
    const { cols } = this.core.deps;
    const tileLevel = baseTile.level ?? 1;
    const wallMult = wallDefenseMult(defender?.buildings);

    // Teams currently out on active (non-recalled) marches are skipped as defenders (ADR-026 §2).
    const activeMarches = await cols.marches
      .find({ worldId: m.worldId, ownerId: defenderId, status: { $ne: 'recalled' }, teamId: { $exists: true } })
      .toArray();
    const outTeams = new Set(activeMarches.map((x) => x.teamId).filter((id): id is string => !!id));

    // Defender card inventory (resolve team card armies → unit type + troop count). v1: defender cards use base blueprints on defence (no per-card level/gear buff; follow-up).
    const defenderSave = await this.core.meta.getSaveFields(defenderId).catch(() => null);
    const defCardInv = defenderSave?.cardInv ?? {};
    const defCardState = defender?.cardState ?? {};
    const teamState = defender?.teamState ?? {};

    // In-base, non-injured teams in t1..t5 order.
    const defenders = (defender?.teams ?? [])
      .filter((tm) => tm.army.length > 0 && !outTeams.has(tm.id))
      .filter((tm) => !((teamState[tm.id]?.injuredUntil ?? 0) > t))
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));

    // Wave battle: attacker survivors carry over between waves (scaled by survival ratio).
    let survivorArmy: GarrisonEntry[] = attackerArmy.map((e) => ({ ...e }));
    let attackerSurvivors = sumArmyHp(survivorArmy);
    const defeatedTeamIds: string[] = [];
    const replays: SiegeReplayInputs[] = [];
    let cleared = true;

    for (let i = 0; i < defenders.length; i++) {
      const tm = defenders[i]!;
      if (survivorArmy.length === 0 || attackerSurvivors <= 0) { cleared = false; break; }
      // Re-place the attack-authored team onto defender spawn positions (top half) so the auto-battle isn't degenerate.
      let defArmy = toDefenderFormation(resolveCardArmy(tm.army, defCardState, defCardInv));
      if (inOwnNation) defArmy = scaleArmyHp(defArmy, 1 + NATION_BONUS_DEFENSE); // §2.4 nation defence bonus
      if (wallMult > 1) defArmy = scaleArmyHp(defArmy, wallMult);               // P2 wall HP buff
      if (defArmy.length === 0) { defeatedTeamIds.push(tm.id); continue; }      // empty/stale team → already cleared (still injured)
      // ADR-026: the per-wave engine "base" is only a battle terminator (the real building durability is TileDoc.hp,
      // reduced separately by the delayed siege-value hit). Pin it to the weakest level so each wave is decided by
      // team-vs-attacker, not by a symbolic base tanking the assault.
      const defenderConfig = { garrison: defArmy, defenderBaseLevel: 0 };
      const seed = waveSeed(m._id, i);
      const deployedHp = sumArmyHp(survivorArmy);
      let res: SiegeResolution;
      try {
        res = runSiegeBattle({ attackerArmy: survivorArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv, siegeAcademy });
      } catch (err) {
        console.error('[worldsvc] base wave siege engine failed — cheap fallback', { tile: baseTile._id, wave: i, err: (err as Error).message });
        res = resolveSiege(deployedHp, sumArmyHp(defArmy));
      }
      replays.push({ seed, attackerArmy: survivorArmy, defenderConfig, tileLevel });
      attackerSurvivors = res.attackerSurvivors;
      if (res.outcome === 'attacker_win') {
        defeatedTeamIds.push(tm.id);
        const ratio = deployedHp > 0 ? res.attackerSurvivors / deployedHp : 0;
        survivorArmy = scaleArmyByRatio(survivorArmy, ratio);
        if (survivorArmy.length === 0) { cleared = false; break; } // attacker spent — cleared some waves but cannot continue
      } else {
        cleared = false; // repelled by this wave
        break;
      }
    }

    // Persist defender team injuries (each defeated team locked for SLG_TEAM_INJURY_MS).
    if (defeatedTeamIds.length > 0 && defender) {
      const injSet: Record<string, unknown> = {};
      for (const id of defeatedTeamIds) injSet[`teamState.${id}.injuredUntil`] = t + SLG_TEAM_INJURY_MS;
      await cols.playerWorld.updateOne({ _id: playerWorldId(m.worldId, defenderId) }, { $set: injSet, $inc: { rev: 1 } });
    }

    const outcome: SiegeOutcome = cleared ? 'attacker_win' : 'defender_win';
    const replay = replays.length > 0 ? (replays[replays.length - 1] ?? null) : null;
    const siege = await this.recordSiege(m, defenderId, outcome, t, replay);

    // CC-3: attacker card post-battle state (uniform survival over the whole siege).
    const attackArmy = m.army ?? [];
    if (attackArmy.some((e) => !!e.cardInstanceId)) {
      const cardUpdates = computeCardStateUpdates(attackArmy, pw.cardState ?? {}, attackerSurvivors, t);
      const cardStateSet: Record<string, unknown> = {};
      for (const [id, update] of Object.entries(cardUpdates)) {
        cardStateSet[`cardState.${id}.currentTroops`] = update.currentTroops;
        cardStateSet[`cardState.${id}.injuredUntil`] = update.injuredUntil != null ? update.injuredUntil : null;
      }
      if (Object.keys(cardStateSet).length > 0) {
        await cols.playerWorld.updateOne({ _id: pw._id }, { $set: cardStateSet, $inc: { rev: 1 } });
      }
    }

    if (cleared) {
      // Garrison cleared (or no defenders present): schedule the delayed building-HP hit = attacking team's siege value
      // (sum of the team's per-card 攻城值; a real card team is always > 0). Attacker keeps besieging; survivors are refunded at settlement.
      const damage = teamSiegeValue(m.army ?? [], attackerCardInv);
      const dmg: SiegeDamageDoc = {
        _id: siege._id,
        worldId: m.worldId,
        attackerId: m.ownerId,
        defenderId,
        tile: baseTile._id,
        isBase: true,
        damage,
        attackerSurvivors,
        ...(pw.familyId ? { familyId: pw.familyId } : {}),
        dueAt: t + SLG_SIEGE_DAMAGE_DELAY_MS,
      };
      await cols.siegeDamage.updateOne({ _id: dmg._id }, { $setOnInsert: dmg }, { upsert: true });
      await this.core.scheduleSiegeDamage(m.worldId, dmg._id, dmg.dueAt);
    } else {
      // Attacker repelled: survivors retreat and return to the troop pool immediately.
      if (attackerSurvivors > 0) await this.refundTroops(pw, attackerSurvivors, t);
    }

    // Activity + battle-report push (loot only happens at capture, in settleSiegeDamage → empty here).
    void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
    void this.core.bumpFamilyActivity(m.worldId, defender?.familyId, 1);
    const lootStr = lootSummary(emptyResources());
    void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
    void this.core.pushSiege(m.ownerId, siege, lootStr);
    void this.core.pushSiege(defenderId, siege, lootStr);
  }

  /**
   * Stronghold PvE siege capture (G8 §3.1): an ownerless stronghold tile; the system derives an ultra-strong NPC garrison + high base from the tile level.
   * Uses the authoritative engine siege (bad formation / error → cheap fallback). Victory → write territory (survivors become garrison) + one-time rich resource reward + nation founding / activity refresh;
   * Defeat → surviving attackers retreat and return (NPC garrison is not persisted — procedural, not stored in DB; resets next time).
   * Defender is NPC throughout: no defenderId, no player loot, no protection shield.
   */
  private async applyStrongholdSiege(
    m: MarchDoc,
    pw: PlayerWorldDoc,
    t: number,
    proc: ProceduralTile,
  ): Promise<void> {
    const { cols } = this.core.deps;
    const x = this.core.coordX(m.toTile);
    const y = this.core.coordY(m.toTile);
    // Re-validate on arrival: already occupied by another player or self (including simultaneous captures) → skip NPC fight; refund troops as a miss.
    const occ = await cols.tiles.findOne({ _id: m.toTile });
    if (occ?.ownerId) {
      await this.refundTroops(pw, m.troops, t);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      return;
    }

    const garrison = strongholdGarrison(proc.level);
    const attackerArmy: GarrisonEntry[] =
      m.army && m.army.length > 0 ? (m.army as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker');
    // System ultra-strong default garrison + elevated base (defenderBaseLevel is derived and clamped by buildSiegeLevel from tileLevel).
    const defenderConfig = { garrison: synthesizeArmy(garrison, 'defender') };
    const tileLevel = proc.level;
    const seed = siegeSeedFromId(m._id);

    // E8: stronghold is also a PvE-like siege; attacker equipment applies in the same way.
    const attackerSave = await this.core.meta.getSaveFields(m.ownerId).catch(() => null);
    const siegeEquip: EngineEquipmentInput | undefined =
      attackerSave ? { gear: attackerSave.gear, inv: attackerSave.equipmentInv } : undefined;
    let res: SiegeResolution;
    let replay: SiegeReplayInputs | null = { seed, attackerArmy, defenderConfig, tileLevel };
    try {
      res = runSiegeBattle({
        attackerArmy, defenderConfig, tileLevel, seed,
        pveUpgrades: attackerSave?.pveUpgrades,
        unitLevels: attackerSave?.unitLevels,
        equipment: siegeEquip,
      });
    } catch (err) {
      console.error('[worldsvc] stronghold siege engine failed — fallback to cheap resolve', {
        tile: m.toTile,
        err: (err as Error).message,
      });
      res = resolveSiege(m.troops, garrison);
      replay = null;
    }

    if (res.outcome === 'attacker_win') {
      const tileDoc: TileDoc = {
        _id: m.toTile,
        worldId: m.worldId,
        x,
        y,
        type: 'territory',
        level: proc.level,
        ...(proc.resType ? { resType: proc.resType } : {}),
        ownerId: m.ownerId,
        garrison: res.attackerSurvivors,
        rev: 0,
      };
      await cols.tiles.updateOne({ _id: m.toTile }, { $set: tileDoc }, { upsert: true });
      // One-time capture reward (§3.1 "substantial resources"): add to the attacker's resource pool by tile level + resource type (capped).
      const rt: ResourceType = proc.resType ?? 'ink';
      const reward = emptyResources();
      reward[rt] = STRONGHOLD_LOOT_PER_LEVEL * Math.max(1, proc.level);
      const resources = this.core.settle(pw, t);
      for (const r of RESOURCE_TYPES) resources[r] = Math.min(RESOURCE_CAP, (resources[r] ?? 0) + reward[r]);
      const yieldRate = await this.core.recomputeYield(m.worldId, m.ownerId);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, yieldRate, lastTickAt: t }, $inc: { rev: 1 } },
      );
      // Extra progression material drop (§19.5 + G4 §15.6): sent to meta SaveData.materials unified pool (cross-process,
      // best-effort, orderId idempotent; march is settled once — (worldId, toTile, arriveAt) is stable as idempotent key).
      const matLoot = strongholdMaterialLoot(proc.level);
      void this.core.meta.grantMaterial(m.ownerId, matLoot.material, matLoot.qty, `stronghold_loot:${m.worldId}:${m.toTile}:${m.arriveAt}`);
      void this.core.applyNationChange(m.worldId, x, y, m.ownerId, pw.familyId);
      void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      const siege = await this.recordSiege(m, undefined, res.outcome, t, replay);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
      void this.core.pushSiege(m.ownerId, siege, `${lootSummary(reward)},${matLoot.material}+${matLoot.qty}`);
      void this.core.pushTile(m.ownerId, tileDoc);
      await this.core.pushTileToObservers(tileDoc, new Set([m.ownerId])); // G5-2: stronghold capture arrival is visible to observers
    } else {
      // Capture failed: surviving attacker troops retreat and return to the troop pool (troops were deducted on departure; casualties are a permanent loss). NPC garrison is not persisted; no casualty write.
      if (res.attackerSurvivors > 0) await this.refundTroops(pw, res.attackerSurvivors, t);
      void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      const siege = await this.recordSiege(m, undefined, res.outcome, t, replay);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
      void this.core.pushSiege(m.ownerId, siege, '');
    }
  }

  /**
   * Build the defender's formation for a siege (G3-2b): a custom formation (`tile.defense` contains a garrison array, written by the G3-2c editor) takes priority;
   * otherwise, synthesize a deterministic default formation from the effective garrison size (including nation bonus). Empty garrison (no custom + 0 troops) → null;
   * buildSiegeBattle derives a token base defense.
   *
   * Nation bonus (§2.4 / G1 item②, completed in G3-2c): when the garrison tile is within the defender's own capital Voronoi region (inOwnNation):
   * **synthesis path** already benefits by having extra units from effGarrison (troop count amplified by nationDefenseStrength);
   * **custom formation path** scales each unit's initialHp by (1+NATION_BONUS_DEFENSE) (scaleArmyHp, engine caps at full HP).
   */
  private buildDefenderConfig(
    target: TileDoc,
    effGarrison: number,
    inOwnNation: boolean,
  ): { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown } | null {
    const custom = target.defense as DefenseConfig | undefined;
    const customGarrison = custom && (custom as { garrison?: unknown }).garrison;
    if (Array.isArray(customGarrison) && customGarrison.length > 0) {
      const garrison = inOwnNation
        ? scaleArmyHp(customGarrison as GarrisonEntry[], 1 + NATION_BONUS_DEFENSE)
        : (customGarrison as GarrisonEntry[]);
      return { ...custom, garrison };
    }
    return effGarrison > 0 ? { garrison: synthesizeArmy(effGarrison, 'defender') } : null;
  }

  /**
   * Apply a single siege settlement result (G3-1 extraction, §16.4): write tile hand-off / loot / garrison / nation founding / passive relocation (attacker_win)
   * or defender garrison casualties (defender_win) according to res + record SiegeDoc + push march/siege/tile events.
   * Currently called immediately by `applySiege` (cheap settlement path unchanged); after G3-2 delayed settlement, both the judge re-computation confirmation and
   * the timeout fallback paths will share this single landing point.
   */
  private async landSiege(
    m: MarchDoc,
    pw: PlayerWorldDoc,
    target: TileDoc,
    defenderId: string,
    defender: PlayerWorldDoc | null,
    res: SiegeResolution,
    t: number,
    replay: SiegeReplayInputs | null,
  ): Promise<void> {
    const { cols } = this.core.deps;
    let loot = emptyResources();

    if (res.outcome === 'attacker_win') {
      // Loot the defeated player's resources (transfer a proportion from defender to attacker).
      if (defender) loot = await this.transferLoot(defender, pw, t);

      if (target.type === 'base') {
        // The capital cannot be permanently taken, but being defeated triggers passive relocation (§3.4/§8.2, applies to all players):
        //   1) attacker survivors return to the troop pool; 2) if the defender is a sect leader, all sect members lose 50% of resources (§8.2 major penalty);
        //   3) defender's capital is randomly relocated to a new empty tile + all currently occupied territory is lost (passiveRelocate).
        await this.refundTroops(pw, res.attackerSurvivors, t);
        await this.applySectLeaderPenalty(m.worldId, defenderId, t);
        await this.passiveRelocate(m.worldId, defenderId, t);
      } else {
        // Territory changes hands: survivors become the new garrison (troops were deducted on departure; do not modify the attacker pool again); both sides recompute yield.
        await cols.tiles.updateOne(
          { _id: m.toTile },
          {
            $set: { type: 'territory', ownerId: m.ownerId, garrison: res.attackerSurvivors },
            $unset: { protectedUntil: '' },
            $inc: { rev: 1 },
          },
        );
        const atkYield = await this.core.recomputeYield(m.worldId, m.ownerId);
        await cols.playerWorld.updateOne(
          { _id: pw._id },
          { $set: { yieldRate: atkYield, lastTickAt: t }, $inc: { rev: 1 } },
        );
        const defYield = await this.core.recomputeYield(m.worldId, defenderId);
        await cols.playerWorld.updateOne(
          { _id: playerWorldId(m.worldId, defenderId) },
          { $set: { yieldRate: defYield }, $inc: { rev: 1 } },
        );
        // Capital tile captured → nation changes hands (S8-6.5)
        void this.core.applyNationChange(m.worldId, target.x, target.y, m.ownerId, pw.familyId);
      }
    } else {
      // Defender wins: garrison reduced to survivors; attacker survivors retreat and return to the troop pool (§16.5 survivor refund; engine provides real survivors);
      // fallen troops are permanently lost. On the cheap fallback path where attackerSurvivors=0, there is naturally no return march; behavior is unchanged.
      await cols.tiles.updateOne(
        { _id: m.toTile },
        { $set: { garrison: res.defenderSurvivors }, $inc: { rev: 1 } },
      );
      if (res.attackerSurvivors > 0) await this.refundTroops(pw, res.attackerSurvivors, t);
    }

    const siege = await this.recordSiege(m, defenderId, res.outcome, t, replay);

    // CC-3: write post-battle cardState (currentTroops + injuredUntil) for attacker card army.
    const attackArmy = m.army ?? [];
    if (attackArmy.some((e) => !!e.cardInstanceId)) {
      const cardUpdates = computeCardStateUpdates(attackArmy, pw.cardState ?? {}, res.attackerSurvivors, t);
      const cardStateSet: Record<string, unknown> = {};
      for (const [id, update] of Object.entries(cardUpdates)) {
        cardStateSet[`cardState.${id}.currentTroops`] = update.currentTroops;
        if (update.injuredUntil != null) cardStateSet[`cardState.${id}.injuredUntil`] = update.injuredUntil;
        else cardStateSet[`cardState.${id}.injuredUntil`] = null; // clear stale injury
      }
      if (Object.keys(cardStateSet).length > 0) {
        await cols.playerWorld.updateOne({ _id: pw._id }, { $set: cardStateSet, $inc: { rev: 1 } });
      }
    }

    // §17.4 activity increment: siege (attacker / defender) → both sides' families +1 (landing point for decisive battles).
    void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
    void this.core.bumpFamilyActivity(m.worldId, defender?.familyId, 1);
    const lootStr = lootSummary(loot);
    void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
    void this.core.pushSiege(m.ownerId, siege, lootStr);
    void this.core.pushSiege(defenderId, siege, lootStr);
    const after = await cols.tiles.findOne({ _id: m.toTile });
    if (after) {
      void this.core.pushTile(m.ownerId, after);
      void this.core.pushTile(defenderId, after);
      await this.core.pushTileToObservers(after, new Set([m.ownerId, defenderId])); // G5-2: tile hand-off is visible to observers within vision
    }
  }

  /**
   * Sweep NPC garrison from a neutral / resource tile (sweep arrival). No occupation: on success, loot resources + surviving troops return to the pool;
   * on failure, attacker troop losses (survivors still return to the pool, possibly 0). If the tile is already player-occupied on arrival → refund troops (miss).
   */
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

  private async applySweep(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
    const { cols } = this.core.deps;
    const occ = await cols.tiles.findOne({ _id: m.toTile });
    if (occ?.ownerId) {
      // Already occupied (should use attack) → miss; refund troops.
      await this.refundTroops(pw, m.troops, t);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      return;
    }
    const proc = proceduralTile(m.worldId, this.core.coordX(m.toTile), this.core.coordY(m.toTile));
    const res = resolveSiege(m.troops, npcGarrison(proc.level));
    let loot = emptyResources();
    if (res.outcome === 'attacker_win') {
      const rt: ResourceType = proc.resType ?? 'ink';
      loot = emptyResources();
      loot[rt] = SWEEP_LOOT_PER_LEVEL * Math.max(1, proc.level);
    }
    // Surviving troops return (loot merged into attacker resources, capped).
    await this.refundTroops(pw, res.attackerSurvivors, t, loot);
    const siege = await this.recordSiege(m, undefined, res.outcome, t, null);
    void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
    void this.core.pushSiege(m.ownerId, siege, lootSummary(loot));
  }

  /**
   * Record a siege battle report (transient record, §14.3 sieges). When replay is non-null (decisive siege ran through the engine), persist seed + both sides'
   * formations + tile level for client-side replay spectating (getSiegeReplay); cheap fallback / NPC sweep → replay=null (no replay available).
   */
  private async recordSiege(
    m: MarchDoc,
    defenderId: string | undefined,
    outcome: SiegeOutcome,
    t: number,
    replay: SiegeReplayInputs | null,
  ): Promise<SiegeDoc> {
    const doc: SiegeDoc = {
      _id: siegeId(m.worldId, m.ownerId, t, ++this.core.siegeSeq),
      worldId: m.worldId,
      attackerId: m.ownerId,
      ...(defenderId ? { defenderId } : {}),
      tile: m.toTile,
      outcome,
      recomputed: false,
      ts: t,
      ...(replay
        ? {
            seed: replay.seed,
            attackerArmy: replay.attackerArmy as ArmyEntry[],
            defenderConfig: (replay.defenderConfig as DefenseConfig | null) ?? null,
            tileLevel: replay.tileLevel,
          }
        : {}),
    };
    await this.core.deps.cols.sieges.insertOne(doc);
    return doc;
  }

  /** Transfer SIEGE_LOOT_RATE proportion of resources from the defeated player to the attacker (both sides settle + cap). Returns the actual amount looted. */
  private async transferLoot(
    defender: PlayerWorldDoc,
    attacker: PlayerWorldDoc,
    t: number,
  ): Promise<Record<ResourceType, number>> {
    const defRes = this.core.settle(defender, t);
    const loot = emptyResources();
    // P2 cabinet: protects a fraction of the defender's resources from being looted.
    const protection = cabinetLootProtect(defender.buildings);
    const effectiveLootRate = SIEGE_LOOT_RATE * (1 - protection);
    for (const rt of RESOURCE_TYPES) loot[rt] = Math.floor((defRes[rt] ?? 0) * effectiveLootRate);
    const defAfter = emptyResources();
    for (const rt of RESOURCE_TYPES) defAfter[rt] = Math.max(0, (defRes[rt] ?? 0) - loot[rt]);
    await this.core.deps.cols.playerWorld.updateOne(
      { _id: defender._id },
      { $set: { resources: defAfter, lastTickAt: t }, $inc: { rev: 1 } },
    );
    // Attacker receives the loot (merged after settling own production, capped).
    const atkRes = this.core.settle(attacker, t);
    for (const rt of RESOURCE_TYPES) atkRes[rt] = Math.min(RESOURCE_CAP, (atkRes[rt] ?? 0) + loot[rt]);
    await this.core.deps.cols.playerWorld.updateOne(
      { _id: attacker._id },
      { $set: { resources: atkRes, lastTickAt: t }, $inc: { rev: 1 } },
    );
    // Sync the in-memory attacker copy so subsequent code within the same settlement sees consistent state without re-settling (attacker is not read again after this point).
    attacker.resources = atkRes;
    attacker.lastTickAt = t;
    return loot;
  }

  /** Refund troops to the pool (capped at troopCap) + settle resources; optionally merge loot into resources (capped at RESOURCE_CAP). */
  private async refundTroops(
    pw: PlayerWorldDoc,
    troops: number,
    t: number,
    loot?: Record<ResourceType, number>,
  ): Promise<void> {
    const resources = this.core.settle(pw, t);
    if (loot) {
      for (const rt of RESOURCE_TYPES) {
        resources[rt] = Math.min(RESOURCE_CAP, (resources[rt] ?? 0) + (loot[rt] ?? 0));
      }
    }
    const next = Math.min(pw.troopCap, pw.troops + troops);
    await this.core.deps.cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, troops: next, lastTickAt: t }, $inc: { rev: 1 } },
    );
  }

  /**
   * Sect leader capital-destruction penalty (§8.2): if defenderId is a sect leader, all sect members' current resources are multiplied by (1-RATE).
   * Each member is settled then reduced individually (large-scale write; U13 atomicity risk — single-process is acceptable for early stage; batch / transaction at scale).
   * Not a sect leader / no sect → no-op.
   */
  private async applySectLeaderPenalty(worldId: string, defenderId: string, t: number): Promise<void> {
    const { cols } = this.core.deps;
    const defPw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, defenderId) });
    if (!defPw?.familyId) return;
    const [fam] = await this.core.socialsvc.getFamiliesByIds([defPw.familyId]);
    if (!fam?.sectId) return;
    const sect = await cols.sects.findOne({ _id: fam.sectId });
    if (!sect || sect.leaderId !== defenderId) return; // only triggers when the sect leader's base is destroyed

    const memberFamilies = await this.core.socialsvc.getFamiliesBySect(sect._id);
    const famIds = memberFamilies.map((f) => f.familyId);
    if (famIds.length === 0) return;
    const members = await cols.playerWorld.find({ worldId, familyId: { $in: famIds } }).toArray();
    const keep = 1 - SECT_LEADER_PENALTY_RATE;
    for (const mm of members) {
      const resources = this.core.settle(mm, t);
      for (const rt of RESOURCE_TYPES) resources[rt] = Math.floor((resources[rt] ?? 0) * keep);
      await cols.playerWorld.updateOne(
        { _id: mm._id },
        { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
      );
    }
  }

  /**
   * Passive relocation (§3.4/§8.2): after the capital is destroyed, the defender's capital is randomly relocated to a new empty tile, and **all currently occupied territory is lost**.
   * Delete all of the player's own tiles (old capital + territory) → randomly pick a legal empty tile and write a new capital (with a protection shield) → update mainBaseTile +
   * recompute yield (only the new capital remains at this point). Garrison troops in lost territory are not refunded (losing territory means losing those troops — a severe penalty).
   */
  private async passiveRelocate(worldId: string, defenderId: string, t: number): Promise<void> {
    const { cols } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, defenderId) });
    if (!pw) return;

    // Lose territory: delete all of the player's own tiles (old capital + all territory); revert to procedural neutral.
    await cols.tiles.deleteMany({ worldId, ownerId: defenderId });

    // Place the new capital at a random legal empty tile. In the extreme case where none is found → skip relocation (territory already lost; player can still voluntarily relocate later).
    const spot = await this.core.pickRandomEmptyTile(worldId);
    if (!spot) {
      const yieldRate = await this.core.recomputeYield(worldId, defenderId);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { yieldRate, lastTickAt: t }, $unset: { mainBaseTile: '' }, $inc: { rev: 1 } },
      );
      return;
    }

    const newTid = tileId(worldId, spot.x, spot.y);
    // ADR-025: write the full 3×3 footprint (anchor garrison:0 + protection shield); ring cells carry the same shield.
    const baseDocs = this.core.baseTileDocs(worldId, spot.x, spot.y, defenderId, {
      garrison: 0,
      level: spot.level,
      ...(spot.resType ? { resType: spot.resType } : {}),
      protectedUntil: t + PROTECTION_SEC * 1000, // relocated to safety: apply protection shield
      ...(pw.familyId ? { familyId: pw.familyId } : {}),
    });
    await Promise.all(
      baseDocs.map((d) => cols.tiles.updateOne({ _id: d._id }, { $set: d }, { upsert: true })),
    );

    const yieldRate = await this.core.recomputeYield(worldId, defenderId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { yieldRate, mainBaseTile: newTid, lastTickAt: t }, $inc: { rev: 1 } },
    );
    const after = await cols.tiles.findOne({ _id: newTid });
    if (after) {
      void this.core.pushTile(defenderId, after);
      await this.core.pushTileToObservers(after, new Set([defenderId])); // G5-2: new capital after passive relocation is visible to observers
    }
  }

  /**
   * Pick a random legal empty tile (in bounds, not center/obstacle/gate/stronghold, unoccupied). Used for passive relocation placement and auto-spawn fallback.
   * When `minDr`>0, only accept tiles where dr (normalized distance to center, 0..1) > minDr (outer ring), keeping auto-spawns away from the central contest zone.
   * Server-authoritative random (not a replay path; Math.random is safe); tries up to a fixed number of times before returning null.
   */
  // ── S8-4 residual: defense config ────────────────────────────────

  /**
   * Set the defense config for a territory tile or capital (player editing the defense).
   * tileKey='base' → write to the capital's playerWorld.defense; otherwise write to the corresponding tile.defense.
   * Defense config contents are not validated at this layer (P2 deferred validation, §14.9); levelSchema validation on the engine side is added in S8-3b.
   */
  async setDefense(
    worldId: string,
    accountId: string,
    tileKey: string,
    defenseConfig: Record<string, unknown>,
  ): Promise<void> {
    const { cols } = this.core.deps;
    // G3-2c: editor writes a structured formation → validated against the engine levelSchema on save (invalid unitType/column/row → rejected).
    try {
      validateDefenseConfig(defenseConfig);
    } catch (err) {
      throw new SlgError('BAD_REQUEST', `Invalid defense formation: ${(err as Error).message}`);
    }
    if (tileKey === 'base') {
      const pwId = playerWorldId(worldId, accountId);
      const pw = await cols.playerWorld.findOne({ _id: pwId });
      if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
      await cols.playerWorld.updateOne(
        { _id: pwId },
        { $set: { defense: defenseConfig }, $inc: { rev: 1 } },
      );
    } else {
      const tile = await cols.tiles.findOne({ _id: tileKey });
      if (!tile?.ownerId) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
      // Own territory, or same-family ally territory (§4 proxy defense; allied sect passage pending alliance system) can both be set for defense.
      if (tile.ownerId !== accountId && !(await this.core.sameFamily(worldId, accountId, tile.ownerId))) {
        throw new SlgError('TILE_NOT_OWNED', 'Not your own or allied territory');
      }
      await cols.tiles.updateOne(
        { _id: tileKey },
        { $set: { defense: defenseConfig }, $inc: { rev: 1 } },
      );
    }
  }

  /** Whether two accounts belong to the same family (ally determination for §4 proxy defense / gate passage, consistent with computeMarchPath). */
  async getDefense(
    worldId: string,
    accountId: string,
    tileKey: string,
  ): Promise<Record<string, unknown> | null> {
    const { cols } = this.core.deps;
    if (tileKey === 'base') {
      const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
      if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
      return (pw.defense as Record<string, unknown> | undefined) ?? null;
    }
    const tile = await cols.tiles.findOne({ _id: tileKey });
    if (!tile || tile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
    return (tile.defense as Record<string, unknown> | undefined) ?? null;
  }
  // ── G3-2c: siege replay spectating ───────────────────────────────────

  /**
   * Retrieve the "replay spectating" level for a decisive siege (G3-2c, §16.3). Both attacker and defender can read it (spectating is not authoritative; purely visual).
   * Reconstructs buildSiegeBattle from the seed + both sides' formations + tile level persisted by landSiege → shape aligned with the client's LevelDefinition.
   * The client reruns the same siege headless in siege mode using an empty ReplayInputSource and the same seed, reproducing exactly what worldsvc ran.
   * If replay inputs are missing (cheap fallback / NPC sweep / old battle report) → REPLAY_UNAVAILABLE.
   */
  async getSiegeReplay(
    worldId: string,
    accountId: string,
    sid: string,
  ): Promise<{ siegeId: string; seed: number; outcome: SiegeOutcome; level: Record<string, unknown> }> {
    const siege = await this.core.deps.cols.sieges.findOne({ _id: sid, worldId });
    if (!siege) throw new SlgError('NOT_FOUND', 'Battle report not found');
    if (siege.attackerId !== accountId && siege.defenderId !== accountId) {
      throw new SlgError('NO_PERMISSION', 'Only the attacker or defender can spectate this battle');
    }
    if (typeof siege.seed !== 'number' || !Array.isArray(siege.attackerArmy)) {
      throw new SlgError('NOT_FOUND', 'This battle report has no replayable record');
    }
    const level = buildSiegeBattle(
      { army: siege.attackerArmy },
      siege.defenderConfig ?? null,
      siege.tileLevel ?? 1,
      siege.seed,
    );
    return { siegeId: sid, seed: siege.seed, outcome: siege.outcome, level };
  }
}
