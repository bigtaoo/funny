// ADR-037 (§5.4): occupy-march PvE battle + delayed occupation-hold settlement. `applyOccupy` is the arrival
// handler for MarchKind='occupy' (dispatched from combatMarch/arrival.ts), replacing the old instant/no-combat grab);
// `applyOccupationExpulsion` is shared by both an interrupting 'occupy' march (this file) and an
// interrupting 'attack' march against a mid-hold tile (combatSiege/arrival.ts); `processDueOccupations` is the
// scheduler tick that finalizes ownership once the hold elapses (mirrors ADR-026's processDueSiegeDamage).
// Depends on SiegeHelpersService (recordSiege) for battle-report logging; shares refundTroops with the rest of
// the combat domain.
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md's "拆分形态的优先级" 形态②):
// constructed with a reference to SiegeHelpersService (./helpers.ts) — assembled by composition in
// ../combatSiege.ts. ArrivalService (./arrival.ts) is constructed with a reference to THIS class (for
// applyOccupationExpulsion, called directly, and writeContestedHold/startOccupationHold, bound into a
// narrow ctx — see ./ctx.ts). No behavior change.
import {
  proceduralTile,
  playerWorldId,
  npcGarrison,
  isCityGroundTile,
  OCCUPY_HOLD_SEC,
  SlgError,
  type TileType,
  type ResourceType,
} from '@nw/shared';
import type { TileDoc, PlayerWorldDoc, MarchDoc, OccupationDoc } from '../db';
import { WorldCore } from '../core';
import type { SiegeReplayInputs, OccupationView } from '../worldTypes';
import { refundTroops, startReturnMarch, parkMarchInPlace, resolveOwnerEmblems } from '../combatShared';
import type { SiegeHelpersService } from './helpers';
import { writeOccupyCardState, resolveOccupationBattle } from './occupationBattle';
import { settleOccupation } from './occupationSettle';

/** Minimal "what does this tile look like right now" shape `writeContestedHold`/`startOccupationHold`
 * need — satisfied by a `ProceduralTile` (neutral/stronghold/crossing PvE captures) or a plain literal
 * built from a real `TileDoc` (PvP territory/crossing captures, which must use the target's ACTUAL
 * current level/resType, not a re-derived procedural guess — a captured tile can already differ from
 * its procedural default in ways `proceduralTile()` would not know about). */
export interface HoldTileDesc {
  type: TileType;
  level: number;
  resType?: ResourceType;
}

export class OccupationService {
  constructor(
    private readonly core: WorldCore,
    private readonly helpers: SiegeHelpersService,
  ) {}

  /**
   * Occupy march arrival (§5.4): re-validate the target is still occupiable, then either fight the tile's
   * system garrison (npcGarrison(level), same source of truth as applySweep) or — if the tile is already
   * mid occupation-hold by someone else — treat this as an expulsion attempt against their held garrison.
   * Victory starts (or restarts) an occupation hold rather than writing ownership immediately.
   */
  async applyOccupy(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
    const { cols } = this.core.deps;
    // CC-3 (2026-07-15, SLG_DESIGN §4.2): a card-army march's strength lives entirely in cardState.currentTroops,
    // never in playerWorld.troops — every refund path below must skip the pool credit for such a march.
    const rawArmy = m.army ?? [];
    const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);
    const x = this.core.coordX(m.toTile);
    const y = this.core.coordY(m.toTile);
    const proc = proceduralTile(m.worldId, x, y);
    const occ = await cols.tiles.findOne({ _id: m.toTile });

    // ADR-039 territory connectivity: the occupier's sect territory can shift during transit; re-validate
    // here before any capture branch — treat like a miss (refund), same as the ownership recheck below.
    // occupy never targets a capital, so a single cell (no footprint resolution needed).
    if (!(await this.core.isConnectedToSectTerritory(m.worldId, m.ownerId, [{ x, y }]))) {
      // 2026-08-01 (SLG_DESIGN_LOG §46): target invalidated on arrival → park in place (team-dispatched
      // marches) rather than teleport home instantly; a teamless march has no team-slot identity to park
      // under, so it keeps the old instant refund.
      if (m.teamId) {
        await parkMarchInPlace(this.core, m, m.troops, t);
      } else {
        if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      }
      return;
    }

    const blocked =
      // isCityGroundTile = familyKeep | center. City ground is siege-only (ADR-074); this arrival-time
      // re-check used to name 'center' alone, so a march dispatched before the departure-side guard existed
      // (or against a world whose template moved a city under it in flight) could still land on a city plot.
      isCityGroundTile(proc.type) ||
      (occ?.ownerId != null && occ.ownerId !== m.ownerId) ||
      (occ?.ownerId === m.ownerId && occ.type !== 'base');
    if (blocked) {
      if (m.teamId) {
        await parkMarchInPlace(this.core, m, m.troops, t);
      } else {
        if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
        void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      }
      return;
    }

    // Mid occupation-hold by someone else → this march is an expulsion attempt against their held garrison.
    if (occ?.contestedBy && occ.contestedBy !== m.ownerId && (occ.contestedUntil ?? 0) > t) {
      await this.applyOccupationExpulsion(m, pw, occ, t);
      return;
    }
    // Our own pending hold already occupies this tile (race: a second occupy march from the same player) —
    // reinforcing an in-progress hold is out of scope for v1; treat as a miss and refund.
    if (occ?.contestedBy && occ.contestedBy === m.ownerId) {
      // Not converted to parkMarchInPlace (2026-08-01, SLG_DESIGN_LOG §46): this tile already has our OWN
      // occupation-hold settling on it — StationedDoc is one-per-tile (keyed by tileId), and settleOccupation's
      // own post-capture stationing upsert (or the hold's ownership write) would silently clobber a second
      // team parked here by this march. Keep the pre-existing instant-refund behavior for this specific race.
      if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'recalled' }));
      return;
    }

    const garrison = npcGarrison(proc.level);
    if (garrison <= 0) {
      // Defensive-only fallback (npcGarrison always > 0 given resourceDensity=1.0 — see §5.4); instant occupy, no combat.
      await this.startOccupationHold(m, pw, proc, x, y, m.troops, t, null);
      return;
    }

    // Real card team (2026-07-15, SLG_DESIGN §4.2) → resolve via cardState + blueprint injection, same as
    // attack sieges (combatSiege/arrival.ts) — occupying land now reflects the player's actual army, not a
    // generic synthesized force. Flat/legacy army or none → synthesize as before. See occupationBattle.ts
    // for the full battle-resolution logic (shared verbatim with applyOccupationExpulsion below).
    const { res, replay } = await resolveOccupationBattle(this.core, m, pw, garrison, proc.level);

    if (res.outcome === 'attacker_win') {
      // Card survivors also land on cardState (§6.1 — the card keeps its own troops) in addition to seeding
      // the newly captured tile's independent garrison stat below (startOccupationHold); the two are unrelated
      // ledgers, not a double-refund of the same pool (see SLG_DESIGN §4.2).
      if (hasCardArmy) await writeOccupyCardState(this.core, m, pw, res.attackerSurvivors, t, res.attackerDeployed);
      await this.startOccupationHold(m, pw, proc, x, y, res.attackerSurvivors, t, replay);
    } else {
      // Battle lost: a card army's survivors already landed on cardState above (§6.1 — the card keeps its
      // own troops regardless of outcome); the team itself still needs to walk home rather than being freed
      // instantly, same as a flat army's survivor count (2026-08-01, SLG_DESIGN_LOG §46).
      if (hasCardArmy) {
        await writeOccupyCardState(this.core, m, pw, res.attackerSurvivors, t, res.attackerDeployed);
      }
      if (hasCardArmy || res.attackerSurvivors > 0) {
        await startReturnMarch(this.core, {
          worldId: m.worldId, ownerId: m.ownerId, fromTile: m.toTile, x, y,
          troops: hasCardArmy ? 0 : res.attackerSurvivors,
          army: m.army, teamId: m.teamId, leaderUnitType: m.leaderUnitType,
        }, t);
      }
      void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      const siege = await this.helpers.recordSiege(m, undefined, res.outcome, t, replay);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
      void this.core.pushSiege(m.ownerId, siege, '');
    }
  }

  /**
   * Expulsion (§5.4): an interrupting 'attack' march (combatSiege/arrival.ts applySiege, target no-owner but
   * mid-hold) or 'occupy' march (applyOccupy above) fights the CURRENT held garrison (tile.contestedGarrison),
   * not a re-fetched NPC garrison — the original occupier already replaced the system defenders with real troops.
   * Win → cancel the old hold and start a fresh one for the interrupter (reusing startOccupationHold).
   * Loss → the original hold is undisturbed; interrupter survivors are refunded.
   */
  async applyOccupationExpulsion(m: MarchDoc, pw: PlayerWorldDoc, tile: TileDoc, t: number): Promise<void> {
    const { cols } = this.core.deps;
    const rawArmy = m.army ?? [];
    const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);
    const garrison = tile.contestedGarrison ?? 0;
    // See occupationBattle.ts for the full battle-resolution logic (shared verbatim with applyOccupy above).
    const { res, replay } = await resolveOccupationBattle(this.core, m, pw, garrison, tile.level ?? 1);

    if (res.outcome === 'attacker_win') {
      // Cancel the old hold (atomic claim by id + expected holder guards against a race with a concurrent
      // processDueOccupations tick that may have already settled/claimed it — in that case just proceed to
      // start our own hold on top of whatever ownership now stands, re-validated by the blocked check upstream).
      const expelled = tile.contestedBy;
      await cols.occupations.deleteOne({ _id: tile._id, ownerId: expelled });
      // The winner's own pushes come from startOccupationHold below; this one goes to the LOSER, whose
      // hold just stopped existing. Without it their client keeps the dead OccupationDoc forever and the
      // team it names is busy for the rest of the session (same defect as settleOccupation's, found by
      // the order-end push audit) — on top of which they would have no idea they had been expelled.
      if (expelled) void this.core.pushOrderEnded(expelled, { tile: tile._id, kind: 'occupy', status: 'recalled', at: t });
      if (hasCardArmy) await writeOccupyCardState(this.core, m, pw, res.attackerSurvivors, t, res.attackerDeployed);
      const proc = proceduralTile(m.worldId, tile.x, tile.y);
      await this.startOccupationHold(m, pw, proc, tile.x, tile.y, res.attackerSurvivors, t, replay);
    } else {
      // Same disposition as applyOccupy's loss branch: cardState is already updated above; the team (or a
      // flat army's survivors) walks home over a travel-time return leg (2026-08-01, SLG_DESIGN_LOG §46).
      if (hasCardArmy) {
        await writeOccupyCardState(this.core, m, pw, res.attackerSurvivors, t, res.attackerDeployed);
      }
      if (hasCardArmy || res.attackerSurvivors > 0) {
        await startReturnMarch(this.core, {
          worldId: m.worldId, ownerId: m.ownerId, fromTile: m.toTile, x: tile.x, y: tile.y,
          troops: hasCardArmy ? 0 : res.attackerSurvivors,
          army: m.army, teamId: m.teamId, leaderUnitType: m.leaderUnitType,
        }, t);
      }
      void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      const siege = await this.helpers.recordSiege(m, tile.contestedBy, res.outcome, t, replay);
      void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
      void this.core.pushSiege(m.ownerId, siege, '');
    }
  }

  /**
   * Write the contested-hold state onto a tile: TileDoc contested fields (`desc.type/level/resType`
   * kept as the tile's PRE-capture look — e.g. still 'stronghold'/'bridge'/a resource type; no
   * `ownerId` yet) + upsert the matching OccupationDoc. Pure data write, no push/recordSiege — every
   * caller keeps doing those its own way (some inline per outcome branch, `landSiege`
   * (combatSiege/arrival.ts) via its own shared tail) so calling this never risks a double-push.
   * 2026-08-09 (user decision — "nothing in the game transfers instantly after a battle win"):
   * generalized from the old neutral-land-only `startOccupationHold` so applyStrongholdSiege /
   * applyCrossingSiege (PvE) and landSiege's PvP territory/crossing branch (arrival.ts) all funnel
   * through the same write instead of each hand-rolling an instant `$set ownerId`.
   * `settleType` — what `settleOccupation` will write to `TileDoc.type` once the hold elapses —
   * auto-derives to `desc.type` for a crossing (bridge/plankway must STAY a passage) or 'territory'
   * for everything else (matches the pre-existing occupy/stronghold behavior of flipping display
   * type only on settlement, see `TileDoc.type`/OccupationDoc.type` for the field itself).
   * `defenderId`, when set (a PvP capture with a previous owner), recomputes and writes THAT
   * account's yieldRate right away — they lose the tile's yield the instant they lose the battle,
   * even though the winner's claim is still pending.
   */
  async writeContestedHold(
    m: MarchDoc,
    pw: PlayerWorldDoc,
    desc: HoldTileDesc,
    x: number,
    y: number,
    survivors: number,
    t: number,
    defenderId?: string,
  ): Promise<void> {
    const { cols } = this.core.deps;
    const dueAt = t + OCCUPY_HOLD_SEC * 1000;
    const settleType: TileType = (desc.type === 'bridge' || desc.type === 'plankway') ? desc.type : 'territory';
    const tileDoc: TileDoc = {
      _id: m.toTile,
      worldId: m.worldId,
      x,
      y,
      type: desc.type,
      level: desc.level,
      ...(desc.resType ? { resType: desc.resType } : {}),
      contestedBy: m.ownerId,
      contestedUntil: dueAt,
      contestedGarrison: survivors,
      ...(pw.familyId ? { contestedFamilyId: pw.familyId } : {}),
      rev: 0,
    };
    // $unset clears whatever a PvP target previously carried as an owned tile (ownerId/garrison/
    // protectedUntil/structure) — a no-op for the PvE/neutral callers, which never had those fields.
    await cols.tiles.updateOne(
      { _id: m.toTile },
      { $set: tileDoc, $unset: { ownerId: '', garrison: '', protectedUntil: '', structure: '' } },
      { upsert: true },
    );

    const occDoc: OccupationDoc = {
      _id: m.toTile,
      worldId: m.worldId,
      ownerId: m.ownerId,
      ...(pw.familyId ? { familyId: pw.familyId } : {}),
      tile: m.toTile,
      x,
      y,
      level: desc.level,
      ...(desc.resType ? { resType: desc.resType } : {}),
      ...(settleType !== 'territory' ? { type: settleType } : {}),
      garrison: survivors,
      dueAt,
      ...(m.teamId ? { teamId: m.teamId } : {}),
      ...(m.leaderUnitType ? { leaderUnitType: m.leaderUnitType } : {}),
    };
    await cols.occupations.updateOne({ _id: m.toTile }, { $set: occDoc }, { upsert: true });

    if (defenderId) {
      const defYield = await this.core.recomputeYield(m.worldId, defenderId);
      // 2026-08-24 (yieldRate/settle invariant): a yieldRate change must bank the accrual at the OLD rate in
      // the same atomic write. Advancing lastTickAt without writing resources discarded the whole un-settled
      // window; changing yieldRate without advancing it retroactively repriced that window at the new rate.
      // settleExpr evaluates against the pre-update $resources/$yieldRate/$lastTickAt, so the old-rate accrual
      // is banked in the same document update that installs the new rate — and needs no rev guard to be safe.
      // `pw` in scope here is the *attacker's* doc, so the defender's buildings (for the storage cap) need
      // their own read — cheap on this scheduler path, and it also lets a missing doc skip the write.
      const defPwId = playerWorldId(m.worldId, defenderId);
      const defPw = await cols.playerWorld.findOne({ _id: defPwId });
      if (defPw) {
        await cols.playerWorld.updateOne({ _id: defPwId }, [
          { $set: { resources: this.core.settleExpr(defPw.buildings, t), yieldRate: defYield, lastTickAt: t, rev: { $add: ['$rev', 1] } } },
        ]);
      }
    }
  }

  /**
   * Start (or restart, on expulsion) an occupation hold, then do the "no defender" push/recordSiege
   * that applyOccupy / applyOccupationExpulsion / the PvE stronghold+crossing captures all share
   * (their target is always ownerless, and this only ever runs on an attacker_win — a loss never
   * reaches this method). `landSiege` (PvP territory/crossing, combatSiege/arrival.ts) calls
   * `writeContestedHold` directly instead: it already has its own shared tail that records/pushes
   * for BOTH outcomes (hold-start included) using the real defenderId, so routing it through here
   * too would double-push.
   */
  async startOccupationHold(
    m: MarchDoc,
    pw: PlayerWorldDoc,
    desc: HoldTileDesc,
    x: number,
    y: number,
    survivors: number,
    t: number,
    replay: SiegeReplayInputs | null,
  ): Promise<void> {
    const { cols } = this.core.deps;
    await this.writeContestedHold(m, pw, desc, x, y, survivors, t);
    void this.core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
    const siege = await this.helpers.recordSiege(m, undefined, 'attacker_win', t, replay);
    void this.core.pushMarch(m.ownerId, this.core.marchView({ ...m, status: 'arrived' }));
    void this.core.pushSiege(m.ownerId, siege, '');
    const after = await cols.tiles.findOne({ _id: m.toTile });
    if (after) {
      void this.core.pushTile(m.ownerId, after);
      await this.core.pushTileToObservers(after, new Set([m.ownerId]));
    }
  }

  /**
   * Scheduler tick (mirrors processDueSiegeDamage): claim due OccupationDocs and finalize ownership. Atomic
   * claim-and-delete by (_id, ownerId, dueAt) makes this single-consumer safe against a concurrent expulsion
   * that may have already replaced/deleted the same doc.
   */
  async processDueOccupations(nowMs?: number): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();
    const due = await cols.occupations.find({ dueAt: { $lte: t } }).limit(500).toArray();
    let n = 0;
    for (const d of due) {
      const claimed = await cols.occupations.findOneAndDelete({ _id: d._id, ownerId: d.ownerId, dueAt: d.dueAt });
      if (!claimed) continue; // lost to a concurrent expulsion / processor
      try {
        await settleOccupation(this.core, claimed, t);
      } catch (e) {
        console.error('[worldsvc] settleOccupation failed:', { id: claimed._id, err: (e as Error).message });
      }
      // 2026-09-02 user report: tell the owner their hold ENDED. Deliberately here, at the claim, and
      // not inside settleOccupation: the doc is gone from this point on no matter what follows — a
      // stale tile makes settleOccupation early-return, and a throw is only logged — so this is the one
      // place where "the occupation no longer exists" is unconditionally true. Without it the client's
      // `ctx.occupations` never drops the finished hold and keeps the team flagged busy forever (see
      // core/push.ts pushOccupationSettled). The autoReturn branch's return leg pushes a march_update
      // of its own, so those settlements send two invalidations; both are plain re-read triggers, and
      // paying one redundant push there is worth keeping this signal unconditional.
      void this.core.pushOrderEnded(claimed.ownerId, { tile: claimed.tile, kind: 'occupy', status: 'arrived', at: claimed.dueAt });
      n++;
    }
    return n;
  }

  /**
   * Player-initiated cancel of an in-progress occupation-hold (2026-07-15, team management "取消指令"): unlike
   * recallMarch (combatMarch/command.ts), this is instant and forfeits the contested garrison — no travel-back leg and
   * no troop refund, since there's nothing left to march home. The team is freed immediately: deleting the
   * OccupationDoc is exactly what the TEAM_BUSY gate's `cols.occupations.findOne({..., teamId})` check looks
   * for, so the next march/occupy dispatch sees the team as idle right away. The tile itself reverts to
   * unclaimed (contested fields unset, mirrors settleOccupation's $unset) rather than being handed to anyone.
   */
  async cancelOccupation(worldId: string, accountId: string, teamId: string): Promise<void> {
    const { cols } = this.core.deps;
    const claimed = await cols.occupations.findOneAndDelete({ worldId, ownerId: accountId, teamId });
    if (!claimed) throw new SlgError('OCCUPATION_NOT_FOUND', 'No active occupation-hold for this team');
    await cols.tiles.updateOne(
      { _id: claimed.tile },
      { $unset: { contestedBy: '', contestedUntil: '', contestedGarrison: '', contestedFamilyId: '' } },
    );
    // Same rule as settleOccupation: the hold is gone, so say so on the order channel. The caller's own
    // client could refresh locally instead, but the account's OTHER sessions/devices cannot, and today
    // no client calls this route at all — leaving it silent would plant the defect for whoever wires it.
    void this.core.pushOrderEnded(accountId, { tile: claimed.tile, kind: 'occupy', status: 'recalled', at: this.core.deps.now() });
    const after = await cols.tiles.findOne({ _id: claimed.tile });
    if (after) {
      void this.core.pushTile(accountId, after);
      await this.core.pushTileToObservers(after, new Set([accountId]));
    }
  }

  /** List the player's own active occupation-holds (2026-07-15 team management: status + cancel affordance). */
  async getOccupations(worldId: string, accountId: string): Promise<OccupationView[]> {
    const { cols } = this.core.deps;
    const own = await cols.occupations.find({ worldId, ownerId: accountId }).toArray();
    const result: OccupationView[] = own.map((d) => ({
      tile: d.tile,
      x: d.x,
      y: d.y,
      level: d.level,
      garrison: d.garrison,
      dueAt: d.dueAt,
      ...(d.teamId ? { teamId: d.teamId } : {}),
      ...(d.leaderUnitType ? { leaderUnitType: d.leaderUnitType } : {}),
    }));
    // getOccupations is own-holds-only, so this is always the requester's own family badge (map-token
    // corner badge, family-emblem-art-prompts.md 2026-08-14) — still resolved via the shared batch
    // helper for consistency with getMarches/getStationed rather than a bespoke single-owner lookup.
    const emblems = await resolveOwnerEmblems(this.core, worldId, own.map((d) => d.ownerId));
    return result.map((v, i) => (emblems[i] ? { ...v, ...emblems[i] } : v));
  }
}
