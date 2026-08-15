/**
 * Player.ts branch coverage gaps: canUpgradeBase / nextUpgradeCost / upgradeBase's
 * "already at max upgrade level" false-return branches, plus upgradeBase's "not enough
 * ink" false-return branch — none of BASE_UPGRADE_COSTS.length's boundary conditions
 * were exercised by any existing test (all prior upgradeBase() calls succeeded).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Player } from '../Player';
import { Prng } from '../math/prng';
import { BASE_UPGRADE_COSTS } from '../config';
import { toFp } from '../math/fixed';
import { Side } from '../types';

function makePlayer(): Player {
  return new Player(Side.Bottom, new Prng(1), new Prng(2));
}

test('canUpgradeBase/nextUpgradeCost/upgradeBase all report "maxed" once upgradeLevel reaches BASE_UPGRADE_COSTS.length', () => {
  const player = makePlayer();
  player.upgradeLevel = BASE_UPGRADE_COSTS.length; // already at the max tier
  player.addInkFp(toFp(9999)); // plenty of ink — isolates the "maxed" branch from the "can't afford" one

  assert.equal(player.canUpgradeBase(), false, 'maxed out → cannot upgrade regardless of ink');
  assert.equal(player.nextUpgradeCost, null, 'maxed out → no next cost');
  assert.equal(player.upgradeBase(), false, 'maxed out → upgradeBase is a no-op');
  assert.equal(player.upgradeLevel, BASE_UPGRADE_COSTS.length, 'upgradeLevel unchanged');
});

test('upgradeBase fails and spends no ink when the player cannot afford the next tier', () => {
  const player = makePlayer();
  // upgradeLevel 0 by default; ink starts at 0 — cost BASE_UPGRADE_COSTS[0] is unaffordable.
  const inkBefore = player.ink;

  assert.equal(player.canUpgradeBase(), false, 'not enough ink');
  assert.equal(player.upgradeBase(), false, 'spendInk fails inside upgradeBase → false, no state change');
  assert.equal(player.ink, inkBefore, 'ink untouched on a failed upgrade');
  assert.equal(player.upgradeLevel, 0, 'upgradeLevel untouched on a failed upgrade');
});

test('upgradeBase succeeds and advances upgradeLevel when affordable (regression control)', () => {
  const player = makePlayer();
  player.addInkFp(toFp(BASE_UPGRADE_COSTS[0]!));

  assert.equal(player.canUpgradeBase(), true);
  assert.equal(player.upgradeBase(), true);
  assert.equal(player.upgradeLevel, 1);
});
