// ADR-037 (§5.4): the delayed occupation-hold settlement — turning a due OccupationDoc into real
// TileDoc ownership (plus the post-capture disposition: stay stationed, or walk home on autoReturn).
// Split out of occupation.ts (2026-09-03, 独立函数模块 form, same shape as ./occupationBattle.ts) when
// the order-end push audit took that file past the 500-line convention. Takes `core` (a plain WorldCore
// instance) plus the claimed doc; the only caller is processDueOccupations, which claim-deletes the doc
// and announces the order's end itself — deliberately outside this function, see the comment there.
// No behavior change.
import { playerWorldId } from '@nw/shared';
import type { TileDoc, OccupationDoc, StationedDoc } from '../db';
import type { WorldCore } from '../core';
import { startReturnMarch } from '../combatShared';

/** Finalize a settled OccupationDoc into real TileDoc ownership. Re-validates contestedBy to guard against a lost race. */
export async function settleOccupation(core: WorldCore, d: OccupationDoc, t: number): Promise<void> {
  const { cols } = core.deps;
  const tile = await cols.tiles.findOne({ _id: d.tile });
  if (!tile || tile.contestedBy !== d.ownerId) return; // stale (expelled / already settled elsewhere) — nothing to finalize

  // 2026-08-09: `d.type` is only ever set for a captured crossing (writeContestedHold's
  // settleType) — a bridge/plankway MUST keep its passage type on settlement, unlike every other
  // hold (neutral/stronghold/PvP-territory), which always settles into plain 'territory'.
  const tileDoc: TileDoc = {
    _id: d.tile,
    worldId: d.worldId,
    x: d.x,
    y: d.y,
    type: d.type ?? 'territory',
    level: d.level,
    ...(d.resType ? { resType: d.resType } : {}),
    ownerId: d.ownerId,
    garrison: d.garrison,
    ...(d.familyId ? { familyId: d.familyId } : {}),
    rev: 0,
  };
  await cols.tiles.updateOne(
    { _id: d.tile },
    { $set: tileDoc, $unset: { contestedBy: '', contestedUntil: '', contestedGarrison: '', contestedFamilyId: '' } },
  );

  const pw = await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, d.ownerId) });
  if (pw) {
    const yieldRate = await core.recomputeYield(d.worldId, d.ownerId);
    // 2026-08-24 (yieldRate/settle invariant): a yieldRate change must bank the accrual at the OLD rate in
    // the same atomic write. Advancing lastTickAt without writing resources discarded the whole un-settled
    // window; changing yieldRate without advancing it retroactively repriced that window at the new rate.
    // settleExpr evaluates against the pre-update $resources/$yieldRate/$lastTickAt, so the old-rate accrual
    // is banked in the same document update that installs the new rate — and needs no rev guard to be safe.
    await cols.playerWorld.updateOne({ _id: pw._id }, [
      { $set: { resources: core.settleExpr(pw.buildings, t), yieldRate, lastTickAt: t, rev: { $add: ['$rev', 1] } } },
    ]);
    void core.bumpFamilyActivity(d.worldId, pw.familyId, 1);
  }
  // Post-capture disposition (2026-07-23, user decision): by default the capturing team STAYS stationed on
  // the tile it just took (idle in the field) — write a StationedDoc so it stays "out" and renders a standing
  // sprite. Only when that team opted into `autoReturn` do we skip this: the OccupationDoc was already
  // claim-deleted upstream (processDueOccupations), so the team is already freed = idle at home, which is
  // exactly the pre-2026-07-23 behavior ("和现在那样自动返回"). Flat "散兵占领" (no teamId) never stations.
  if (d.teamId) {
    const team = pw?.teams?.find((tm) => tm.id === d.teamId);
    if (!team?.autoReturn) {
      const stDoc: StationedDoc = {
        _id: d.tile,
        worldId: d.worldId,
        ownerId: d.ownerId,
        ...(d.familyId ? { familyId: d.familyId } : {}),
        tile: d.tile,
        x: d.x,
        y: d.y,
        teamId: d.teamId,
        army: team?.army ?? [],
        troops: d.garrison,
        sinceAt: t,
        // ADR-051 (P3a): a team that just captured a tile stays 停留 idle by default (可再动/就地占领); it does
        // not auto-garrison. No cover registered (idle only defends its own cell). 驻扎 is an explicit intent.
        mode: 'idle',
        ...(d.leaderUnitType ? { leaderUnitType: d.leaderUnitType } : {}),
      };
      await cols.stationed.updateOne({ _id: d.tile }, { $set: stDoc }, { upsert: true });
      // ADR-051 (P2): register the parked team in the occupancy index so an enemy march entering this tile
      // detects it (scenario 1). Cleared on recall (recallStationed) or capture (abandonTile).
      await core.setOccupancy(d.worldId, d.tile, {
        kind: 'stationed',
        id: d.tile,
        ownerId: d.ownerId,
        ...(d.familyId ? { familyId: d.familyId } : {}),
        teamId: d.teamId,
        tile: d.tile,
        leaveAt: Number.MAX_SAFE_INTEGER,
      });
    } else {
      // autoReturn (2026-08-01, SLG_DESIGN_LOG §46): the team walks home over a travel-time return leg
      // instead of being freed instantly. troops:0 always — `d.garrison` already became the captured tile's
      // own permanent defense above (tileDoc.garrison), so sending it home too would double-count it; the
      // team's own strength (if any) already lives in cardState (§6.1), unaffected by this leg.
      await startReturnMarch(core, {
        worldId: d.worldId, ownerId: d.ownerId, fromTile: d.tile, x: d.x, y: d.y,
        troops: 0,
        army: team?.army, teamId: d.teamId, leaderUnitType: d.leaderUnitType,
      }, t);
    }
  }
  const after = await cols.tiles.findOne({ _id: d.tile });
  if (after) {
    void core.pushTile(d.ownerId, after);
    await core.pushTileToObservers(after, new Set([d.ownerId]));
  }
}
