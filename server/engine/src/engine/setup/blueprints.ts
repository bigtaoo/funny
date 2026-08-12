// Resolve match blueprints from GameConfig — verbatim extract of engine/base.ts's old
// constructor (§5.2/§6.1 hard wall: this is the ONLY place PvE upgrades enter the
// engine; PvP/netplay always get the read-only constants).
import { buildPvpBlueprints, buildCampaignBlueprints, buildSiegeBlueprints, buildSiegeGarrisonBlueprints } from '../../balance/pveUpgrades';
import { toFp, mulFp, maxFp } from '../../math/fixed';
import type { GameConfig, GameMode, UnitBlueprint, UnitType } from '../../types';

export interface ResolvedBlueprints {
  unitBlueprints: Record<UnitType, UnitBlueprint>;
  /** Enemy (Top side) wave blueprints (§4.10) — see EngineCtx.enemyWaveBlueprints doc. */
  enemyWaveBlueprints: Record<UnitType, UnitBlueprint>;
}

export function resolveBlueprints(config: GameConfig, mode: GameMode): ResolvedBlueprints {
  const unitBlueprints =
    mode === 'campaign'
      ? buildCampaignBlueprints(config.cardInstances ?? [], config.equipmentInv)
      : mode === 'siege'
      ? buildSiegeBlueprints(config.cardInstances ?? [], config.equipmentInv, config.siegeAcademy)
      : buildPvpBlueprints();

  // By default enemies share the player's campaign blueprints. When a campaign level sets
  // `enemyScale`, wave enemies instead use a progression-free base set (so the player's own
  // unit levels/equipment/upgrades can't leak into same-type enemies — matters in ch2 where
  // the bot fields the player's ch1-leveled Tao units) multiplied by the per-level hp/damage
  // factors.
  let enemyWaveBlueprints = unitBlueprints;
  if (mode === 'siege') {
    // 2026-08-12 fix (see buildSiegeGarrisonBlueprints' doc comment): siege NEVER shares the
    // attacker-buffed `unitBlueprints` with the defending side, unconditionally — unlike campaign's
    // `enemyScale`, which is an opt-in per-level knob, siege has no equivalent "leave it shared" case;
    // the tile's garrison/NPC units must always read plain baseline stats, since a same-typed attacker
    // card would otherwise buff its own defender by construction (this is what preplaced.ts's Top-side
    // garrison block now consumes instead of `unitBlueprints`).
    enemyWaveBlueprints = buildSiegeGarrisonBlueprints();
  } else {
    const enemyScale = mode === 'campaign' ? config.level?.enemyScale : undefined;
    if (enemyScale) {
      const hpMult  = enemyScale.hp     ?? 1;
      const dmgMult = enemyScale.damage ?? 1;
      const scaled = buildPvpBlueprints();
      for (const key of Object.keys(scaled) as UnitType[]) {
        const bp = scaled[key];
        // ADR-065: hp_fp/attack_fp are fp; the "at least 1" floor is toFp(1) (1 real HP/attack
        // point), not the plain integer 1 — hpMult/dmgMult are one-off local ratios (never
        // persisted as fp), converted at this call site only.
        bp.hp_fp     = maxFp(toFp(1), mulFp(bp.hp_fp, toFp(hpMult)));
        bp.attack_fp = maxFp(toFp(1), mulFp(bp.attack_fp, toFp(dmgMult)));
      }
      enemyWaveBlueprints = scaled;
    }
  }

  return { unitBlueprints, enemyWaveBlueprints };
}
