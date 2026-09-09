// worldsvc march domain: the per-tile walk of one stepping march (2026-09-09 split out of arrival.ts,
// claudedocs/server.md's "拆分形态的优先级" 形态① — independent function modules).
//
// ADR-051 (P1/P2b/P3b) lives here: a march advances cell-by-cell, keeps the occupancy index pointing at
// exactly its CURRENT cell, and on every cell entered checks the two enemy sources that can intercept it
// (an occupant standing there, or a garrison/tower whose footprint covers it). Both halves of the arrival
// tick call it — the walking scan for a march still short of its destination, the settlement scan for one
// at or past it (WORLDSVC_CONCURRENCY_AUDIT_2026-09-05 §7.2/§7.3) — and the difference is entirely in
// which marches they hand it, not in what it does with them.
//
// The one edge out of this module is the arrival at the end of the path, which is applyArrival's job
// (./arrivalSettle.ts). Everything above that line is the marcher's OWN lifecycle: its cursor, its troop
// ledger after an interception, and its deletion when it dies en route. The combat ledgers of whatever it
// runs into belong to the siege domain (../combatSiege/encounter.ts), reached through ArrivalSiegeCtx.
import { tileId, playerWorldId, marchStepArriveAt } from '@nw/shared';
import type { MarchDoc } from '../db';
import type { WorldCore } from '../core';
import { startReturnMarch } from '../combatShared';
import type { ArrivalSiegeCtx } from './arrivalCtx';
import { applyArrival } from './arrivalSettle';

/**
 * ADR-051 (P1/P2b): advance a stepping march tile-by-tile up to time `t`, writing the occupancy index at each
 * cell entered and (P2b) resolving a field encounter whenever the cell already holds an ENEMY unit. Returns
 * true iff the march is fully handled and must not be rescheduled — either it reached its final path cell and
 * its arrival was applied (claimed+deleted), or it was destroyed by a lost en-route encounter (also deleted).
 * Otherwise the step cursor (stepIndex/nextStepAt) is persisted; the next processDueArrivals scan (Mongo
 * nextStepAt) picks it up. The occupancy write stays best-effort (Redis-absent = no encounters, arrival still
 * correct via Mongo).
 */
export async function advanceMarch(core: WorldCore, siege: ArrivalSiegeCtx, m: MarchDoc, t: number): Promise<boolean> {
  const { cols } = core.deps;
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
  // `m.speedMult` and not a fresh lookup: the cadence has to match the one `arriveAt` was computed from
  // at dispatch (ADR-074 §8.3, MarchDoc.speedMult).
  while (idx < last && marchStepArriveAt(m.departAt, idx + 1, m.speedMult) <= t) {
    const left = path[idx]!;
    idx++;
    const cell = path[idx]!;
    await core.clearOccupancy(m.worldId, tileId(m.worldId, left.x, left.y), m._id);
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
      let enc: Awaited<ReturnType<typeof siege.resolveFieldEncounter>> | null = null;
      const occ = await core.getOccupancy(m.worldId, tid);
      if (occ && occ.id !== m._id && occ.leaveAt > t) {
        if (occ.ownerId !== m.ownerId && !(familyId && occ.familyId === familyId)) {
          enc = await siege.resolveFieldEncounter(m, pw, occ, tid, t);
        } else {
          skipOwnOcc = true; // friendly resident — leave its occ untouched
        }
      }
      // No occ fight → consult the coverage index (§3.4). Two kinds of enemy cover, resolved in order:
      //   P5 (§5.2) arrow tower → chip the marcher's army (pass-through damage, no stop). Applied first so a
      //             marcher shot down by tower fire never reaches the melee; a flat army wiped to 0 dies here.
      //   P3b garrison → the FIRST enemy garrison covering this cell intercepts with a real battle.
      if (!enc) {
        const covers = await core.getCover(m.worldId, tid);
        const enemyCovers = covers.filter((c) => c.ownerId !== m.ownerId && !(familyId && c.familyId === familyId));
        for (const tower of enemyCovers) {
          if (tower.kind !== 'tower') continue;
          const dmg = await siege.applyTowerDamage(m, pw, tower, t);
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
              void core.pushMarch(m.ownerId, core.marchView({ ...claimed, status: 'recalled' }));
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
          enc = await siege.resolveFieldEncounter(m, pw, garrisonOcc, garCover.sourceTile, t);
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
          void core.pushMarch(m.ownerId, core.marchView({ ...claimed, status: 'recalled' }));
          if (enc.returnTroops !== undefined) {
            await startReturnMarch(core, {
              worldId: claimed.worldId, ownerId: claimed.ownerId, fromTile: tid,
              x: core.coordX(tid), y: core.coordY(tid),
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
            void core.pushMarch(m.ownerId, core.marchView({ ...claimed, status: 'recalled' }));
          }
          return true; // fully handled (removed) — do not reschedule
        }
      }
    }

    if (!skipOwnOcc) {
      const leaveAt = idx < last ? marchStepArriveAt(m.departAt, idx + 1, m.speedMult) : Number.MAX_SAFE_INTEGER;
      await core.setOccupancy(m.worldId, tid, {
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
    await core.clearOccupancy(claimed.worldId, claimed.toTile, claimed._id);
    await applyArrival(core, siege, claimed, t);
    return true;
  }
  // Mid-route: persist the new cursor. Guard on status:'marching' AND kind≠return so a concurrent recall
  // (which flips to a return leg and $unsets the cursor) is never clobbered back. The next processDueArrivals
  // scan (Mongo nextStepAt) picks up the advance from here.
  const nextStepAt = marchStepArriveAt(m.departAt, idx + 1, m.speedMult);
  await cols.marches.updateOne(
    { _id: m._id, status: 'marching', kind: { $ne: 'return' } },
    { $set: { stepIndex: idx, nextStepAt }, $inc: { rev: 1 } },
  );
  return false;
}
