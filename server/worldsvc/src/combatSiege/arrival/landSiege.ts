// Apply a single siege settlement result (G3-1 extraction, §16.4). Split out of arrival.ts (2026-08-10,
// 独立函数模块 form — landSiege is private, called only from applySiege in the same file). Takes `core`
// (a plain WorldCore instance) and `ctx` (the assembled SiegeService, typed narrowly as
// SiegeCtx). No behavior change.
import type { SiegeResolution } from '@nw/shared';
import { computeCardStateUpdates } from '../../siegeEngine';
import type { TileDoc, PlayerWorldDoc, MarchDoc } from '../../db';
import { lootSummary, emptyResources } from '../../core';
import type { WorldCore } from '../../core';
import type { SiegeReplayInputs } from '../../worldTypes';
import { startReturnMarch } from '../../combatShared';
import type { SiegeCtx } from '../ctx';

/**
 * Apply a single siege settlement result (G3-1 extraction, §16.4): write loot / garrison / nation founding /
 * passive relocation (attacker_win) or defender garrison casualties (defender_win) according to res + record
 * SiegeDoc + push march/siege/tile events. Currently called immediately by `applySiege` (cheap settlement
 * path unchanged); after G3-2 delayed settlement, both the judge re-computation confirmation and the timeout
 * fallback paths will share this single landing point.
 * 2026-08-09: tile hand-off is no longer part of this uniformly-immediate list for a plain-territory
 * attacker_win — that branch now starts an OCCUPY_HOLD_SEC occupation hold instead (see the branch's own
 * comment below); base/structure/crossing outcomes and defender_win are unaffected, still immediate.
 */
export async function landSiege(
  core: WorldCore,
  ctx: SiegeCtx,
  m: MarchDoc,
  pw: PlayerWorldDoc,
  target: TileDoc,
  defenderId: string,
  defender: PlayerWorldDoc | null,
  res: SiegeResolution,
  t: number,
  replay: SiegeReplayInputs | null,
): Promise<void> {
  const { cols } = core.deps;
  let loot = emptyResources();
  // CC-3: a card army's survivors are written to cardState.currentTroops below, never to playerWorld.troops.
  const hasCardArmy = !!m.army?.some((e) => !!e.cardInstanceId);

  if (res.outcome === 'attacker_win') {
    // Loot the defeated player's resources (transfer a proportion from defender to attacker).
    if (defender) loot = await ctx.transferLoot(defender, pw, t);
    if (target.type === 'base') {
      // The capital cannot be permanently taken, but being defeated triggers passive relocation (§3.4/§8.2, applies to all players):
      //   1) attacker survivors retreat home over a travel-time return leg (2026-08-01, SLG_DESIGN_LOG §46);
      //   2) if the defender is a sect leader, all sect members lose 50% of resources (§8.2 major penalty);
      //   3) defender's capital is randomly relocated to a new empty tile + all currently occupied territory is lost (passiveRelocate).
      if (hasCardArmy || res.attackerSurvivors > 0) {
        await startReturnMarch(core, {
          worldId: m.worldId, ownerId: m.ownerId, fromTile: m.toTile, x: target.x, y: target.y,
          troops: hasCardArmy ? 0 : res.attackerSurvivors,
          army: m.army, teamId: m.teamId, leaderUnitType: m.leaderUnitType,
        }, t);
      }
      await ctx.applySectLeaderPenalty(m.worldId, defenderId, t);
      await ctx.passiveRelocate(m.worldId, defenderId, t);
    } else if (target.structure && (target.structure.hp ?? target.structure.hpMax) - res.attackerSurvivors > 0) {
      // ADR-051 (§5.2 structure durability): the tile carries a player-built structure (arrowTower / blocker) with
      // hp remaining. Attack-only wear — clearing the garrison chips the structure's hp by the surviving assault
      // force (troop-scale) instead of instantly razing+capturing. While the structure stands the tile is NOT taken:
      // the assault retreats (survivors walk home / card survival written below), the garrison is spent, and the
      // reduced hp persists. Only when hp≤0 (the else branch's raze + capture) does the structure fall and the tile
      // change hands — so repeated assaults grind the bar down before it drops (§5.2 "多次攻打把血条磨到 0 才倒").
      const remainingHp = (target.structure.hp ?? target.structure.hpMax) - res.attackerSurvivors;
      await cols.tiles.updateOne(
        { _id: m.toTile },
        { $set: { 'structure.hp': remainingHp, garrison: 0 }, $inc: { rev: 1 } }, // garrison was wiped by the assault; structure alone remains
      );
      // Assault retreats home over a travel-time return leg (2026-08-01, SLG_DESIGN_LOG §46) instead of an
      // instant pool credit.
      if (hasCardArmy || res.attackerSurvivors > 0) {
        await startReturnMarch(core, {
          worldId: m.worldId, ownerId: m.ownerId, fromTile: m.toTile, x: target.x, y: target.y,
          troops: hasCardArmy ? 0 : res.attackerSurvivors,
          army: m.army, teamId: m.teamId, leaderUnitType: m.leaderUnitType,
        }, t);
      }
      // The tile did not change hands → no ownership/nation/yield change; the defender simply keeps a weakened structure.
    } else {
      // Territory (or a player-owned crossing — bridge/plankway) changes hands — 2026-08-09 (user
      // decision, corrected same-day: "nothing in the game transfers instantly after a battle
      // win" — this now covers a crossing too, not just plain territory). Mirrors the neutral-land
      // occupation hold (§5.4, ADR-037) instead of writing ownerId right away: the defender loses
      // the tile (and its yield) right away, but the winner's claim only confirms after
      // OCCUPY_HOLD_SEC, reusing the EXACT same OccupationDoc/settleOccupation/processDueOccupations
      // machinery as occupying a neutral tile (occupation.ts) — settleOccupation doesn't care
      // whether the tile was neutral or previously player-owned, it just finalizes whichever
      // contestedBy claim is still standing. `writeContestedHold`'s settleType auto-derives from
      // `target.type` — a crossing (bridge/plankway) settles back into the SAME crossing type
      // (stays a passage), everything else settles into plain 'territory'.
      // During the hold, applySiege's existing `!target?.ownerId && contestedBy` branch already lets
      // the ORIGINAL owner (or anyone else) send a fresh 'attack' march to fight the held garrison
      // via applyOccupationExpulsion — no extra code needed there, since clearing ownerId here makes
      // this tile indistinguishable from a contested neutral one. Survivors become the pending
      // `contestedGarrison` (troops were deducted on departure; do not modify the attacker pool
      // again). The client stops showing a blocking "Siege won!" modal for this case
      // (WorldMapNet.applySiegeResult) — same lightweight toast as an occupy win.
      // ADR-051 (P5): clear a razed arrow tower's 3×3 coverage from the reverse index BEFORE the
      // write below unsets TileDoc.structure — removeCover needs the doc that still has it.
      if (target.structure?.kind === 'arrowTower') await core.removeCover(m.worldId, target.x, target.y, m.toTile);
      await ctx.writeContestedHold(
        m, pw,
        { type: target.type, level: target.level, resType: target.resType },
        target.x, target.y, res.attackerSurvivors, t, defenderId,
      );
    }
  } else {
    // Defender wins: garrison reduced to survivors; attacker survivors retreat home over a travel-time
    // return leg (2026-08-01, SLG_DESIGN_LOG §46; §16.5 survivor refund, engine provides real survivors);
    // fallen troops are permanently lost. On the cheap fallback path where attackerSurvivors=0 (and no card
    // army), there is nothing to send home — same as the pre-existing full-wipe convention.
    await cols.tiles.updateOne(
      { _id: m.toTile },
      { $set: { garrison: res.defenderSurvivors }, $inc: { rev: 1 } },
    );
    if (hasCardArmy || res.attackerSurvivors > 0) {
      await startReturnMarch(core, {
        worldId: m.worldId, ownerId: m.ownerId, fromTile: m.toTile, x: target.x, y: target.y,
        troops: hasCardArmy ? 0 : res.attackerSurvivors,
        army: m.army, teamId: m.teamId, leaderUnitType: m.leaderUnitType,
      }, t);
    }
  }

  const siege = await ctx.recordSiege(m, defenderId, res.outcome, t, replay);

  // CC-3: write post-battle cardState (currentTroops + injuredUntil) for attacker card army.
  const attackArmy = m.army ?? [];
  if (hasCardArmy) {
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
  void core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
  void core.bumpFamilyActivity(m.worldId, defender?.familyId, 1);
  const lootStr = lootSummary(loot);
  void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'arrived' }));
  void core.pushSiege(m.ownerId, siege, lootStr);
  void core.pushSiege(defenderId, siege, lootStr);
  const after = await cols.tiles.findOne({ _id: m.toTile });
  if (after) {
    void core.pushTile(m.ownerId, after);
    void core.pushTile(defenderId, after);
    await core.pushTileToObservers(after, new Set([m.ownerId, defenderId])); // G5-2: tile hand-off is visible to observers within vision
  }
}
