// ─────────────────────────────────────────────────────────────────────────────
// Stronghold/crossing combat-power runner (SLG_ECONOMY_CHECK §21.4 follow-up, 2026-07-16;
// re-written 2026-07-27 to drop hardcoded threshold-sweep strings AND to correctly mirror worldsvc's
// shouldUseCheapSiege dispatch — see strongholdCombat.ts's "IMPORTANT CORRECTION" header for the full incident).
//   npx tsx src/strongholdCombatRun.ts
// Answers: "is STRONGHOLD_GARRISON_PER_LEVEL / CROSSING_GARRISON_PER_LEVEL actually beatable, and by whom?"
// by reproducing worldsvc's actual dispatch decision (real engine vs. cheap linear resolveSiege — see
// strongholdCombat.ts header for why + for the important caveat about why unit-level progression is not
// the tested axis).
//
// 2026-07-27: the previous version of this script printed the *2026-07-16* threshold sweep as a hardcoded
// string ("1500→4000 all 0%, flips to 100% at 4500+..."). ADR-048 then changed TROOP_CAP_BASE from 2000 to
// 10000, silently invalidating that frozen text while the script kept printing it as if still true — exactly
// the kind of staleness this file is supposed to catch (see ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD.5).
// Every number below is now live-computed from the current @nw/shared constants; there should be nothing left
// to manually update here when TROOP_CAP_BASE / DRILL_TROOPCAP_STEP change again. A same-day follow-up fix
// then found that strongholdCombat.ts was ALSO missing worldsvc's shouldUseCheapSiege mirror (added since);
// this script's printed garrison values and caveat text below reflect that correction.
// ─────────────────────────────────────────────────────────────────────────────

import {
  STRONGHOLD_LEVEL,
  CROSSING_LEVEL,
  STRONGHOLD_GARRISON,
  CROSSING_GARRISON,
  SCENARIO_BASE,
  SCENARIO_INVESTED,
  winRateOver,
  type ProgressionScenario,
} from './strongholdCombat';
import { TROOP_CAP_BASE, DRILL_TROOPCAP_STEP } from '@nw/shared';

function bar(s: string) { console.log('═'.repeat(78)); console.log(s); console.log('═'.repeat(78)); }
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

bar('SLG stronghold/crossing combat-power calibration (SLG_ECONOMY_CHECK §21.4 follow-up)');
console.log(`Stronghold: level ${STRONGHOLD_LEVEL} (always map-max) → NPC garrison = ${STRONGHOLD_GARRISON} troops`);
console.log(`Crossing:   level ${CROSSING_LEVEL} (always max(2,mapMax-1)) → NPC garrison = ${CROSSING_GARRISON} troops`);
console.log('Dispatch: mirrors worldsvc\'s shouldUseCheapSiege — real @nw/engine auto-battle when neither side would overflow');
console.log('  board capacity, else the cheap linear resolveSiege (attacker wins iff troops > garrison), worldsvc\'s actual production path.');
console.log('Tested axis: troop count only (see strongholdCombat.ts header for why unit level is not a differentiating lever here).');
console.log(`TROOP_CAP_BASE=${TROOP_CAP_BASE}, DRILL_TROOPCAP_STEP=${DRILL_TROOPCAP_STEP} (live import — this script never needs manual number edits when the baseline moves).\n`);

const SEEDS = Array.from({ length: 20 }, (_, i) => i * 7919 + 11); // 20 distinct deterministic seeds

/** Live drillYard-level win-rate table for a garrison, replacing any hardcoded "troops step N" sweep text
 *  (those go stale silently the moment TROOP_CAP_BASE changes — see the 2026-07-27 incident this script
 *  itself was rewritten for). Always recomputed from the current live constants. */
function levelTable(garrison: number, level: number, maxLevels: number): { level: number; troops: number; winRate: number }[] {
  const rows: { level: number; troops: number; winRate: number }[] = [];
  for (let n = 0; n <= maxLevels; n++) {
    const troops = TROOP_CAP_BASE + n * DRILL_TROOPCAP_STEP;
    const { winRate } = winRateOver(garrison, level, { label: `drillYard+${n}`, troops }, SEEDS);
    rows.push({ level: n, troops, winRate });
  }
  return rows;
}
function printLevelTable(rows: { level: number; troops: number; winRate: number }[]): void {
  for (const r of rows) console.log(`  drillYard+${r.level} (troops=${r.troops})\t\twin-rate ${pct(r.winRate)}`);
}
/** First drillYard level (0..maxLevels) whose win-rate crosses `threshold`, or -1 if none do. */
function firstWinningLevel(rows: { level: number; winRate: number }[], threshold = 0.9): number {
  const hit = rows.find((r) => r.winRate >= threshold);
  return hit ? hit.level : -1;
}

// ── Stronghold: fresh vs invested, plus a live per-level table that locates the gate (no hardcoded numbers) ──
console.log(`── STRONGHOLD (garrison=${STRONGHOLD_GARRISON}) ──`);
const shBase = winRateOver(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, SCENARIO_BASE, SEEDS);
const shInvested = winRateOver(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, SCENARIO_INVESTED, SEEDS);
console.log(`  ${SCENARIO_BASE.label.padEnd(35)}  win-rate ${pct(shBase.winRate)}`);
console.log(`  ${SCENARIO_INVESTED.label.padEnd(35)}  win-rate ${pct(shInvested.winRate)}  (avg survivors ${shInvested.avgAttackerSurvivors.toFixed(0)})`);
const shTable = levelTable(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, 4);
console.log('  Live per-drillYard-level sweep:');
printLevelTable(shTable);
const shOpensAt = firstWinningLevel(shTable);
const shGateOk = shBase.winRate === 0 && shInvested.winRate >= 0.9;
console.log(`  [${shGateOk ? 'PASS' : 'FAIL'}] fresh loses outright AND opens by drillYard+${shOpensAt >= 0 ? shOpensAt : '?'}\n`);

// ── Crossing: same shape, lighter garrison → should open with less investment than stronghold ──
console.log(`── CROSSING (garrison=${CROSSING_GARRISON}) ──`);
const crBase = winRateOver(CROSSING_GARRISON, CROSSING_LEVEL, SCENARIO_BASE, SEEDS);
const crInvested1: ProgressionScenario = { label: `invested (troopCap=${TROOP_CAP_BASE + DRILL_TROOPCAP_STEP}, drillYard+1)`, troops: TROOP_CAP_BASE + DRILL_TROOPCAP_STEP };
const crInvested = winRateOver(CROSSING_GARRISON, CROSSING_LEVEL, crInvested1, SEEDS);
console.log(`  ${SCENARIO_BASE.label.padEnd(35)}  win-rate ${pct(crBase.winRate)}`);
console.log(`  ${crInvested1.label.padEnd(35)}  win-rate ${pct(crInvested.winRate)}`);
const crTable = levelTable(CROSSING_GARRISON, CROSSING_LEVEL, 4);
console.log('  Live per-drillYard-level sweep:');
printLevelTable(crTable);
const crOpensAt = firstWinningLevel(crTable);
const crGateOk = crBase.winRate === 0 && crInvested.winRate >= 0.9;
console.log(`  [${crGateOk ? 'PASS' : 'FAIL'}] fresh loses outright AND opens by drillYard+${crOpensAt >= 0 ? crOpensAt : '?'} (lighter than stronghold's +${shOpensAt >= 0 ? shOpensAt : '?'})\n`);

// ── Verdict ──────────────────────────────────────────────────────────────────
bar('VERDICT');
console.log(`STRONGHOLD_GARRISON_PER_LEVEL=1180 (→ ${STRONGHOLD_GARRISON} @ level ${STRONGHOLD_LEVEL}): ${shGateOk ? '✅ PASS' : '❌ FAIL'}`);
console.log(`CROSSING_GARRISON_PER_LEVEL=1150 (→ ${CROSSING_GARRISON} @ level ${CROSSING_LEVEL}): ${crGateOk ? '✅ PASS' : '❌ FAIL'}`);
console.log(`  Both gates should open with a modest, early investment, crossing opening first (lighter choke) if PASS.\n`);

console.log('ℹ️  DISPATCH NOTE (see strongholdCombat.ts header + STRONGHOLD_GARRISON_PER_LEVEL doc comment in');
console.log('  shared/slg/siege.ts for the full 2026-07-27 writeup): both garrisons above exceed SIEGE_SYNTH_ARMY_MAX_TROOPS');
console.log('  (~9,600 troops — the board-depth capacity of synthesizeArmy\'s round-robin placement, 10 lanes × 16 rows ×');
console.log('  60 HP/unit), so worldsvc\'s shouldUseCheapSiege (wired into combatSiege/arrival.ts since commit 13a7af86,');
console.log('  2026-07-16) ALWAYS routes these fights to the cheap linear resolveSiege in production — never the real');
console.log('  engine. That makes this a comfortable, thousands-of-troops-wide linear calibration (fresh/invested margins');
console.log('  of several hundred troops either side of the gate), not a fragile real-engine board-depth band. An earlier');
console.log('  same-day pass of this recalibration missed that dispatch and chased a ~100-175-troop "safe band" around the');
console.log('  engine\'s board-depth cliff instead — a problem that does not actually occur in production. Re-run this');
console.log('  script after any future change to TROOP_CAP_BASE, DRILL_TROOPCAP_STEP, or SIEGE_SYNTH_ARMY_MAX_TROOPS.\n');

console.log(shGateOk && crGateOk ? '✅ BOTH CONSTANTS CONFIRMED for TROOP_CAP_BASE=10000.' : '❌ NEEDS TUNING.');
console.log('\nRegister conclusions → ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD.5');
