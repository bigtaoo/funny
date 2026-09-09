// worldsvc march domain: what a march DOES once it is standing on its destination tile (2026-09-09 split
// out of arrival.ts, claudedocs/server.md's "拆分形态的优先级" 形态① — independent function modules).
//
// This is the tail of the settling half (WORLDSVC_CONCURRENCY_AUDIT_2026-09-05 §7.3), reached by exactly
// two callers: the settlement scan itself for a legacy / 'return' leg, and advanceMarch for a stepping
// march that walked onto its final cell this tick. By the time anything here runs the MarchDoc has already
// been claimed and deleted, so these functions never re-read or reschedule it — they only apply effects.
//
// applyArrival dispatches by `m.kind`: 'return' refunds, 'attack'/'sweep'/'occupy' hand off to the siege
// domain, 'move' parks the carried team via applyMove/tryParkTeam, and the fallthrough is 'reinforce'.
// The move/park pair stays private to this file: only applyArrival reaches them.
//
// Why this is a separate module from arrivalWalk.ts: the walking half is cheap, batchable and touches only
// the marcher's own documents; this half writes the DEFENDER's ledger and takes ground, which is why it
// can be neither batched nor made concurrent and why it is the half the 2026-09-09 time slice exists for.
// The two share no state — the only edge between them is advanceMarch's one call into applyArrival.
import { proceduralTile, playerWorldId, isCityGroundTile } from '@nw/shared';
import type { MarchDoc, StationedDoc, PlayerWorldDoc } from '../db';
import type { WorldCore } from '../core';
import { refundTroops, parkMarchInPlace } from '../combatShared';
import type { ArrivalSiegeCtx } from './arrivalCtx';

/** Apply the effects of a single arrived march (already removed from marches collection). */
export async function applyArrival(core: WorldCore, siege: ArrivalSiegeCtx, m: MarchDoc, t: number): Promise<void> {
  const { cols } = core.deps;
  const pw = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, m.ownerId) });
  if (!pw) return; // player state missing (should not happen); troops are lost with it; exit safely.

  if (m.kind === 'return') {
    // A card-army team's real strength lives entirely in cardState.currentTroops and never touched
    // playerWorld.troops on departure (§CC-3) — m.troops degenerates to "card count" for such a
    // march, so crediting it to the pool on return would be a free-troops dupe. Every other refund
    // site in this file (applyMove, the reinforce-miss branch below) checks hasCardArmy first.
    const hasCardArmy = (m.army ?? []).some((e) => !!e.cardInstanceId);
    if (!hasCardArmy) await refundTroops(core, pw, m.troops, t);
    void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'recalled' }));
    return;
  }

  if (m.kind === 'attack') {
    await siege.applySiege(m, pw, t);
    return;
  }

  if (m.kind === 'sweep') {
    await siege.applySweep(m, pw, t);
    return;
  }

  if (m.kind === 'move') {
    await applyMove(core, m, pw, t);
    return;
  }

  if (m.kind === 'occupy') {
    // ADR-037 (§5.4): occupy arrival now fights the target's system garrison (or an in-progress occupier's held
    // garrison, if expelling) via the same deterministic engine siege uses, and — on victory — starts a delayed
    // occupation hold instead of writing ownership immediately. See combatSiege/occupation.ts.
    await siege.applyOccupy(m, pw, t);
    return;
  }

  // reinforce
  const target = await cols.tiles.findOne({ _id: m.toTile });
  if (!target || target.ownerId !== m.ownerId) {
    // Reinforcement target is no longer own territory (captured / abandoned) → target invalidated on arrival,
    // same disposition as the siege/occupy miss branches (2026-08-01, SLG_DESIGN_LOG §46): park in place for
    // a team-dispatched march, else keep the old instant refund.
    if (m.teamId) {
      await parkMarchInPlace(core, m, m.troops, t);
    } else {
      await refundTroops(core, pw, m.troops, t);
      void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'recalled' }));
    }
    return;
  }
  // `$inc` on the STORED garrison, and deliberately NO `garrisonRegenAt` stamp. Both halves matter
  // (shared/src/slg/garrison.ts): incrementing the stored field keeps reinforcements refundable and keeps
  // baseline-heal militia out of the owner's balance, while leaving the checkpoint alone means a tile
  // reinforced mid-heal keeps the healing it had accrued — live garrison becomes (stored + troops) still
  // healed from the old anchor, rather than restarting the clock and silently discarding it.
  await cols.tiles.updateOne({ _id: m.toTile }, { $inc: { garrison: m.troops, rev: 1 } });
  void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'arrived' }));
  const after = await cols.tiles.findOne({ _id: m.toTile });
  if (after) void core.pushTile(m.ownerId, after);
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
async function applyMove(core: WorldCore, m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
  if (!m.teamId) {
    // Unreachable in practice (startMarch guarantees a team for every 'move'); kept only because
    // MarchDoc.teamId is typed optional. A card army's strength lives in cardState regardless of this refund.
    const hasCardArmy = (m.army ?? []).some((e) => !!e.cardInstanceId);
    if (!hasCardArmy) await refundTroops(core, pw, m.troops, t);
    void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'recalled' }));
    return;
  }
  const toX = core.coordX(m.toTile);
  const toY = core.coordY(m.toTile);
  if (await tryParkTeam(core, m, m.teamId, pw, m.toTile, toX, toY, t, 'arrived')) return;

  const fromX = core.coordX(m.fromTile);
  const fromY = core.coordY(m.fromTile);
  if (await tryParkTeam(core, m, m.teamId, pw, m.fromTile, fromX, fromY, t, 'recalled')) return;

  const hasCardArmy = (m.army ?? []).some((e) => !!e.cardInstanceId);
  if (!hasCardArmy) await refundTroops(core, pw, m.troops, t);
  void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'recalled' }));
}

/**
 * Try to park m's team as a StationedDoc on `tile` (x,y): same legality check applyMove always used for its
 * destination (not the world center, not already stationed-on by anyone, not another owner's tile, not mid
 * occupation-hold) — reused here for both the intended destination and, on a miss, the fallback origin tile.
 * Returns false (no writes at all) if `tile` is currently blocked.
 */
async function tryParkTeam(
  core: WorldCore,
  m: MarchDoc,
  teamId: string,
  pw: PlayerWorldDoc,
  tile: string,
  x: number,
  y: number,
  t: number,
  pushStatus: 'arrived' | 'recalled',
): Promise<boolean> {
  const { cols } = core.deps;
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
    ? (await core.friendlyAccountIds(m.worldId, m.ownerId)).has(occ!.ownerId!)
    : false;
  // ADR-074 P3: city ground is no longer flatly off-limits — a sect may station inside its OWN city (a
  // garrison team defends it; an idle team on a capital / the world center is §8.4's launch anchor). Every
  // other city is still siege-only. Re-checked here and not merely trusted from dispatch because the city
  // can change hands mid-flight, which is exactly when a team must NOT land: it would be parking inside
  // someone else's fortress. Same helper as the departure check so the two cannot drift.
  const cityHere = isCityGroundTile(proc.type)
    ? await core.stationableCityAt(m.worldId, m.ownerId, x, y, isGarrison ? 'garrison' : 'idle')
    : null;
  const blocked =
    (isCityGroundTile(proc.type) && !cityHere) ||
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
  await core.setOccupancy(m.worldId, tile, {
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
    await core.addCover(m.worldId, x, y, {
      kind: 'garrison',
      sourceTile: tile,
      ownerId: m.ownerId,
      ...(pw.familyId ? { familyId: pw.familyId } : {}),
      teamId,
    });
  }
  void core.pushMarch(m.ownerId, core.marchView({ ...m, status: pushStatus }));
  const after = await cols.tiles.findOne({ _id: tile });
  if (after) void core.pushTile(m.ownerId, after);
  return true;
}
