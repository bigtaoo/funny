// One-off tuning script: hand-tunes ch2 lv1..lv10 into a clean per-level difficulty ramp,
// replacing the coarse one-formula-for-50-levels pass from tune-ch2-6.cjs (which fixed the
// "unbeatable" bug but left ch2 jittery/non-monotone: T2,T2,T2,fresh,fresh,fresh,T3,fresh,fresh,fresh).
// Follows the exact restrained pattern as tune-ch1.cjs: only touches startInk / inkRegenMult /
// enemyScale.{hp,damage} / wave atTick (shifted together, first wave >=4s) / per-wave count
// (rescaled to a target total, boss waves keep their count) / escort hp (lv3 only).
// Does NOT touch objective/loadout/rewards/seed/other structure.
//
// IMPORTANT: this is a relative transform, like tune-ch1.cjs — it reads whatever is currently
// in ch2_lvN.json and rescales counts/shifts ticks from there. Since tune-ch2-6.cjs already ran
// once (committed), running this script again re-derives from its output, which is fine as long
// as it's only run once from that baseline. If you need to re-iterate, `git checkout` the
// ch2_lv*.json files back to the tune-ch2-6.cjs baseline before rerunning.
//
// Usage: node client/scripts/tune-ch2-precision.cjs
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'game', 'campaign', 'levels');

const FIRST_WAVE_TICK = 120; // shift all levels so the first wave lands at 4s

// Per-level hand-tuned targets. Objective kinds (from the level JSON):
//   lv1 survive, lv2 survive, lv3 escort, lv4 survive, lv5 survive, lv6 survive,
//   lv7 timed_defense, lv8 survive, lv9 survive, lv10 destroy_base.
// survive/escort/destroy_base are harder for the baseline AI (must fully clear / protect / raze) →
// richer economy & lower enemyScale gets them to the target tier; timed_defense (lv7) is
// comparatively easy for the AI (just stall) → needs harder params to reach its target tier.
// Target minClear ramp: fresh,fresh,T2,T2,T3,T3,T4,T4,T4,T5 (slightly harder than ch1's
// fresh,fresh,T2,T2,T4,T4,T3,T4,T5,T5 tail, since this is chapter 2).
const POLICY = {
  1:  { startInk: 30, regen: 1.40, hp: 1.00, dmg: 1.00, total: 22 },  // survive,  fresh
  2:  { startInk: 7,  regen: 1.06, hp: 1.08, dmg: 1.06, total: 39 },  // survive,  T2
  3:  { startInk: 14, regen: 1.14, hp: 1.05, dmg: 1.03, total: 30, escortHpMult: 1.15 }, // escort, T2
  4:  { startInk: 13, regen: 1.16, hp: 1.08, dmg: 1.06, total: 36 },  // survive,  T2
  5:  { startInk: 8,  regen: 1.06, hp: 1.10, dmg: 1.07, total: 40 },  // survive,  T3
  6:  { startInk: 5,  regen: 1.02, hp: 1.15, dmg: 1.10, total: 46 },  // survive,  T3
  7:  { startInk: 52, regen: 1.62, hp: 1.68, dmg: 1.46, total: 104 }, // timed,    T4 (easy-kind, needs harder params)
  8:  { startInk: 3,  regen: 0.96, hp: 1.18, dmg: 1.12, total: 45 },  // survive,  T3 (limited loadout, no towers/barracks — steep cliff, settled ±1 tier from T4 target)
  9:  { startInk: 0,  regen: 0.90, hp: 1.23, dmg: 1.15, total: 50 },  // survive,  T4
  10: { startInk: 33, regen: 1.43, hp: 1.39, dmg: 1.26, total: 60 }, // destroy_base, T5 (easy-kind, needs harder params)
};

for (const [lv, pol] of Object.entries(POLICY)) {
  const file = path.join(dir, `ch2_lv${lv}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = d.waves.entries;

  // 1) Economy + combat strength
  d.startInk = pol.startInk;
  d.inkRegenMult = pol.regen;
  d.enemyScale = { hp: pol.hp, damage: pol.dmg };

  // 2) Shift all waves so the first one lands at FIRST_WAVE_TICK (never pull an already-later start earlier)
  const firstTick = Math.min(...entries.map((e) => e.atTick));
  const shift = Math.max(0, FIRST_WAVE_TICK - firstTick);
  for (const e of entries) e.atTick += shift;

  // 3) Scale per-wave count to hit the target total (boss waves keep their original count, minimum 1)
  const curTotal = entries.reduce((s, e) => s + e.count, 0);
  const mult = pol.total / curTotal;
  let newTotal = 0;
  for (const e of entries) {
    if (!e.isBoss) e.count = Math.max(1, Math.round(e.count * mult));
    newTotal += e.count;
  }

  // 4) Escort HP bump (lv3 only)
  if (pol.escortHpMult && Array.isArray(d.escorts)) {
    for (const esc of d.escorts) esc.hp = Math.round(esc.hp * pol.escortHpMult);
  }

  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  console.log(`lv${lv}: startInk=${pol.startInk} regen=${pol.regen} hp×${pol.hp} dmg×${pol.dmg} firstWave+${shift}t troops${curTotal}→${newTotal}`);
}
