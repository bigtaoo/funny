// One-off precision tuning script: replaces tune-ch2-6.cjs's coarse ch5 rows with hand-tuned
// per-level values, giving ch5_lv1..lv10 a clean, ~monotone minClear ladder (same pattern as
// tune-ch1.cjs's POLICY table). Preserves each level's objective/loadout/rewards/seed/wave
// structure; only changes: startInk / inkRegenMult / enemyScale / wave atTick (shifted so the
// first wave lands at 4s) / per-wave count (rescaled to the target total; boss waves keep
// their original count).
//
// ch5_lv8 special case (root-caused 2026-07-05 via test/_diag_ch5lv8.test.ts, deleted after use):
// the T3-clear/T4-T5-regress anomaly is NOT an economy/knob problem — it's an engine-level trap.
// UnitType.Harpy is `flying: true`; only arrow towers (`canTargetFlying: true`) can kill it —
// ground melee/ranged units (including archers/Mara) cannot, per `canTargetFlying` filtering in
// CombatSystem.findTarget. But the baseline AI reactively garrisons ANY threatened lane with a
// ground unit (`pickUnderBlockedLane` in difficultySim.ts) the moment a harpy is detected, before
// a tower ever gets built/positioned in range. The harpy then attacks that ground defender (which
// cannot hit back) and enters UnitState.Attacking, which halts its movement (MovementSystem.tick
// skips Attacking units) — so it never advances into an arrow tower's row-0-range-2 kill zone.
// Because the AI keeps re-reinforcing that "still under threat" lane, allies pile up (observed
// 3 -> 11 units in one lane over ~50s) forever without resolving, starving ink from clearing the
// rest of the board. This is a permanent stalemate (`survive` requires waveDirector.exhausted &&
// !hasLivingEnemyUnits(), and a parked-forever harpy blocks that indefinitely), not a "too hard"
// problem — no amount of startInk/regen/enemyScale tuning fixes an unkillable unit. avoid fighting
// this: reduce harpy from 2/lane to 1/lane (halves the chance a seed's pathing produces the trap),
// similarly trim `splitter` (dies-into-2-runners on non-AOE kill, compounds board bloat — and
// meteor is banned on this level, so the AI's only anti-splitter AOE tool is gone) to 1/lane, and
// lean harder on the economy knob (rich startInk/regen) so that on the seeds where the AI DOES
// avoid/resolve the trap quickly, it clears the rest of the board well inside the sim's tick
// budget. Residual variance from the harpy behavior is accepted as a documented deviation (see
// DIFFICULTY_SIM.md) rather than cranked away with ever-larger numbers.
//
// Usage: node client/scripts/tune-ch5-precision.cjs   (overwrites ch5_lv{1..10}.json in place)
// Iterate with the throwaway test/_tune_ch5.test.ts (see task instructions), not the full
// `npx vitest run difficulty` suite (evaluates all 61 levels, slow).
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'game', 'campaign', 'levels');

const FIRST_WAVE_TICK = 120; // shift so the first wave lands at 4s, giving a placement window

// Per-level hand-tuned knobs. Objective kinds (harder for the AI get richer economy / gentler
// enemyScale; easier-for-AI kinds get harder params to compensate, same philosophy as ch1):
//   lv1 survive, lv2 survive, lv3 survive, lv4 survive, lv5 escort, lv6 destroy_base,
//   lv7 leak_limit, lv8 survive (+ harpy/splitter trim, see header note), lv9 timed_defense, lv10 boss.
// Target minClear ramp: T2,T3,T3,T4,T4,T4,T5,T5,T5,T6 (guidance, small deviations OK).
// Comment = observed minClear (5-seed median/winRate>=50%) after calibration, not aspirational —
// see DIFFICULTY_SIM.md for the final table. Target ramp was T2,T3,T3,T4,T4,T4,T5,T5,T5,T6;
// actual result T2,T2,T4,T5,T4,T5,T5,T4,T5,T6 — legible increasing trend with ±1-tier jitter
// (lv2 pinned at T2 despite retuning: survive-kind noise right at the T2/T3 boundary, same class
// of jitter ch1's own POLICY table calls out as acceptable; lv3/lv5/lv8 sit at T4 rather than a
// strict T3/T4/T5 staircase for the same reason — see report for full justification per level).
const POLICY = {
  1:  { startInk: 22, regen: 1.20, hp: 1.04, dmg: 1.03, total: 42 },  // survive,      T2
  2:  { startInk: 25, regen: 1.30, hp: 1.06, dmg: 1.05, total: 50 },  // survive,      T2 (target T3, boundary noise)
  3:  { startInk: 32, regen: 1.36, hp: 1.07, dmg: 1.06, total: 52 },  // survive,      T4
  4:  { startInk: 28, regen: 1.34, hp: 1.09, dmg: 1.07, total: 56 },  // survive,      T5
  5:  { startInk: 24, regen: 1.30, hp: 1.09, dmg: 1.07, total: 54, escortHpMult: 1.15 }, // escort, T4
  6:  { startInk: 16, regen: 1.18, hp: 1.11, dmg: 1.08, total: 62 },  // destroy_base, T5
  7:  { startInk: 22, regen: 1.26, hp: 1.11, dmg: 1.11, total: 58 },  // leak_limit,   T5
  8:  { startInk: 58, regen: 1.80, hp: 1.08, dmg: 1.04, total: null, trim: 0.82, capUnits: { harpy: 1, splitter: 1 } }, // survive, T4 (harpy trap, see header)
  9:  { startInk: 0,  regen: 0.58, hp: 1.26, dmg: 1.22, total: 118 },  // timed,        T5
  10: { startInk: 0,  regen: 0.55, hp: 1.19, dmg: 1.16, total: 82 },  // boss,         T6
};

for (const [lv, pol] of Object.entries(POLICY)) {
  const file = path.join(dir, `ch5_lv${lv}.json`);
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

  // 3) Scale per-wave count.
  const curTotal = entries.reduce((s, e) => s + e.count, 0);
  if (pol.total != null) {
    // Standard path: scale proportionally to hit an explicit target total (boss waves keep count).
    const mult = pol.total / curTotal;
    let newTotal = 0;
    for (const e of entries) {
      if (!e.isBoss) e.count = Math.max(1, Math.round(e.count * mult));
      newTotal += e.count;
    }
    console.log(`lv${lv}: startInk=${pol.startInk} regen=${pol.regen} hp×${pol.hp} dmg×${pol.dmg} firstWave+${shift}t troops${curTotal}→${newTotal}`);
  } else {
    // lv8 path: flat proportional trim (`pol.trim`) plus hard per-unit-type caps
    // (`pol.capUnits`) for the harpy/splitter stalemate mitigation (see header note).
    let newTotal = 0;
    for (const e of entries) {
      if (e.isBoss) { newTotal += e.count; continue; }
      const cap = pol.capUnits && pol.capUnits[e.unitType];
      e.count = cap != null ? cap : Math.max(1, Math.round(e.count * pol.trim));
      newTotal += e.count;
    }
    console.log(`lv${lv}: startInk=${pol.startInk} regen=${pol.regen} hp×${pol.hp} dmg×${pol.dmg} firstWave+${shift}t troops${curTotal}→${newTotal} (trim=${pol.trim}, capUnits=${JSON.stringify(pol.capUnits)})`);
  }

  // 4) Escort levels: bump escort HP (mirrors tune-ch2-6.cjs's escort fix).
  if (pol.escortHpMult && Array.isArray(d.escorts)) {
    for (const esc of d.escorts) esc.hp = Math.round(esc.hp * pol.escortHpMult);
  }

  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
}
