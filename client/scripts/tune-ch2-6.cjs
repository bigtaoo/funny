// One-off tuning script: gives ch2-ch6 (minus already-working levels) the economy
// on-ramp ch1 got from tune-ch1.cjs. Root cause found via difficulty sim + diag trace
// (2026-07-05): every ch2-ch6 level ships with startInk=0/inkRegenMult=1 (defaults) while
// raw enemy troop totals were authored up to 3x ch1's ceiling — an economy that was never
// revisited after wave counts got scaled up. Escort levels die the same way: not chip damage
// over the whole transit, but ink-starvation leaves no defenders once the escort wanders deep
// into contested territory during a late wave (see DIFFICULTY_SIM.md diag trace).
//
// Preserves objective/loadout/rewards/seed/wave structure; only changes:
//   startInk / inkRegenMult / enemyScale / first-wave atTick (>=4s placement window) /
//   per-wave count (scaled down to a saner target total) / escort hp (+25%, escort levels only).
// Usage: node client/scripts/tune-ch2-6.cjs   (overwrites the listed level JSONs in place)
// Coefficients are in POLICY_FN; iterate and calibrate with `npx vitest run difficulty -t report`.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'game', 'campaign', 'levels');

const FIRST_WAVE_TICK = 120; // shift so the first wave lands at 4s

// Levels already on a reasonable curve (per 2026-07-05 report) — left untouched.
const SKIP = new Set([
  'ch2_lv2', 'ch2_lv7',
  'ch3_lv7',
  'ch4_lv7',
  'ch5_lv9', 'ch5_lv10',
  'ch6_lv2',
]);

const CHAPTERS = [2, 3, 4, 5, 6];
const LEVELS_PER_CHAPTER = 10;
const TOTAL_SLOTS = CHAPTERS.length * LEVELS_PER_CHAPTER; // 50, p in [0,1) across ch2_lv1..ch6_lv10

// survive-kind levels are hardest for the baseline AI (must clear the board) → richer economy /
// gentler enemyScale; timed_defense/boss/destroy_base/leak_limit are comparatively easier to
// stall out → same treatment but slightly less generous, matching the ch1 POLICY philosophy.
function policyFor(chapter, level, kind) {
  const slot = (chapter - 2) * LEVELS_PER_CHAPTER + (level - 1);
  const p = slot / (TOTAL_SLOTS - 1); // 0..1 across the whole ch2-ch6 span
  const hard = kind === 'survive' || kind === 'destroy_base' || kind === 'escort';

  const startInk = Math.round((hard ? 26 : 16) + p * (hard ? 20 : 18));
  const regen = +((hard ? 1.35 : 1.25) + p * (hard ? 0.35 : 0.30)).toFixed(2);
  const hpScale = +(1.0 + p * 0.15).toFixed(2);
  const dmgScale = +(1.0 + p * (hard ? 0.08 : 0.12)).toFixed(2);
  const total = Math.round(28 + p * 48); // 28 (ch2_lv1) .. 76 (ch6_lv10), well below raw authored totals

  return { startInk, regen, hp: hpScale, dmg: dmgScale, total };
}

for (const chapter of CHAPTERS) {
  for (let level = 1; level <= LEVELS_PER_CHAPTER; level++) {
    const id = `ch${chapter}_lv${level}`;
    if (SKIP.has(id)) continue;
    const file = path.join(dir, `${id}.json`);
    if (!fs.existsSync(file)) continue;
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const kind = d.objective?.kind ?? 'survive';
    const pol = policyFor(chapter, level, kind);
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

    // 4) Escort levels: chip-damage-starved defenders die deep in enemy territory (diag'd on
    //    ch2_lv3) — the economy fix above is the main lever, but give a modest HP buffer too.
    if (kind === 'escort' && Array.isArray(d.escorts)) {
      for (const esc of d.escorts) esc.hp = Math.round(esc.hp * 1.25);
    }

    fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
    console.log(
      `${id} (${kind}): startInk=${pol.startInk} regen=${pol.regen} hp×${pol.hp} dmg×${pol.dmg} firstWave+${shift}t troops${curTotal}→${newTotal}`
    );
  }
}
