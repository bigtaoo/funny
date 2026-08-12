// ADR-037 (§5.4): the siege-battle resolution shared verbatim by applyOccupy (fighting a tile's NPC
// garrison) and applyOccupationExpulsion (fighting a rival's held garrison) — split out of
// occupation.ts (2026-08-10, 独立函数模块 form) once it became clear the two call sites differ only in
// how `garrison`/`tileLevel` are computed, not in how the battle itself resolves. Takes `core` (a plain
// WorldCore instance, not a protected mixin-base member — no structural-typing wall to work around,
// same reasoning as combatMarch/startMarchValidation.ts) plus the caller's already-computed locals.
// No behavior change.
import {
  siegeSeedFromId,
  resolveSiege,
  npcBaseHp,
  MARCH_MORALE_MAX,
  moraleCombatMultiplier,
  type SiegeResolution,
} from '@nw/shared';
import { runSiegeBattle, synthesizeArmy, scaleArmyByRatio, sumArmyHp, resolveCardArmy, toEngineCardInstances, computeCardStateUpdates, shouldUseCheapSiege } from '../siegeEngine';
import type { GarrisonEntry, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import type { MarchDoc, PlayerWorldDoc } from '../db';
import type { SiegeReplayInputs } from '../worldTypes';
import type { WorldCore } from '../core';

/**
 * Writes post-battle cardState (currentTroops + injuredUntil) for a card army's survivors on an occupy/expulsion
 * march (§6.1 — the card keeps its own troops regardless of outcome). Never touches playerWorld.troops.
 */
export async function writeOccupyCardState(
  core: WorldCore,
  m: MarchDoc,
  pw: PlayerWorldDoc,
  survivors: number,
  t: number,
): Promise<void> {
  const cardUpdates = computeCardStateUpdates(m.army ?? [], pw.cardState ?? {}, survivors, t);
  const cardStateSet: Record<string, unknown> = {};
  for (const [id, update] of Object.entries(cardUpdates)) {
    cardStateSet[`cardState.${id}.currentTroops`] = update.currentTroops;
    cardStateSet[`cardState.${id}.injuredUntil`] = update.injuredUntil != null ? update.injuredUntil : null;
  }
  if (Object.keys(cardStateSet).length > 0) {
    await core.deps.cols.playerWorld.updateOne({ _id: pw._id }, { $set: cardStateSet, $inc: { rev: 1 } });
  }
}

/**
 * Resolve the occupy/expulsion battle against a garrison of `garrison` troops on a tile of `tileLevel`
 * (real card team → resolve via cardState + blueprint injection, same as attack sieges in arrival.ts;
 * flat/legacy army or none → synthesize). Morale (行军疲劳, not the card 士气加成) scales attacker
 * strength by the march's remaining morale. Shared by applyOccupy (garrison = npcGarrison(proc.level))
 * and applyOccupationExpulsion (garrison = tile.contestedGarrison) — identical from here on.
 */
export async function resolveOccupationBattle(
  core: WorldCore,
  m: MarchDoc,
  pw: PlayerWorldDoc,
  garrison: number,
  tileLevel: number,
): Promise<{ res: SiegeResolution; replay: SiegeReplayInputs }> {
  const rawArmy = m.army ?? [];
  const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);
  const attackerSave = hasCardArmy ? await core.meta.getSaveFields(m.ownerId).catch(() => null) : null;
  const moraleMult = moraleCombatMultiplier(m.morale ?? MARCH_MORALE_MAX);
  const rawAttackerArmy: GarrisonEntry[] = hasCardArmy
    ? resolveCardArmy(rawArmy, pw.cardState ?? {}, attackerSave?.cardInv ?? {})
    : (rawArmy.length > 0 ? (rawArmy as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker'));
  const attackerArmy: GarrisonEntry[] = scaleArmyByRatio(rawAttackerArmy, moraleMult);
  // Real attacker strength for the cheap-siege path: for a card army, m.troops degenerates to roughly the
  // card-slot count (CC-3 — real strength lives in cardState.currentTroops, already folded into
  // rawAttackerArmy above via resolveCardArmy), so using m.troops here would floor every card to the base
  // survival rate regardless of true strength. A single Math.round(...*moraleMult) on the UNSCALED army's
  // HP sum (rather than summing the already per-unit-floored attackerArmy) avoids quantization loss
  // compounding across many small HP_PER_UNIT-sized chunks — for a flat/synthesized army
  // sumArmyHp(rawAttackerArmy) equals m.troops exactly (1 troop = 1 HP unit), so this is byte-for-byte the
  // same as the old m.troops-based formula for every non-card march, and only changes behavior for card armies.
  const attackerHp = Math.round(sumArmyHp(rawAttackerArmy) * moraleMult);
  let cardInstances: EngineCardInstance[] | undefined;
  let cardEquipInv: EngineEquipInv | undefined;
  if (hasCardArmy && attackerSave) {
    const { cardInstances: ci, engEquipInv } = toEngineCardInstances(rawArmy, attackerSave.cardInv ?? {}, attackerSave.equipmentInv ?? {});
    cardInstances = ci;
    cardEquipInv = engEquipInv;
  }
  const defenderConfig = { garrison: synthesizeArmy(garrison, 'defender'), defenderBaseHp: npcBaseHp(tileLevel) };
  const seed = siegeSeedFromId(m._id);
  // 2026-08-01 (traceability decision, see combatSiege/arrival.ts applySiege for the full rationale): replay
  // inputs are kept even on an engine crash — getSiegeReplay degrades safely (see that comment) rather than
  // crashing, so there is no downside to keeping the exact inputs that caused a crash for later reproduction.
  // 2026-08-12 fix: cardInstances/equipmentInv MUST be included too — these are the exact inputs about to be
  // passed to runSiegeBattle below; omitting them made every card-army replay reconstruct from plain baseline
  // blueprints instead of the attacker's real stats (see SiegeReplayInputs' doc comment for the incident).
  const replay: SiegeReplayInputs = {
    seed, attackerArmy, defenderConfig, tileLevel,
    ...(cardInstances ? { cardInstances } : {}),
    ...(cardEquipInv ? { equipmentInv: cardEquipInv } : {}),
  };
  // Overwhelming ratio or synthesized-army board overflow → skip the engine outright, same as every other
  // siege entry point (applySiege/applyStrongholdSiege/applyCrossingSiege) — without this gate, a very large
  // flat-troop (non-team) occupy march can synthesize an army beyond board capacity, congest the engine, and
  // spuriously time out to a defender win regardless of true strength (2026-08-03 worldsvc code review).
  const attackerSynthesized = !hasCardArmy && rawArmy.length === 0;
  let res: SiegeResolution;
  if (shouldUseCheapSiege({ attackerTroops: attackerHp, defenderTroops: garrison, attackerSynthesized, defenderSynthesized: true })) {
    res = resolveSiege(attackerHp, garrison);
  } else {
    try {
      res = await runSiegeBattle({ attackerArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv });
    } catch (err) {
      console.error('[worldsvc] occupy/expulsion siege engine failed — fallback to cheap resolve', {
        tile: m.toTile,
        err: (err as Error).message,
      });
      res = resolveSiege(attackerHp, garrison);
    }
  }
  return { res, replay };
}
