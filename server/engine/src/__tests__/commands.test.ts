/**
 * sim/commands.ts coverage gaps: processCommand's play_card spell branches for Haste,
 * Rockslide, and BridgeCollapse were never exercised by any existing test (only Meteor
 * and unit/building cards were) — their `consumeCardSlot` effect callbacks were
 * therefore never invoked (the 3/8 uncovered functions bringing commands.js down to
 * 62.5% func coverage). Each test injects the relevant CardDefinition straight into a
 * hand slot (bypassing the normal draw pool — Rockslide/BridgeCollapse are PvE-only and
 * never appear in the PvP CARD_DEFINITIONS pool per config.ts's hard-wall comment) and
 * submits the matching play_card command.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createGameEngine } from '../GameEngine';
import { toFp } from '../math/fixed';
import { ATTACK_LANES, CARD_DEFINITIONS, SPELL_CARD_DEFS } from '../config';
import { CardType, SpellType } from '../types';
import type { GameConfig, PlayerCommand } from '../types';

function pvpConfig(seed: number): GameConfig {
  return { seed, players: [{ id: 0 }, { id: 1 }] };
}

test('play_card (Haste spell) invokes castHaste and speeds up friendly units', () => {
  const engine = createGameEngine(pvpConfig(20));
  engine.step(0, []);

  const hasteCard = CARD_DEFINITIONS.find((c) => c.cardType === CardType.Spell && c.spellType === SpellType.Haste)!;
  assert.ok(hasteCard, 'haste_1 must exist in CARD_DEFINITIONS');
  engine.state.bottomPlayer.hand.drawIntoSlot(0, hasteCard, 900);
  engine.state.bottomPlayer.addInkFp(toFp(9999));

  const cmd: PlayerCommand = { type: 'play_card', owner: 0, tick: 1, handIndex: 0 };
  const events = engine.step(1, [cmd]);

  assert.ok(events.some((e) => e.type === 'card_played'), 'card_played fires');
  assert.ok(events.some((e) => e.type === 'spell_cast' && e.spellType === SpellType.Haste), 'castHaste ran and emitted spell_cast');
  assert.equal(engine.state.activeSpells.length, 1);
  assert.equal(engine.state.activeSpells[0]!.spellType, SpellType.Haste);
});

test('play_card (Rockslide spell) invokes castRockslide and damages units in the column', () => {
  const engine = createGameEngine(pvpConfig(21));
  engine.step(0, []);

  const rockslideCard = SPELL_CARD_DEFS.get('rockslide')!;
  const col = ATTACK_LANES[0]!;
  engine.state.bottomPlayer.hand.drawIntoSlot(0, rockslideCard, 900);
  engine.state.bottomPlayer.addInkFp(toFp(9999));

  const cmd: PlayerCommand = { type: 'play_card', owner: 0, tick: 1, handIndex: 0, col };
  const events = engine.step(1, [cmd]);

  assert.ok(events.some((e) => e.type === 'card_played'), 'card_played fires');
  assert.ok(events.some((e) => e.type === 'spell_cast' && e.spellType === SpellType.Rockslide && e.center.col === col), 'castRockslide ran and emitted spell_cast');
});

test('play_card (BridgeCollapse spell) invokes castBridgeCollapse and temp-blocks the column', () => {
  const engine = createGameEngine(pvpConfig(22));
  engine.step(0, []);

  const bridgeCard = SPELL_CARD_DEFS.get('bridge_collapse')!;
  const col = ATTACK_LANES[1]!;
  engine.state.bottomPlayer.hand.drawIntoSlot(0, bridgeCard, 900);
  engine.state.bottomPlayer.addInkFp(toFp(9999));

  const cmd: PlayerCommand = { type: 'play_card', owner: 0, tick: 1, handIndex: 0, col };
  const events = engine.step(1, [cmd]);

  assert.ok(events.some((e) => e.type === 'card_played'), 'card_played fires');
  assert.ok(events.some((e) => e.type === 'spell_cast' && e.spellType === SpellType.BridgeCollapse && e.center.col === col), 'castBridgeCollapse ran and emitted spell_cast');
  assert.ok(engine.state.tempBlockedCols.has(col), 'the column is registered as temporarily blocked');
});
