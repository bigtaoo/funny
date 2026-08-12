/**
 * Regression test for the 2026-08-12 "NPC 守军蓝图串味" fix (see pveUpgrades.ts's
 * buildSiegeGarrisonBlueprints doc comment for the full incident writeup, and
 * SLG_DESIGN_LOG.md for the design-level record).
 *
 * Bug: `engine/setup/preplaced.ts` built BOTH the attacker's pre-placed army (Bottom) and the
 * tile's NPC garrison (Top) from the exact same per-unitType blueprint table
 * (`state.unitBlueprints`), which `buildSiegeBlueprints` levels/equips/academy-buffs purely off the
 * ATTACKER's own cardInstances/equipmentInv/siegeAcademy — no "which side" concept. So leveling up
 * or equipping a card of the same unitType the tile's garrison also fields silently buffed that
 * garrison by the identical multiplier, eating into (or, in the real production case this was found
 * from, fully reversing) the attacker's intended advantage. Found while investigating a real
 * account's SLG occupy loss (zihao1, 2026-08-12) whose battle replay showed a win but whose recorded
 * settlement was a loss — traced to exactly this leak (a leveled/equipped "infantry" card fighting a
 * plain infantry NPC garrison).
 *
 * Fix: siege mode's `enemyWaveBlueprints` (previously only isolated for campaign's opt-in
 * `enemyScale`) is now UNCONDITIONALLY a clean, unbuffed clone for `mode==='siege'`
 * (buildSiegeGarrisonBlueprints), and `preplaced.ts`'s garrison (Top-side) block now constructs
 * units from that table instead of `state.unitBlueprints`. The attacker's own pre-placed army
 * (Bottom-side) is untouched and still reads the buffed table — this is by design.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createGameEngine } from '../GameEngine';
import { resolveBlueprints } from '../engine/setup/blueprints';
import { buildSiegeGarrisonBlueprints } from '../balance/pveUpgrades';
import { UNIT_MAX_LEVEL } from '../balance/progression';
import { UNIT_BLUEPRINTS, ATTACK_LANES, TOP_SPAWN_ROW } from '../config';
import { Side, UnitType } from '../types';
import type { GameConfig } from '../types';
import type { EngineCardInstance } from '../balance/equipment';
import type { LevelDefinition } from '../campaign/LevelDefinition';

/** A single max-level Infantry card, no equipment — enough to trigger the old leak (any level>0 buffs hp/attack). */
const LEVELED_INFANTRY_CARD: EngineCardInstance[] = [
  { id: 'card_infantry', defId: UnitType.Infantry, unitType: UnitType.Infantry, level: UNIT_MAX_LEVEL, gear: {} },
];

// ── Function-level guard (mirrors pvp_hardwall.test.ts's style): resolveBlueprints must give
//    siege's enemyWaveBlueprints a genuinely different, unbuffed object — never the attacker's table. ──

test('resolveBlueprints: siege mode enemyWaveBlueprints is isolated from the attacker\'s leveled cardInstances', () => {
  const config: GameConfig = {
    seed: 1,
    players: [{ id: 0 }, { id: 1 }],
    cardInstances: LEVELED_INFANTRY_CARD,
  };
  const { unitBlueprints, enemyWaveBlueprints } = resolveBlueprints(config, 'siege');

  // The attacker's own table DID get buffed by the level-9 card (sanity check the fixture is real).
  assert.ok(
    unitBlueprints[UnitType.Infantry].hp > UNIT_BLUEPRINTS[UnitType.Infantry].hp,
    'sanity: attacker unitBlueprints.infantry.hp should be buffed by the max-level card',
  );

  // The NPC/garrison-facing table must stay at plain baseline, regardless of the attacker's card.
  assert.equal(
    enemyWaveBlueprints[UnitType.Infantry].hp, UNIT_BLUEPRINTS[UnitType.Infantry].hp,
    'siege enemyWaveBlueprints.infantry.hp must NOT inherit the attacker\'s card-level buff',
  );
  assert.equal(
    enemyWaveBlueprints[UnitType.Infantry].attack, UNIT_BLUEPRINTS[UnitType.Infantry].attack,
    'siege enemyWaveBlueprints.infantry.attack must NOT inherit the attacker\'s card-level buff',
  );
  assert.notEqual(
    enemyWaveBlueprints, unitBlueprints,
    'siege enemyWaveBlueprints must be a distinct object from unitBlueprints, not a shared reference',
  );
});

test('resolveBlueprints: siege enemyWaveBlueprints ignores equipmentInv and siegeAcademy too', () => {
  const config: GameConfig = {
    seed: 2,
    players: [{ id: 0 }, { id: 1 }],
    cardInstances: LEVELED_INFANTRY_CARD,
    siegeAcademy: { hp: 0.5, damage: 0.5, siege: 0.5 },
  };
  const { enemyWaveBlueprints } = resolveBlueprints(config, 'siege');
  assert.equal(enemyWaveBlueprints[UnitType.Infantry].hp, UNIT_BLUEPRINTS[UnitType.Infantry].hp,
    'siegeAcademy must not leak into the NPC-facing table either');
});

test('buildSiegeGarrisonBlueprints: returns a plain clone equal to UNIT_BLUEPRINTS byte-for-byte', () => {
  const bp = buildSiegeGarrisonBlueprints();
  for (const ut of [UnitType.Infantry, UnitType.ShieldBearer, UnitType.Archer]) {
    assert.equal(bp[ut].hp, UNIT_BLUEPRINTS[ut].hp, `${ut}.hp`);
    assert.equal(bp[ut].attack, UNIT_BLUEPRINTS[ut].attack, `${ut}.attack`);
  }
  bp[UnitType.Infantry].hp = 99999;
  assert.equal(UNIT_BLUEPRINTS[UnitType.Infantry].hp, 60, 'must be an independent clone, not the shared constant');
});

// ── Integration-level guard: a real siege battle's constructed garrison Unit instance must carry
//    baseline stats even when the attacker fields a leveled card of the exact same unitType. ──

test('siege battle: garrison Unit of the same unitType as a leveled attacker card stays at baseline stats', () => {
  const col = ATTACK_LANES[0]!;
  const level: LevelDefinition = {
    id: 'test_garrison_blueprint_isolation',
    chapter: 0,
    seed: 21,
    objective: { kind: 'destroy_base' },
    waves: { entries: [] },
    battleTimeoutTicks: 100, // never actually reached — engine.step(0, []) alone is enough to spawn both armies
    attackerArmy: [{ unitType: UnitType.Infantry, col, row: TOP_SPAWN_ROW, initialHp: 60 }],
    garrison: [{ unitType: UnitType.Infantry, col, row: 16, initialHp: 60 }],
  };
  const config: GameConfig = {
    seed: 21, mode: 'siege', players: [{ id: 0 }, { id: 1 }], level,
    cardInstances: LEVELED_INFANTRY_CARD, // attacker's own max-level Infantry card
  };
  const engine = createGameEngine(config);
  engine.step(0, []);

  const units = [...engine.state.board.units.values()];
  const attackerUnit = units.find((u) => u.side === Side.Bottom && u.unitType === UnitType.Infantry);
  const garrisonUnit = units.find((u) => u.side === Side.Top && u.unitType === UnitType.Infantry);
  assert.ok(attackerUnit, 'attacker infantry unit was pre-placed');
  assert.ok(garrisonUnit, 'garrison infantry unit was pre-placed');

  // The attacker's own unit legitimately benefits from its owner's max-level card.
  assert.ok(
    attackerUnit!.maxHp > UNIT_BLUEPRINTS[UnitType.Infantry].hp,
    'attacker infantry maxHp should reflect the max-level card buff',
  );
  assert.ok(
    attackerUnit!.attack > UNIT_BLUEPRINTS[UnitType.Infantry].attack,
    'attacker infantry attack should reflect the max-level card buff',
  );

  // The NPC garrison of the SAME unitType must NOT have received that same buff.
  assert.equal(
    garrisonUnit!.maxHp, UNIT_BLUEPRINTS[UnitType.Infantry].hp,
    'garrison infantry maxHp must stay at baseline — this is the exact leak that caused the real occupy-loss incident',
  );
  assert.equal(
    garrisonUnit!.attack, UNIT_BLUEPRINTS[UnitType.Infantry].attack,
    'garrison infantry attack must stay at baseline',
  );
});
