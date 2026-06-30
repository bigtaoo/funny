// One-off tuning script: reparameterises ch1 lv2..lv10 for a smooth difficulty ramp.
// Preserves each level's objective/loadout/rewards/seed/wave structure; only changes:
//   startInk / inkRegenMult / enemyScale / wave atTick (shifted so the first wave is ≥4s) / per-wave count (scaled to the target total).
// Usage: node client/scripts/tune-ch1.cjs   (overwrites levels/ch1_lvN.json in place)
// Coefficients are in POLICY; iterate and calibrate with npx vitest run difficulty.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'game', 'campaign', 'levels');

const FIRST_WAVE_TICK = 120; // shift all levels so the first wave lands at 4s, giving a placement window

// Per-level targets (lv2..lv10). p=(i-2)/8 in [0,1] drives the ramp; hard-coded here for easy manual tuning.
// startInk/regen: economic on-ramp — more generous earlier; hp/dmg: slower combat power ramp; total: target enemy count.
// Note: survive levels (clear all enemies) are harder for the AI → more economy / lower HP multiplier;
//       timed_defense (2/6/9) and boss (10) are easier → harder parameters to compensate, keeping the ramp monotonic.
// Target minClear smooth ramp: fresh,fresh,T2,T2,T3,T3,T4,T4,T5,T5 (lv1..10).
// Survive levels (must clear) skew hard for the AI → rich economy / lower HP; timed (2/6/9) and boss (10) skew easy → harder parameters compensate.
const POLICY = {
  2:  { startInk: 24, regen: 1.30, hp: 1.00, dmg: 1.00, total: 30 }, // timed,  fresh
  3:  { startInk: 40, regen: 1.55, hp: 1.00, dmg: 1.00, total: 22 }, // survive, T2
  4:  { startInk: 36, regen: 1.50, hp: 1.02, dmg: 1.02, total: 24 }, // survive, T2
  5:  { startInk: 36, regen: 1.50, hp: 1.02, dmg: 1.02, total: 24 }, // survive, T3
  6:  { startInk: 18, regen: 1.25, hp: 1.08, dmg: 1.06, total: 46 }, // timed,  T3
  7:  { startInk: 30, regen: 1.42, hp: 1.06, dmg: 1.05, total: 30 }, // survive, T4
  8:  { startInk: 28, regen: 1.40, hp: 1.09, dmg: 1.06, total: 34 }, // survive, T4
  9:  { startInk: 18, regen: 1.25, hp: 1.12, dmg: 1.09, total: 50 }, // timed,  T5
  10: { startInk: 30, regen: 1.42, hp: 1.10, dmg: 1.08, total: 40 }, // boss,   T5
};

for (const [lv, pol] of Object.entries(POLICY)) {
  const file = path.join(dir, `ch1_lv${lv}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = d.waves.entries;

  // 1) Economy + combat strength
  d.startInk = pol.startInk;
  d.inkRegenMult = pol.regen;
  d.enemyScale = { hp: pol.hp, damage: pol.dmg };

  // 2) Shift all waves so the first one lands at FIRST_WAVE_TICK
  const firstTick = Math.min(...entries.map((e) => e.atTick));
  const shift = FIRST_WAVE_TICK - firstTick;
  for (const e of entries) e.atTick += shift;

  // 3) Scale per-wave count to hit the target total (boss waves keep their original count, minimum 1)
  const curTotal = entries.reduce((s, e) => s + e.count, 0);
  const mult = pol.total / curTotal;
  let newTotal = 0;
  for (const e of entries) {
    if (!e.isBoss) e.count = Math.max(1, Math.round(e.count * mult));
    newTotal += e.count;
  }

  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  console.log(`lv${lv}: startInk=${pol.startInk} regen=${pol.regen} hp×${pol.hp} dmg×${pol.dmg} firstWave+${shift}t troops${curTotal}→${newTotal}`);
}
