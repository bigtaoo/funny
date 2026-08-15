// worldsvc march domain: troops parked (stationed) at a destination tile — listing them and
// recalling them home.
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md "拆分形态的优先级"
// 形态②): only ever calls `this.core` — assembled by composition in ../combatMarch.ts.
import { tileId, marchId, playerWorldId, marchDurationFromPath, isInVision, SlgError } from '@nw/shared';
import type { MarchDoc } from '../db';
import { WorldCore } from '../core';
import type { MarchView, StationedView } from '../worldTypes';
import { computeMarchPath, resolveOwnerEmblems } from '../combatShared';
import { legBox, sourcesBoundingBox } from '../core/helpers';

export class StationedService {
  constructor(private readonly core: WorldCore) {}

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
    // Parallel to `result` (same index) — feeds the emblem batch-resolve at the end (map-token
    // corner badge, family-emblem-art-prompts.md 2026-08-14).
    const ownerIds: string[] = own.map((d) => d.ownerId);

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
      ownerIds.push(d.ownerId);
    }

    const emblems = await resolveOwnerEmblems(this.core, worldId, ownerIds);
    return result.map((v, i) => (emblems[i] ? { ...v, ...emblems[i] } : v));
  }
}
