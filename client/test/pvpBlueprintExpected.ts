// Shared test helper: the blueprint set the PvP path is EXPECTED to produce.
//
// The ladder hard wall (META_DESIGN §5.2 / §6.1) forbids SaveData-derived power —
// PvE upgrades, unit levels, equipment — from leaking into PvP. It does NOT forbid
// fixed, save-independent PvP-only stat overrides. PVP_LOADOUT_DESIGN §5 adds exactly
// one such override (the Medic token melee attack), applied in buildPvpBlueprints().
//
// Hard-wall tests therefore compare buildPvpBlueprints() against THIS expectation,
// not raw UNIT_BLUEPRINTS. The override values are hardcoded here (not re-derived from
// buildPvpBlueprints) so the comparison stays an independent guard rather than a tautology.
import { UNIT_BLUEPRINTS } from '../src/game/config';
import { UnitType } from '../src/game/types';

/** UNIT_BLUEPRINTS plus the documented static PvP overrides (PVP_LOADOUT_DESIGN §5). */
export function pvpExpectedBlueprints(): typeof UNIT_BLUEPRINTS {
  const exp = JSON.parse(JSON.stringify(UNIT_BLUEPRINTS)) as typeof UNIT_BLUEPRINTS;
  // Medic PvP override (P4-finalized): token melee poke so it is not a 0-attack dead card.
  exp[UnitType.Medic].attack = 4;
  exp[UnitType.Medic].attackInterval = 1.2;
  exp[UnitType.Medic].range = 1;
  return exp;
}
