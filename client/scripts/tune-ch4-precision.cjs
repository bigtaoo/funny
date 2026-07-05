// One-off tuning script: reparameterises ch4 lv1..lv10 for a smooth difficulty ramp,
// replacing tune-ch2-6.cjs's coarse one-formula pass (which left ch4 unbeatable-free but jittery,
// e.g. lv7 clearing easiest at `fresh` mid-chapter). Preserves each level's
// objective/loadout/rewards/seed/wave structure; only changes:
//   startInk / inkRegenMult / enemyScale / wave atTick (shifted so the first wave lands at 4s) /
//   per-wave count (scaled to the target total, boss waves keep their original count).
// Usage: node scripts/tune-ch4-precision.cjs   (overwrites levels/ch4_lvN.json in place)
// IMPORTANT: transforms are relative to CURRENT file contents (proportional rescale + relative
// tick shift) — to retune from scratch, `git checkout -- src/game/campaign/levels/ch4_lv*.json`
// first to restore the tune-ch2-6.cjs baseline, then rerun with new POLICY values.
// Coefficients are in POLICY; iterate and calibrate with the throwaway _tune_ch4.test.ts.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'game', 'campaign', 'levels');

const FIRST_WAVE_TICK = 120; // shift all levels so the first wave lands at 4s, giving a placement window

// Target minClear ramp: T2,T2,T3,T3,T4,T4,T4,T5,T5,T5 (lv1..10) — ch4 should read harder than ch3
// (fresh,T2,T2,T3,T3,T4,T4,T4,T5,T5). Objective kinds:
//   lv1-6,9 survive (hardest for the AI, must fully clear) → richer economy / gentler enemyScale;
//   lv7 timed_defense, lv8 leak_limit, lv10 boss (easier for the AI) → harder parameters to
//   compensate, keeping the per-level ladder legible instead of these dipping ahead of the curve.
const POLICY = {
  1:  { startInk: 22, regen: 1.28, hp: 1.03, dmg: 1.02, total: 36 },  // survive, T2
  2:  { startInk: 20, regen: 1.26, hp: 1.04, dmg: 1.03, total: 38 },  // survive, T2
  3:  { startInk: 28, regen: 1.34, hp: 1.03, dmg: 1.02, total: 38 },  // survive, T3 (was landing at T4 — eased economy/hp a bit more)
  4:  { startInk: 16, regen: 1.20, hp: 1.06, dmg: 1.05, total: 43 },  // survive, T3 (was too easy at fresh — trimmed economy)
  5:  { startInk: 6,  regen: 1.10, hp: 1.10, dmg: 1.07, total: 47 },  // survive, T4 (was landing at T3 — tightened economy)
  6:  { startInk: 10, regen: 1.14, hp: 1.09, dmg: 1.06, total: 48 },  // survive, T4
  7:  { startInk: 0,  regen: 0.85, hp: 1.45, dmg: 1.35, total: 120 },  // timed,   T4 (easy-kind: crush economy hard, was way too easy)
  8:  { startInk: 40, regen: 1.48, hp: 1.02, dmg: 1.02, total: 46 },  // leak,    T5 (was T6 — economy still too thin, eased further)
  9:  { startInk: 16, regen: 1.18, hp: 1.08, dmg: 1.06, total: 58 },  // survive, T5 (was unbeatable — economy was too thin)
  10: { startInk: 0,  regen: 0.75, hp: 1.35, dmg: 1.28, total: 68 },  // boss,    T5 (easy-kind: crush economy hard, was still too easy at T3)
};

for (const [lv, pol] of Object.entries(POLICY)) {
  const file = path.join(dir, `ch4_lv${lv}.json`);
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
