// Stronghold PvE siege capture (G8 §3.1). Split out of arrival.ts (2026-08-10, 独立函数模块 form —
// applyStrongholdSiege is private, called only from applySiege in the same file). Reuses
// occupationBattle.ts's resolveOccupationBattle/writeOccupyCardState — the attacker-army-resolution +
// cheap/engine battle + post-battle cardState write are byte-identical to applyOccupy's fight against an
// NPC garrison (both just synthesize the defender from a garrison count and fight it), so this no longer
// duplicates that logic locally. Takes `core` (a plain WorldCore instance) and `ctx` (the assembled
// SiegeService, typed narrowly as SiegeCtx). No behavior change.
import {
  strongholdGarrison,
  STRONGHOLD_LOOT_PER_LEVEL,
  strongholdMaterialLoot,
  RESOURCE_CAP,
  RESOURCE_TYPES,
  type ResourceType,
  type ProceduralTile,
} from '@nw/shared';
import type { PlayerWorldDoc, MarchDoc } from '../../db';
import { lootSummary, emptyResources } from '../../core';
import type { WorldCore } from '../../core';
import { refundTroops, startReturnMarch, parkMarchInPlace } from '../../combatShared';
import type { SiegeCtx } from '../ctx';
import { resolveOccupationBattle, writeOccupyCardState } from '../occupationBattle';

/**
 * Stronghold PvE siege capture (G8 §3.1): an ownerless stronghold tile; the system derives an ultra-strong NPC garrison + high base from the tile level.
 * Uses the authoritative engine siege (bad formation / error → cheap fallback). Victory → one-time rich resource
 * reward lands immediately, but ownership itself starts an OCCUPY_HOLD_SEC occupation hold (2026-08-09,
 * writeContestedHold) instead of writing territory right away — nation founding / activity refresh wait for
 * settleOccupation; Defeat → surviving attackers retreat and return (NPC garrison is not persisted — procedural, not stored in DB; resets next time).
 * Defender is NPC throughout: no defenderId, no player loot, no protection shield.
 */
export async function applyStrongholdSiege(
  core: WorldCore,
  ctx: SiegeCtx,
  m: MarchDoc,
  pw: PlayerWorldDoc,
  t: number,
  proc: ProceduralTile,
): Promise<void> {
  const { cols } = core.deps;
  const x = core.coordX(m.toTile);
  const y = core.coordY(m.toTile);
  // CC-3: a card army's committed strength lives in cardState.currentTroops, not playerWorld.troops (see applySiege).
  const rawArmy = m.army ?? [];
  const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);
  // Re-validate on arrival: already occupied by another player or self (including simultaneous captures) → skip NPC fight; refund troops as a miss.
  const occ = await cols.tiles.findOne({ _id: m.toTile });
  if (occ?.ownerId) {
    if (m.teamId) {
      await parkMarchInPlace(core, m, m.troops, t);
    } else {
      if (!hasCardArmy) await refundTroops(core, pw, m.troops, t);
      void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'recalled' }));
    }
    return;
  }

  const garrison = strongholdGarrison(proc.level);
  // See occupationBattle.ts for the full battle-resolution logic (shared verbatim with applyOccupy in occupation.ts).
  const { res, replay } = await resolveOccupationBattle(core, m, pw, garrison, proc.level);
  if (hasCardArmy) await writeOccupyCardState(core, m, pw, res.attackerSurvivors, t, res.attackerDeployed);

  if (res.outcome === 'attacker_win') {
    // 2026-08-09 (user decision — nothing in the game transfers instantly after a battle win):
    // capture starts the same OCCUPY_HOLD_SEC hold as every other capture (writeContestedHold);
    // ownerId/yieldRate/applyNationChange wait for settleOccupation (occupation.ts) — only the
    // one-time capture reward + material drop below still land immediately (loot convention,
    // unaffected — same as every other siege outcome in this file).
    await ctx.writeContestedHold(m, pw, proc, x, y, res.attackerSurvivors, t);
    // One-time capture reward (§3.1 "substantial resources"): add to the attacker's resource pool by tile level + resource type (capped).
    const rt: ResourceType = proc.resType ?? 'ink';
    const reward = emptyResources();
    reward[rt] = STRONGHOLD_LOOT_PER_LEVEL * Math.max(1, proc.level);
    // Rev-guarded refetch+retry (mirrors combatShared.ts refundTroops / combatSiege/helpers.ts
    // transferLoot's 2026-08-03 fix): `resources` must be computed from a FRESH read each attempt, not
    // the `pw` snapshot captured at function entry — a blind $set here previously overwrote whatever a
    // concurrent settlement (e.g. the cardState write just above, this account's own return-march
    // refund, or any other concurrent mutation) had just applied. Called from the scheduler
    // (processDueArrivals), not a live HTTP request, so exhaustion is best-effort-logged rather than
    // thrown — the tile capture above already committed unconditionally and must not be orphaned by a
    // failure to also apply this one-time resource bonus.
    const MAX_ATTEMPTS = 5;
    let rewardApplied = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Always re-read fresh (not just on retries): the cardState write above, when hasCardArmy, has
      // already unconditionally bumped rev past `pw.rev`, so trusting the entry snapshot on attempt 0
      // would guarantee a wasted first failure.
      const freshPw = (await cols.playerWorld.findOne({ _id: pw._id })) ?? pw;
      const resources = core.settle(freshPw, t);
      for (const r of RESOURCE_TYPES) resources[r] = Math.min(RESOURCE_CAP, (resources[r] ?? 0) + reward[r]);
      const settled = await cols.playerWorld.updateOne(
        { _id: pw._id, rev: freshPw.rev },
        // yieldRate is NOT recomputed here (2026-08-09) — the attacker doesn't own the stronghold
        // tile yet during the hold; settleOccupation recomputes it once ownership actually lands.
        { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
      );
      if (settled.matchedCount > 0) { rewardApplied = true; break; }
    }
    if (!rewardApplied) {
      console.error('[worldsvc] stronghold capture reward: giving up after rev-conflict retries', { tile: m.toTile, ownerId: m.ownerId });
    }
    // Extra progression material drop (§19.5 + G4 §15.6): sent to meta SaveData.materials unified pool (cross-process,
    // best-effort, orderId idempotent; march is settled once — (worldId, toTile, arriveAt) is stable as idempotent key).
    const matLoot = strongholdMaterialLoot(proc.level);
    void core.meta.grantMaterial(m.ownerId, matLoot.material, matLoot.qty, `stronghold_loot:${m.worldId}:${m.toTile}:${m.arriveAt}`);
    void core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
    const siege = await ctx.recordSiege(m, undefined, res.outcome, t, replay);
    void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'arrived' }));
    void core.pushSiege(m.ownerId, siege, `${lootSummary(reward)},${matLoot.material}+${matLoot.qty}`);
    const after = await cols.tiles.findOne({ _id: m.toTile });
    if (after) {
      void core.pushTile(m.ownerId, after);
      await core.pushTileToObservers(after, new Set([m.ownerId])); // G5-2: stronghold capture arrival is visible to observers
    }
  } else {
    // Capture failed: surviving attackers retreat home over a travel-time return leg (2026-08-01,
    // SLG_DESIGN_LOG §46) instead of an instant pool credit. NPC garrison is not persisted; no casualty write.
    if (hasCardArmy || res.attackerSurvivors > 0) {
      await startReturnMarch(core, {
        worldId: m.worldId, ownerId: m.ownerId, fromTile: m.toTile, x, y,
        troops: hasCardArmy ? 0 : res.attackerSurvivors,
        army: m.army, teamId: m.teamId, leaderUnitType: m.leaderUnitType,
      }, t);
    }
    void core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
    const siege = await ctx.recordSiege(m, undefined, res.outcome, t, replay);
    void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'arrived' }));
    void core.pushSiege(m.ownerId, siege, '');
  }
}
