// One-off tuning script: precision-tunes ch6 (the campaign FINALE chapter) lv1..lv10
// for a clean, ~monotone per-level difficulty ramp, the same way tune-ch1.cjs hand-tuned
// ch1. tune-ch2-6.cjs already gave ch6 an economy on-ramp (no unbeatable levels) but used
// one coarse formula across all of ch2-ch6 — this replaces ch6's rows with a hand-picked
// per-level POLICY table so the chapter reads as the hardest in the game, ending on a
// genuine climactic T6 final boss.
//
// Preserves each level's objective/loadout/rewards/seed/wave structure; only changes:
//   startInk / inkRegenMult / enemyScale / wave atTick (shifted so the first wave is at 4s,
//   never pulled later than necessary) / per-wave count (scaled to the target total; boss
//   waves keep their original count).
// Usage: node client/scripts/tune-ch6-precision.cjs   (overwrites levels/ch6_lvN.json in place;
// run against the tune-ch2-6.cjs baseline captured in DIFFICULTY_SIM.md — it's a relative
// transform, so if you need to redo it from scratch, git checkout ch6_lv*.json to the
// tune-ch2-6.cjs baseline first.)
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'game', 'campaign', 'levels');

const FIRST_WAVE_TICK = 120; // shift so the first wave lands at 4s, giving a placement window

// Target minClear ramp: T3,T3,T4,T4,T5,T5,T5,T6,T6,T6 — harder overall than ch5
// (T2,T3,T3,T4,T4,T4,T5,T5,T5,T6), closing the campaign on a climactic T6 final boss.
// Objective kinds (from the current JSON):
//   lv1 survive, lv2 timed_defense, lv3 destroy_base, lv4 leak_limit, lv5 boss,
//   lv6 survive, lv7 survive, lv8 destroy_base, lv9 leak_limit, lv10 boss.
// survive/destroy_base are hardest for the AI (must clear the board) → richer economy;
// timed_defense/leak_limit/boss are comparatively easier to stall out → harder parameters
// (leaner economy / higher enemyScale / more troops) to compensate and keep the ramp legible.
const POLICY = {
  1:  { startInk: 46, regen: 1.68, hp: 1.11, dmg: 1.06, total: 60 },  // survive,        T3
  2:  { startInk: 14, regen: 1.16, hp: 1.32, dmg: 1.26, total: 205 }, // timed_defense,  T3
  3:  { startInk: 46, regen: 1.70, hp: 1.11, dmg: 1.06, total: 68 },  // destroy_base,   T4
  4:  { startInk: 40, regen: 1.62, hp: 1.13, dmg: 1.09, total: 72 },  // leak_limit,     T4
  5:  { startInk: 20, regen: 1.28, hp: 1.27, dmg: 1.21, total: 78 },  // boss,           T5
  6:  { startInk: 80, regen: 2.30, hp: 1.00, dmg: 0.96, total: 56 },  // survive,        T5
  7:  { startInk: 44, regen: 1.64, hp: 1.15, dmg: 1.10, total: 74 },  // survive,        T5
  8:  { startInk: 28, regen: 1.42, hp: 1.19, dmg: 1.14, total: 74 },  // destroy_base,   T6
  9:  { startInk: 26, regen: 1.36, hp: 1.24, dmg: 1.18, total: 80 },  // leak_limit,     T6
  10: { startInk: 32, regen: 1.46, hp: 1.20, dmg: 1.14, total: 80 },  // boss,           T6
};

for (const [lv, pol] of Object.entries(POLICY)) {
  const file = path.join(dir, `ch6_lv${lv}.json`);
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

  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  console.log(`ch6_lv${lv}: startInk=${pol.startInk} regen=${pol.regen} hp×${pol.hp} dmg×${pol.dmg} firstWave+${shift}t troops${curTotal}→${newTotal}`);
}
