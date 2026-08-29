// ADR-026 main-base siege: in-base, non-injured defender teams (t1..t5) fight the attacker in waves.
// Split out of arrival.ts (2026-08-10, 独立函数模块 form — applyBaseSiege is private, called only from
// applySiege in the same file, so there is no mixin-interface constraint on lifting it out entirely).
// Takes `core` (a plain WorldCore instance) and `ctx` (a narrow SiegeCtx exposing only the handful of
// methods this function needs — recordSiege here; 2026-08-11 mixin-chain split: ArrivalService builds
// one `ctx` object with each method `.bind()`-ed to whichever sibling class owns it, see ../ctx.ts).
// No behavior change — this is the exact method body, moved verbatim.
import {
  playerWorldId,
  resolveSiege,
  NATION_BONUS_DEFENSE,
  teamSiegeValue,
  waveSeed,
  SLG_SIEGE_DAMAGE_DELAY_MS,
  SLG_TEAM_INJURY_MS,
  type CardInstance,
  type EquipmentInstance,
  type SiegeOutcome,
  type SiegeResolution,
} from '@nw/shared';
import { runSiegeBattle, scaleArmyHp, scaleArmyByRatio, sumArmyHp, toDefenderFormation, resolveCardArmy, shouldUseCheapSiege } from '../../siegeEngine';
import { computeCardStateUpdates, cardStateDeltaPipeline } from '../../cardStateSettlement';
import type { GarrisonEntry, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import type { TileDoc, PlayerWorldDoc, MarchDoc, SiegeDamageDoc } from '../../db';
import { lootSummary, emptyResources } from '../../core';
import type { WorldCore } from '../../core';
import type { SiegeReplayInputs } from '../../worldTypes';
import type { SaveFields } from '../../metaClient';
import { startReturnMarch } from '../../combatShared';
import type { SiegeCtx } from '../ctx';

/**
 * ADR-026 main-base siege: in-base, non-injured defender teams (t1..t5) fight the attacker in waves; the attacker's
 * surviving troops carry over between waves. Clearing all defenders (or none present) is a garrison win → schedule a
 * delayed building-HP hit (SiegeDamageDoc, +SLG_SIEGE_DAMAGE_DELAY_MS) equal to the attacking team's siege value.
 * Each defeated defender team is injured for SLG_TEAM_INJURY_MS (never defends until healed). An attacker wiped
 * mid-waves fails the siege (no HP damage) and retreats immediately. The real building HP (TileDoc.hp on the anchor)
 * is only reduced later by processDueSiegeDamage → capture (passiveRelocate) at HP≤0.
 */
export async function applyBaseSiege(
  core: WorldCore,
  ctx: SiegeCtx,
  m: MarchDoc,
  pw: PlayerWorldDoc,
  baseTile: TileDoc,
  defenderId: string,
  defender: PlayerWorldDoc | null,
  inOwnNation: boolean,
  attackerArmy: GarrisonEntry[],
  cardInstances: EngineCardInstance[] | undefined,
  cardEquipInv: EngineEquipInv | undefined,
  siegeAcademy: { hp: number; damage: number; siege: number } | undefined,
  attackerCardInv: Record<string, CardInstance>,
  attackerEquipInv: Record<string, EquipmentInstance>,
  attackerSynthesized: boolean,
  t: number,
  defenderSave: SaveFields | null,
): Promise<void> {
  const { cols } = core.deps;
  const tileLevel = baseTile.level ?? 1;
  // wall no longer buffs garrison HP during battle — its effect moved to persistent durability
  // (D-CITY-8; see settleSiegeDamage's use of baseDurabilityMax for the delayed HP hit below).

  // Teams currently out on active (non-recalled) marches are skipped as defenders (ADR-026 §2).
  const activeMarches = await cols.marches
    .find({ worldId: m.worldId, ownerId: defenderId, status: { $ne: 'recalled' }, teamId: { $exists: true } })
    .toArray();
  const outTeams = new Set(activeMarches.map((x) => x.teamId).filter((id): id is string => !!id));

  // Defender card inventory (resolve team card armies → unit type + troop count). v1: defender cards use base blueprints on defence (no per-card level/gear buff; follow-up).
  // defenderSave is pre-fetched by the caller (applySiege), in parallel with the attacker's own fetch.
  const defCardInv = defenderSave?.cardInv ?? {};
  const defCardState = defender?.cardState ?? {};
  const teamState = defender?.teamState ?? {};

  // In-base, non-injured teams in t1..t5 order.
  const defenders = (defender?.teams ?? [])
    .filter((tm) => tm.army.length > 0 && !outTeams.has(tm.id))
    .filter((tm) => !((teamState[tm.id]?.injuredUntil ?? 0) > t))
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  // Wave battle: attacker survivors carry over between waves (scaled by survival ratio).
  let survivorArmy: GarrisonEntry[] = attackerArmy.map((e) => ({ ...e }));
  let attackerSurvivors = sumArmyHp(survivorArmy);
  // ADR-069: the nominal troop total the assault started with, plus the running product of each
  // wave's HONEST survival ratio (survivors ÷ what that wave actually deployed in clamped HP).
  // Before ADR-069 both the inter-wave carry-over and the final cardState write divided engine
  // survivors by the NOMINAL troop sum, so a card team lost ~half its troops per wave on paper even
  // when it barely took a scratch — see SiegeResolution.attackerDeployed.
  const nominalDeployed = attackerSurvivors;
  let cumSurvivalRatio = 1;
  const defeatedTeamIds: string[] = [];
  const replays: SiegeReplayInputs[] = [];
  let cleared = true;

  for (let i = 0; i < defenders.length; i++) {
    const tm = defenders[i]!;
    if (survivorArmy.length === 0 || attackerSurvivors <= 0) { cleared = false; break; }
    // Re-place the attack-authored team onto defender spawn positions (top half) so the auto-battle isn't degenerate.
    let defArmy = toDefenderFormation(resolveCardArmy(tm.army, defCardState, defCardInv));
    if (inOwnNation) defArmy = scaleArmyHp(defArmy, 1 + NATION_BONUS_DEFENSE); // §2.4 nation defence bonus
    if (defArmy.length === 0) { defeatedTeamIds.push(tm.id); continue; }      // empty/stale team → already cleared (still injured)
    // ADR-026: the per-wave engine "base" is only a battle terminator (the real building durability is TileDoc.hp,
    // reduced separately by the delayed siege-value hit). Pin it to the weakest level so each wave is decided by
    // team-vs-attacker, not by a symbolic base tanking the assault.
    const defenderConfig = { garrison: defArmy, defenderBaseLevel: 0 };
    const seed = waveSeed(m._id, i);
    const deployedHp = sumArmyHp(survivorArmy);
    let res: SiegeResolution;
    // A synthesized attacker army beyond board capacity clogs lanes and must never reach the engine (defender
    // teams are always real, level-schema-validated formations — never synthesized, so no symmetric check needed).
    if (shouldUseCheapSiege({ attackerTroops: deployedHp, defenderTroops: sumArmyHp(defArmy), attackerSynthesized, defenderSynthesized: false })) {
      res = resolveSiege(deployedHp, sumArmyHp(defArmy));
    } else {
      try {
        res = await runSiegeBattle({ attackerArmy: survivorArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv, siegeAcademy });
      } catch (err) {
        console.error('[worldsvc] base wave siege engine failed — cheap fallback', { tile: baseTile._id, wave: i, err: (err as Error).message });
        res = resolveSiege(deployedHp, sumArmyHp(defArmy));
      }
    }
    // 2026-08-12 fix: cardInstances/equipmentInv/siegeAcademy are the same attacker loadout fed into
    // runSiegeBattle a few lines up for every wave — omitting them from the stored replay made a
    // from-scratch reconstruction fall back to plain baseline blueprints (see SiegeReplayInputs' doc
    // comment, worldTypes.ts).
    replays.push({
      seed, attackerArmy: survivorArmy, defenderConfig, tileLevel,
      ...(cardInstances ? { cardInstances } : {}),
      ...(cardEquipInv ? { equipmentInv: cardEquipInv } : {}),
      ...(siegeAcademy ? { siegeAcademy } : {}),
    });
    attackerSurvivors = res.attackerSurvivors;
    // `deployedHp` (nominal) is the right fallback only for the cheap/flat path, where the two
    // coincide; the engine path reports its own clamped deployment (ADR-069).
    const waveDeployed = res.attackerDeployed > 0 ? res.attackerDeployed : deployedHp;
    const ratio = waveDeployed > 0 ? res.attackerSurvivors / waveDeployed : 0;
    cumSurvivalRatio *= Math.min(1, ratio);
    if (res.outcome === 'attacker_win') {
      defeatedTeamIds.push(tm.id);
      survivorArmy = scaleArmyByRatio(survivorArmy, ratio);
      if (survivorArmy.length === 0) { cleared = false; break; } // attacker spent — cleared some waves but cannot continue
    } else {
      cleared = false; // repelled by this wave
      break;
    }
  }

  // Persist defender team injuries (each defeated team locked for SLG_TEAM_INJURY_MS).
  if (defeatedTeamIds.length > 0 && defender) {
    const injSet: Record<string, unknown> = {};
    for (const id of defeatedTeamIds) injSet[`teamState.${id}.injuredUntil`] = t + SLG_TEAM_INJURY_MS;
    await cols.playerWorld.updateOne({ _id: playerWorldId(m.worldId, defenderId) }, { $set: injSet, $inc: { rev: 1 } });
  }

  const outcome: SiegeOutcome = cleared ? 'attacker_win' : 'defender_win';
  const replay = replays.length > 0 ? (replays[replays.length - 1] ?? null) : null;
  const siege = await ctx.recordSiege(m, defenderId, outcome, t, replay);

  // CC-3: attacker card post-battle state (uniform survival over the whole siege). Card-army survivors are
  // written ONLY to cardState.currentTroops here — never to playerWorld.troops (see the `else` branch below).
  const attackArmy = m.army ?? [];
  const hasCardArmy = attackArmy.some((e) => !!e.cardInstanceId);
  if (hasCardArmy) {
    // ADR-069: express the whole multi-wave assault as one honest survival fraction of the nominal
    // troops the team left home with (each wave's ratio already measured against its real deployment),
    // instead of handing the LAST wave's clamped-HP survivor count to a nominal-troop denominator.
    const cardUpdates = computeCardStateUpdates(
      attackArmy, pw.cardState ?? {}, Math.round(nominalDeployed * cumSurvivalRatio), t, nominalDeployed,
    );
    // 2026-08-24: persist the battle's per-card LOSS, not an absolute survivor count — see
    // cardStateDeltaPipeline. Identical result with no concurrent write; a distributeTroops top-up that does
    // land in the window now survives instead of being erased.
    const cardPipeline = cardStateDeltaPipeline(cardUpdates);
    if (cardPipeline.length > 0) await cols.playerWorld.updateOne({ _id: pw._id }, cardPipeline);
  }

  if (cleared) {
    // Garrison cleared (or no defenders present): schedule the delayed building-HP hit = attacking team's siege value
    // (sum of the team's per-card siege value; a real card team is always > 0). Attacker keeps besieging; survivors are refunded at settlement.
    // SLG_CITY_SIEGE_DESIGN §12.7 twin item (wired 2026-08-29): reads the attacker's equipped gear too.
    const damage = teamSiegeValue(m.army ?? [], attackerCardInv, attackerEquipInv);
    const dmg: SiegeDamageDoc = {
      _id: siege._id,
      worldId: m.worldId,
      attackerId: m.ownerId,
      defenderId,
      tile: baseTile._id,
      isBase: true,
      damage,
      attackerSurvivors,
      ...(pw.familyId ? { familyId: pw.familyId } : {}),
      dueAt: t + SLG_SIEGE_DAMAGE_DELAY_MS,
    };
    await cols.siegeDamage.updateOne({ _id: dmg._id }, { $setOnInsert: dmg }, { upsert: true });
  } else if (hasCardArmy || attackerSurvivors > 0) {
    // Attacker repelled: survivors retreat home over a travel-time return leg (2026-08-01,
    // SLG_DESIGN_LOG §46) instead of an instant pool credit — a card army's survivors were already written
    // to cardState above, so its return leg carries troops:0 (walking the team home / freeing its slot),
    // while a flat/legacy army's return leg carries the real survivor count.
    await startReturnMarch(core, {
      worldId: m.worldId, ownerId: m.ownerId, fromTile: m.toTile,
      x: core.coordX(m.toTile), y: core.coordY(m.toTile),
      troops: hasCardArmy ? 0 : attackerSurvivors,
      army: m.army, teamId: m.teamId, leaderUnitType: m.leaderUnitType,
    }, t);
  }

  // Activity + battle-report push (loot only happens at capture, in settleSiegeDamage → empty here).
  void core.bumpFamilyActivity(m.worldId, pw.familyId, 1);
  void core.bumpFamilyActivity(m.worldId, defender?.familyId, 1);
  const lootStr = lootSummary(emptyResources());
  void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'arrived' }));
  void core.pushSiege(m.ownerId, siege, lootStr);
  void core.pushSiege(defenderId, siege, lootStr);
}
