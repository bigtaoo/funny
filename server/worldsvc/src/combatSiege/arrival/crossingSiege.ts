// Crossing PvE siege capture (gate→bridge/plankway migration). Split out of arrival.ts (2026-08-10,
// 独立函数模块 form — applyCrossingSiege is private, called only from applySiege in the same file).
// Reuses occupationBattle.ts's resolveOccupationBattle/writeOccupyCardState — see strongholdSiege.ts's
// header comment for why this is safe (identical NPC-garrison battle-resolution logic). Takes `core`
// (a plain WorldCore instance) and `ctx` (the assembled SiegeService, typed narrowly as
// SiegeCtx). No behavior change.
import type { ProceduralTile } from '@nw/shared';
import { passageGarrison } from '@nw/shared';
import type { PlayerWorldDoc, MarchDoc } from '../../db';
import type { WorldCore } from '../../core';
import { refundTroops, startReturnMarch, parkMarchInPlace } from '../../combatShared';
import type { SiegeCtx } from '../ctx';
import { resolveOccupationBattle, writeOccupyCardState } from '../occupationBattle';

/**
 * Crossing PvE siege capture (gate→bridge/plankway migration): an ownerless bridge/plankway tile guarded by an
 * NPC garrison (passageGarrison, weaker than a stronghold). Victory → 2026-08-09: starts an OCCUPY_HOLD_SEC
 * occupation hold (startOccupationHold) instead of writing ownership right away — settleOccupation still KEEPS
 * the tile's bridge/plankway type (so it stays a passage) and carries ownerId + familyId (so `passableGateKeys`
 * grants the owner & family passage) once the hold elapses, with survivors as garrison; no resource/material
 * loot (crossings are strategic choke points, not resource tiles). Defeat → surviving attackers retreat and
 * return. Defender is NPC throughout.
 */
export async function applyCrossingSiege(
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
  // Re-validate on arrival: captured by someone (or self) in the meantime → skip NPC fight; refund troops as a miss.
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

  const garrison = passageGarrison(proc.level);
  // See occupationBattle.ts for the full battle-resolution logic (shared verbatim with applyOccupy in occupation.ts).
  const { res, replay } = await resolveOccupationBattle(core, m, pw, garrison, proc.level);
  if (hasCardArmy) await writeOccupyCardState(core, m, pw, res.attackerSurvivors, t);

  if (res.outcome === 'attacker_win') {
    // 2026-08-09 (user decision — nothing in the game transfers instantly after a battle win):
    // capture starts the same OCCUPY_HOLD_SEC hold as every other capture (startOccupationHold,
    // which also covers this branch's recordSiege/push — no extra logic needed between write and
    // push, unlike applyStrongholdSiege's reward loop, so this can call the full helper directly).
    // `proc.type` is 'bridge'/'plankway' here, so its settleType auto-derives to the SAME crossing
    // type — settleOccupation still KEEPS it a passage on settlement, it does not become plain
    // territory (family passage via `passableGateKeys` lands then too, from the OccupationDoc's
    // familyId — no immediate familyId write needed here anymore).
    await ctx.startOccupationHold(m, pw, proc, x, y, res.attackerSurvivors, t, replay);
  } else {
    // Capture failed: surviving attackers retreat home over a travel-time return leg (2026-08-01,
    // SLG_DESIGN_LOG §46) instead of an instant pool credit.
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
