// worldsvc march domain: scheduler-driven settlement. processDueArrivals is the tick entry point;
// advanceMarch steps one march, applyArrival/applyMove settle it at the destination, and tryParkTeam
// parks the carried team there. Attack/sweep arrivals are dispatched onwards to SiegeService.
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md "拆分形态的优先级"
// 形态②): the only one of the three march domains that needs `siege` (applySiege/applySweep/
// applyOccupy/resolveFieldEncounter/applyTowerDamage) — assembled by composition in
// ../combatMarch.ts.
import { proceduralTile, tileId, playerWorldId, marchStepArriveAt, isCityGroundTile } from '@nw/shared';
import type { MarchDoc, StationedDoc, PlayerWorldDoc } from '../db';
import { WorldCore } from '../core';
import type { SiegeService } from '../combatSiege';
import { refundTroops, parkMarchInPlace, startReturnMarch } from '../combatShared';

export class ArrivalService {
  constructor(
    private readonly core: WorldCore,
    private readonly siege: SiegeService,
  ) {}

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
    // 2026-08-03 (worldsvc code review): `m` is a snapshot from the batch scan in processDueArrivals.
    // If an earlier march's encounter this same tick destroyed this march (as someone else's occ
    // resident, via resolveFieldEncounter) or a concurrent recall/instant-return claimed it, `m` here
    // is stale — advancing it anyway would still run the per-step occupancy writes below and register
    // a brand-new occ entry for a MarchDoc that no longer exists, permanently leaking it (nothing will
    // ever clear an occ id whose owning doc is gone). Re-verify against the latest doc before doing
    // any work, and use it in place of the stale snapshot for everything that follows.
    const live = await cols.marches.findOne({ _id: m._id, status: 'marching' });
    if (!live) return true; // already removed this batch by a concurrent encounter/recall — nothing to do
    if (!live.path || live.stepIndex == null || live.nextStepAt == null) {
      // No longer a stepping march (e.g. a concurrent recall $unset the cursor and flipped it to a
      // 'return' leg) — let it be picked up as a legacy/return arrival once its arriveAt is due.
      return true;
    }
    m = live;
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
      // A card-army team's real strength lives entirely in cardState.currentTroops and never touched
      // playerWorld.troops on departure (§CC-3) — m.troops degenerates to "card count" for such a
      // march, so crediting it to the pool on return would be a free-troops dupe. Every other refund
      // site in this file (applyMove, the reinforce-miss branch below) checks hasCardArmy first.
      const hasCardArmy = (m.army ?? []).some((e) => !!e.cardInstanceId);
      if (!hasCardArmy) await refundTroops(this.core, pw, m.troops, t);
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
    // 驻守 rule (2026-08-02): mirrors the startMarch-time check in combatMarch/command.ts — 驻扎 garrison may
    // additionally land on a FRIENDLY account's territory (family / sect / allied sect), but a neutral
    // (ownerless) tile is idle-only; re-checked here since tile ownership may have changed in transit.
    const isGarrison = m.stationMode === 'garrison';
    const foreignOwner = occ?.ownerId != null && occ.ownerId !== m.ownerId;
    const isFriendlyGarrisonTarget = isGarrison && foreignOwner
      ? (await this.core.friendlyAccountIds(m.worldId, m.ownerId)).has(occ!.ownerId!)
      : false;
    const blocked =
      // isCityGroundTile = familyKeep | center — city ground is siege-only, never merely stood on (ADR-074).
      isCityGroundTile(proc.type) ||
      !!stationedHere ||
      (foreignOwner && !isFriendlyGarrisonTarget) ||
      (!occ?.ownerId && isGarrison) ||
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
}
