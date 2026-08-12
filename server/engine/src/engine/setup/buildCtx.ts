// Build an EngineCtx from a GameConfig — orchestrates the setup/*.ts steps in the same
// order engine/base.ts's old constructor ran them. Order only matters for readability
// here: every PRNG each step touches (blueprint scaling has none; WaveDirector's
// seed^0x5A5A5A5A; drawPolicy's seed^0xC0FFEE00; AISystem's seed^0xA1A1A1A1; GameState's
// own card/timer/combat PRNGs) is independently seeded off `config.seed`, so no step
// observes another step's random draws — reordering them cannot change determinism.
import { GameState } from '../../GameState';
import { Prng } from '../../math/prng';
import { WaveDirector } from '../../campaign/WaveDirector';
import type { GameConfig } from '../../types';
import { createSystems, type EngineCtx } from '../ctx';
import { resolveBlueprints } from './blueprints';
import { applyBoardSetup } from './board';
import { createPreplacedEntities } from './preplaced';
import { applyPveDrawPolicy, applyPvpDeckPolicy } from './drawPolicy';

export function buildEngineCtx(config: GameConfig): EngineCtx {
  const state = new GameState(config.seed);
  const systems = createSystems(config.seed, config.difficulty);
  const mode = config.mode ?? 'pvp';

  // PvE-shaped modes: scripted enemy (WaveDirector) + upgrade-buffed blueprints. `campaign`
  // (single-player PvE) and `siege` (SLG siege battle, S8-3) share the same mechanics; they
  // differ only in which builder injects the upgrade levels.
  const pve = mode === 'campaign' || mode === 'siege';

  const { unitBlueprints, enemyWaveBlueprints } = resolveBlueprints(config, mode);
  state.unitBlueprints = unitBlueprints;

  if (!pve) {
    applyPvpDeckPolicy(state, config);
    return {
      state, systems, mode,
      level: null, waveDirector: null, enemyWaveBlueprints,
      initialSpellCards: [], garrisonUnits: [], attackerArmyUnits: [], defenderBuildingList: [],
    };
  }

  if (!config.level) throw new Error(`${mode} mode requires a level definition`);
  const level = config.level;
  const waveDirector = new WaveDirector(level, new Prng(config.seed ^ 0x5A5A5A5A));

  applyBoardSetup(state, level);
  const { garrisonUnits, attackerArmyUnits, defenderBuildingList } =
    createPreplacedEntities(state, level, enemyWaveBlueprints);
  const initialSpellCards = applyPveDrawPolicy(state, level, config.seed);

  return {
    state, systems, mode, level, waveDirector, enemyWaveBlueprints,
    initialSpellCards, garrisonUnits, attackerArmyUnits, defenderBuildingList,
  };
}
