// Sweep NPC garrison from a neutral / resource tile (sweep arrival). Split out of arrival.ts
// (2026-08-10, 独立函数模块 form). `applySweep` is public (SiegeArrivalHandlers), so arrival.ts keeps a
// thin delegating method — see arrival.ts's facade comment. Takes `core` (a plain WorldCore instance)
// and `ctx` (the assembled SiegeService, typed narrowly as SiegeServiceBase; only `recordSiege` here).
// No behavior change.
import { proceduralTile, siegeSeedFromId, resolveSiege, npcGarrison, npcBaseHp, SWEEP_LOOT_PER_LEVEL, MARCH_MORALE_MAX, moraleCombatMultiplier, type ResourceType } from '@nw/shared';
import { synthesizeArmy } from '../../siegeEngine';
import type { PlayerWorldDoc, MarchDoc } from '../../db';
import { lootSummary, emptyResources } from '../../core';
import type { WorldCore } from '../../core';
import type { SiegeReplayInputs } from '../../worldTypes';
import { refundTroops, startReturnMarch, parkMarchInPlace } from '../../combatShared';
import type { SiegeServiceBase } from '../base';

/**
 * Sweep NPC garrison from a neutral / resource tile (sweep arrival). No occupation: on success, loot resources + surviving troops return to the pool;
 * on failure, attacker troop losses (survivors still return to the pool, possibly 0). If the tile is already player-occupied on arrival → refund troops (miss).
 * The outcome itself is always the cheap linear formula (never the real engine) — a synthesized formation is
 * built purely so the battle report has something to replay (see the `replay` local below).
 */
export async function applySweep(core: WorldCore, ctx: SiegeServiceBase, m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
  const { cols } = core.deps;
  const occ = await cols.tiles.findOne({ _id: m.toTile });
  if (occ?.ownerId) {
    // Already occupied (should use attack) → miss; park in place if team-dispatched, else refund troops
    // (2026-08-01, SLG_DESIGN_LOG §46 — sweep marches are flat-troop only today, so m.teamId is normally
    // absent here, but the same guard is applied for consistency should that ever change).
    if (m.teamId) {
      await parkMarchInPlace(core, m, m.troops, t);
    } else {
      await refundTroops(core, pw, m.troops, t);
      void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'recalled' }));
    }
    return;
  }
  const proc = proceduralTile(m.worldId, core.coordX(m.toTile), core.coordY(m.toTile));
  // Morale (行军疲劳, not the card 士气加成): scale attacker strength by the march's remaining morale (see applySiege above for detail).
  const effTroops = Math.round(m.troops * moraleCombatMultiplier(m.morale ?? MARCH_MORALE_MAX));
  const tileLevel = proc.level;
  const garrison = npcGarrison(tileLevel);
  const res = resolveSiege(effTroops, garrison);
  // Replay traceability (closing the one gap §45/SLG_DESIGN_LOG.md left open on purpose: sweep never built a
  // formation, so there was nothing to persist for client-side replay spectating). Synthesize the same
  // presentation-only inputs the cheap paths elsewhere already store unconditionally (attack/occupy
  // territory, stronghold/crossing PvE) so every combat action against a real garrison is replayable, not
  // just attack/occupy. The outcome above is still decided by the linear formula, not this synthesized
  // formation — replaying can show a different winner than the recorded `res.outcome`, same accepted drift
  // as every other cheap-resolved battle (SiegeDoc.seed doc comment: presentation-only, not authoritative).
  const replay: SiegeReplayInputs = {
    seed: siegeSeedFromId(m._id),
    attackerArmy: synthesizeArmy(effTroops, 'attacker'),
    defenderConfig: { garrison: synthesizeArmy(garrison, 'defender'), defenderBaseHp: npcBaseHp(tileLevel) },
    tileLevel,
  };
  let loot = emptyResources();
  if (res.outcome === 'attacker_win') {
    const rt: ResourceType = proc.resType ?? 'ink';
    loot = emptyResources();
    loot[rt] = SWEEP_LOOT_PER_LEVEL * Math.max(1, proc.level);
  }
  // Loot lands immediately (2026-08-01, SLG_DESIGN_LOG §46: only the physical troops need to walk home —
  // looted resources are credited at the moment of battle, same as every other siege outcome); surviving
  // troops retreat home over a travel-time return leg instead of an instant pool credit.
  await refundTroops(core, pw, 0, t, loot);
  if (res.attackerSurvivors > 0) {
    await startReturnMarch(core, {
      worldId: m.worldId, ownerId: m.ownerId, fromTile: m.toTile,
      x: core.coordX(m.toTile), y: core.coordY(m.toTile),
      troops: res.attackerSurvivors,
      army: m.army, teamId: m.teamId, leaderUnitType: m.leaderUnitType,
    }, t);
  }
  const siege = await ctx.recordSiege(m, undefined, res.outcome, t, replay);
  void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'arrived' }));
  void core.pushSiege(m.ownerId, siege, lootSummary(loot));
}
