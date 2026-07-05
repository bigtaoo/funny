// One-off precision tuning script: reparameterises ch3 lv1..lv10 for a clean, hand-tuned
// per-level difficulty ramp, replacing tune-ch2-6.cjs's coarse single-formula pass (which
// eliminated unbeatable levels but produced a jittery, non-monotonic minClear table).
// Follows the exact same restrained pattern as tune-ch1.cjs: only touches startInk /
// inkRegenMult / enemyScale.{hp,damage} / wave atTick (shifted together) / per-wave count
// (rescaled to a target total; boss waves keep their original count) / escort hp (lv4 only).
// Does NOT touch objective/loadout/rewards/seed/other structure.
//
// Usage: node client/scripts/tune-ch3-precision.cjs   (overwrites levels/ch3_lvN.json in place)
// IMPORTANT: this script applies relative transforms (wave shift, count rescale) — re-running
// it against an already-tuned file would double-shift/double-rescale. To stay idempotent across
// iteration, it always reads from a frozen baseline snapshot (the tune-ch2-6.cjs output, captured
// once into BASELINE_DIR below) rather than from the live levels/ directory.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'game', 'campaign', 'levels');
const BASELINE_DIR = 'C:\\Users\\TaoWang\\AppData\\Local\\Temp\\claude\\C--Users-TaoWang-Documents-funny\\b9309f27-93ca-4edd-9307-fdc146e4ed04\\scratchpad\\ch3_baseline';

const FIRST_WAVE_TICK = 120; // shift all levels so the first wave lands at 4s

// Per-level hand-tuned policy (like tune-ch1.cjs's POLICY table).
// Objective kinds: lv1/2/3/5/6/9 survive (hard for AI, must clear board) → richer economy;
// lv4 escort (hard, also gets escort HP buffer); lv7 timed_defense, lv8 leak_limit, lv10 boss
// (all easier for the AI to stall through) → harder params needed to hit the same target tier.
// Target minClear ramp: fresh,T2,T2,T3,T3,T4,T4,T4,T5,T5 (slightly harder than ch2's
// fresh,fresh,T2,T2,T3,T3,T4,T4,T4,T5). Converged result (see DIFFICULTY_SIM.md ch3 section):
// fresh,T2,T2,T3,T3,T4,T3,T5,T5,T5 — lv7 (timed_defense) proved unusually resistant to
// enemyScale/total-count knobs (waves fit inside the 60s duration with room to spare, so once
// the AI survives to durationTicks it wins regardless of remaining unspawned enemies) and only
// moved once startInk/regen were pushed below the "fresh" baseline itself; even then it landed
// one tier below target (T3 not T4) — a deliberate, ai-limitation-driven deviation, not further
// forced to avoid over-cranking enemyScale into unrealistic territory. lv8 (leak_limit)
// similarly proved cliff-like near its tier boundary and settled one tier above target (T5 not
// T4) rather than risk flipping to "unbeatable" on a knob nudge.
const POLICY = {
  1:  { startInk: 34, regen: 1.55, hp: 1.00, dmg: 1.00, total: 26 }, // survive, fresh
  2:  { startInk: 26, regen: 1.42, hp: 1.02, dmg: 1.01, total: 30 }, // survive, T2
  3:  { startInk: 2,  regen: 1.02, hp: 1.10, dmg: 1.08, total: 52 }, // survive, T2
  4:  { startInk: 24, regen: 1.36, hp: 1.04, dmg: 1.03, total: 36, escortHpMult: 1.28 }, // escort, T3
  5:  { startInk: 10, regen: 1.14, hp: 1.07, dmg: 1.05, total: 46 }, // survive, T3
  6:  { startInk: 5,  regen: 1.04, hp: 1.105, dmg: 1.085, total: 50 }, // survive, T4
  7:  { startInk: 0,  regen: 0.80, hp: 1.48, dmg: 1.38, total: 145 }, // timed,  T4 (easier kind, much harder params)
  8:  { startInk: 30, regen: 1.37, hp: 1.065, dmg: 1.045, total: 37 }, // leak,   T4 (easier kind, harder params)
  9:  { startInk: 22, regen: 1.30, hp: 1.10, dmg: 1.07, total: 50 }, // survive, T5
  10: { startInk: 8,  regen: 1.10, hp: 1.14, dmg: 1.10, total: 52 }, // boss,   T5 (easier kind, harder params)
};

for (const [lv, pol] of Object.entries(POLICY)) {
  const file = path.join(dir, `ch3_lv${lv}.json`);
  const baselineFile = path.join(BASELINE_DIR, `ch3_lv${lv}.json`);
  const d = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const entries = d.waves.entries;

  // 1) Economy + combat strength
  d.startInk = pol.startInk;
  d.inkRegenMult = pol.regen;
  d.enemyScale = { hp: pol.hp, damage: pol.dmg };

  // 2) Shift all waves so the first one lands at FIRST_WAVE_TICK (never pull an earlier tick later
  //    than necessary — clamp shift to >= 0)
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

  // 4) Escort HP buffer (lv4 only)
  if (pol.escortHpMult && Array.isArray(d.escorts)) {
    for (const esc of d.escorts) esc.hp = Math.round(esc.hp * pol.escortHpMult);
  }

  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  console.log(`lv${lv}: startInk=${pol.startInk} regen=${pol.regen} hp×${pol.hp} dmg×${pol.dmg} firstWave+${shift}t troops${curTotal}→${newTotal}`);
}
