// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ADR-074 wild-city siege calibration runner — the P2 上线门禁 of `design/game/
// SLG_CITY_SIEGE_DESIGN.md` §10. Same shape as strongholdCombatRun.ts / occupyCardTeamRun.ts: run the
// script, read the printed verdict, register the conclusion in ECONOMY_VERIFICATION_LOG.md
// §13-SLG-CITYSIEGE. `citySiege.test.ts` next door pins the verdict as a CI regression.
//
//   npm run --workspace @nw/econ-sim city-siege
//
// It answers the two questions the design doc's paper derivation could not (and got wrong twice — see
// citySiege.ts's header for the three reasons why):
//
//   ① Can ONE player — maxed drillYard, Lv.9 cards, saturated gear, the purchasable training-speed
//      buff, and the highest-siege-value roster in the catalogue — ever take the WEAKEST wild city?
//      The answer must be no *arithmetically*, not "it would take a long time".
//   ② How many attackers does a one-hour capture actually take, per city level?
//
// Every number below is live-computed from the current @nw/shared + @nw/engine constants. There is
// nothing to hand-edit here when a constant moves — which is the whole point (see
// ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD.5 for what happens when a calibration script prints a
// frozen conclusion from an earlier baseline).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import {
  TIERS,
  TIER_RAIDER,
  TIER_WHALE,
  SIEGE_SYNTH_ARMY_MAX_TROOPS,
  MULTS_NONE,
  MULTS_MAX,
  SECT_SIEGE_MULT,
  marchTroops,
  poolTroops,
  trainPerHour,
  damagePerSiege,
  measureSiege,
  damageProfile,
  shippedLadder,
  attackersFor,
  defenderRung,
  rungFieldedHp,
  TIER_STARTER,
  TIER_MID,
  TIER_VETERAN,
  type RosterTier,
} from './citySiege';
import {
  WILD_CITY_MIN_LEVEL,
  WILD_CITY_MAX_LEVEL,
  CITY_WAVE_COUNT,
  CITY_WAVE_GARRISON_PER_LEVEL,
  CITY_WAVE_BASE_HP_PER_LEVEL,
  CITY_DURABILITY_BASE,
  CITY_DURABILITY_PER_LEVEL,
  CITY_REGEN_BASE,
  CITY_REGEN_PER_LEVEL,
  CITY_WORLD_CENTER_MULT,
  cityDurabilityMax,
  cityRegenPerHour,
  cityWaveGarrison,
  cityWaveBaseHp,
  cityLadderGarrison,
  CITY_DEFENDER_ATK_AS_HP,
  CITY_DEFENDER_FORTIFY_MAX,
  TROOP_TRAIN_INK_COST,
  TROOP_SPEEDUP_SECS_PER_COIN,
  TROOP_TRAIN_TIME_SEC,
  CARD_TEAM_MAX_SIZE,
  SIEGE_TEAM_CAP,
  SIEGE_GEAR_PCT_CAP,
} from '@nw/shared';

const SEEDS = [1, 2, 3];
/** Levels a wild city actually generates at (graded cities 3-8, province capitals + world center 10). */
const CITY_LEVELS = [3, 4, 5, 6, 7, 8, 10] as const;

/**
 * The attackers-needed table published in SLG_CITY_SIEGE_DESIGN §6.2. Gate ② asserts the measured
 * values stay within ±25% of these — which makes this the pin between the shipped constants and the
 * design doc, in BOTH directions: retuning a constant without updating the doc fails here, and so does
 * editing the doc's table without re-running this script.
 */
const DOC_ATTACKERS: Record<number, number> = { 3: 12, 4: 16, 5: 20, 6: 24, 7: 28, 8: 32, 10: 40 };
const DOC_ATTACKERS_WORLD_CENTER = 80;
const DOC_TOLERANCE = 0.25;

function bar(s: string) { console.log('═'.repeat(100)); console.log(s); console.log('═'.repeat(100)); }
const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '∞');
const n1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '∞');
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

bar('ADR-074 wild-city siege calibration (SLG_CITY_SIEGE_DESIGN §6 / §10-P2)');
console.log('Shipped constants (live from @nw/shared):');
console.log(`  waves/march            ${CITY_WAVE_COUNT} (flat at every city level — see CITY_WAVE_COUNT)`);
console.log(`  wave garrison          ${CITY_WAVE_GARRISON_PER_LEVEL} troops/level   -> L${WILD_CITY_MIN_LEVEL}: ${n0(cityWaveGarrison(WILD_CITY_MIN_LEVEL))}, L${WILD_CITY_MAX_LEVEL}: ${n0(cityWaveGarrison(WILD_CITY_MAX_LEVEL))} per wave`);
console.log(`  wave base HP           ${CITY_WAVE_BASE_HP_PER_LEVEL} HP/level       -> L${WILD_CITY_MIN_LEVEL}: ${n0(cityWaveBaseHp(WILD_CITY_MIN_LEVEL))}, L${WILD_CITY_MAX_LEVEL}: ${n0(cityWaveBaseHp(WILD_CITY_MAX_LEVEL))} per wave`);
console.log(`  durability             ${n0(CITY_DURABILITY_BASE)} + ${n0(CITY_DURABILITY_PER_LEVEL)}/level   (world center x${CITY_WORLD_CENTER_MULT})`);
console.log(`  regen                  ${n0(CITY_REGEN_BASE)} + ${n0(CITY_REGEN_PER_LEVEL)}/level per hour`);
console.log('');
console.log('Model: every attacking march fights the FULL wave ladder (survivors carry over between waves');
console.log('  scaled by each wave\'s honest survival ratio, ADR-069), mirroring worldsvc applyBaseSiege; the');
console.log('  same shouldUseCheapSiege dispatch decides engine vs. cheap linear per wave. Clearing the ladder');
console.log('  schedules ONE durability hit = teamSiegeValue. A repelled march deals nothing and still pays.');
console.log(`  Deployment ceiling is the CARD troop cap (12 cards), not the ${n0(20000)}-troop pool/satchel cap.\n`);

// ── ① Roster capacity table ─────────────────────────────────────────────────────────────────────
bar('① ROSTERS — what one account can actually put on the board');
console.log('tier                                                                 march  pool   train/h  dmg/siege  +gear+sect');
console.log('-'.repeat(100));
for (const t of TIERS) {
  console.log(
    `${t.name.padEnd(68)} ${n0(marchTroops(t)).padStart(6)} ${n0(poolTroops(t)).padStart(6)} ${n0(trainPerHour(t)).padStart(8)} ` +
    `${n0(damagePerSiege(t)).padStart(10)} ${n0(damagePerSiege(t, MULTS_MAX)).padStart(11)}`,
  );
}
console.log(`\n  "march" is Σ cardTroopCap over the ${CARD_TEAM_MAX_SIZE} cards, clamped by satchel/troopCap — the card caps bind at every`);
console.log('  tier, so a maxed account deploys ~4,800 troops per siege, not 20,000. "dmg/siege" = teamSiegeValue');
console.log(`  bare (no gear). "+gear+sect" saturates the gear channel to +${pct(SIEGE_GEAR_PCT_CAP)} (SLG_CITY_SIEGE_DESIGN §12.7,`);
console.log(`  wired 2026-08-29) and stacks the x${SECT_SIEGE_MULT.toFixed(2)} §8.3 sect-city channel on top — see the note under gate ③.\n`);

// ── ② Per-siege troop cost, measured ───────────────────────────────────────────────────────────
bar('② ONE SIEGE — measured clear rate and troop cost of the wave ladder');
console.log('tier'.padEnd(68) + CITY_LEVELS.map((l) => `L${l}`.padStart(12)).join(''));
console.log('-'.repeat(100));
const costTable = new Map<string, Map<number, { clearRate: number; troopCost: number }>>();
for (const t of TIERS) {
  const row = new Map<number, { clearRate: number; troopCost: number }>();
  const cells: string[] = [];
  for (const L of CITY_LEVELS) {
    const c = measureSiege(t, shippedLadder(L), SEEDS);
    row.set(L, { clearRate: c.clearRate, troopCost: c.troopCost });
    cells.push((c.clearRate === 0 ? 'repelled' : `${n0(c.troopCost)}${c.clearRate < 1 ? `@${pct(c.clearRate)}` : ''}`).padStart(12));
  }
  costTable.set(t.name, row);
  console.log(t.name.padEnd(68) + cells.join(''));
}
console.log('\n  Cell = mean troops lost per CLEARED ladder ("repelled" = cannot clear it on any seed, so this tier');
console.log('  can never damage that city at all). Cost rises with city level in every tier that clears —');
console.log('  monotonicity is gate ④. A starter roster clears nothing: a city is not early-game content.\n');

// ── ③ Gate: the weakest wild city must be unwinnable solo ───────────────────────────────────────
bar(`③ GATE — a fully MAXED solo attacker vs the weakest wild city (L${WILD_CITY_MIN_LEVEL})`);
const weakest = shippedLadder(WILD_CITY_MIN_LEVEL);
const H_weak = cityDurabilityMax(WILD_CITY_MIN_LEVEL, 'garrison');
const R_weak = cityRegenPerHour(WILD_CITY_MIN_LEVEL, 'garrison');
const soloBare = damageProfile(TIER_WHALE, weakest, SEEDS, MULTS_NONE);
const soloMax = damageProfile(TIER_WHALE, weakest, SEEDS, MULTS_MAX);
console.log(`City: durability ${n0(H_weak)}, regen ${n0(R_weak)}/h, ladder ${CITY_WAVE_COUNT}x${n0(cityWaveGarrison(WILD_CITY_MIN_LEVEL))} troops (${n0(cityLadderGarrison(WILD_CITY_MIN_LEVEL))} total)`);
for (const [label, p] of [['bare (no gear, no sect)', soloBare], [`gear (+${pct(SIEGE_GEAR_PCT_CAP)} cap) + sect channels saturated`, soloMax]] as const) {
  console.log(`\n  ${label}:`);
  console.log(`    troop cost / siege   ${n0(p.troopCost)}   sieges in hour 1: ${n1(p.siegesFirstHour)}   damage/siege: ${n0(p.damagePerSiege)}`);
  console.log(`    sustained damage/h   ${n0(p.sustained)}  vs regen ${n0(R_weak)}/h   -> ${p.sustained < R_weak ? `PASS (regen is ${(R_weak / p.sustained).toFixed(2)}x)` : `FAIL (solo out-damages regen by ${(p.sustained / R_weak).toFixed(2)}x)`}`);
  console.log(`    pool-dump burst      ${n0(p.burst)}  vs durability ${n0(H_weak)}   -> ${p.burst < H_weak ? `PASS (durability is ${(H_weak / p.burst).toFixed(2)}x)` : 'FAIL (one pool dump takes the city)'}`);
  console.log(`    first-hour total     ${n0(p.firstHour)}  vs H+R ${n0(H_weak + R_weak)}   -> ${p.firstHour < H_weak + R_weak ? 'PASS' : 'FAIL'}`);
}
const gate3 = soloMax.sustained < R_weak && soloMax.burst < H_weak && soloMax.firstHour < H_weak + R_weak;
console.log(`\n  [${gate3 ? 'PASS' : 'FAIL'}] gate ③ — solo progress against the weakest wild city is永远 negative.`);
console.log('  Two conditions, both required, and the design doc only ever stated the first:');
console.log('    · SUSTAINED rate < regen  — otherwise a lone player grinds it down over days.');
console.log('    · POOL-DUMP burst < durability — otherwise the standing troop pool takes it in one sitting,');
console.log('      before regen has any time to act. This is the tighter of the two.');
console.log('\n  NOT closed by this gate (recorded as residual risk, see §11 of the design doc): coin training');
console.log(`  speedup (TROOP_SPEEDUP_SECS_PER_COIN=${TROOP_SPEEDUP_SECS_PER_COIN}) converts money into troops with no cap. To out-damage the`);
const coinTroopsNeeded = Number.isFinite(soloMax.troopCost) ? (R_weak / soloMax.damagePerSiege) * soloMax.troopCost : Number.POSITIVE_INFINITY;
const coinPerHour = (coinTroopsNeeded * TROOP_TRAIN_TIME_SEC) / TROOP_SPEEDUP_SECS_PER_COIN;
console.log(`  regen alone a solo attacker must sustain ${n0(coinTroopsNeeded)} extra troops/h = ~${n0(coinPerHour)} coins/h, sustained for the`);
console.log(`  ${n1(H_weak / Math.max(1, soloMax.damagePerSiege * (coinTroopsNeeded / Math.max(1, soloMax.troopCost))))}h+ it would take — plus ${n0(coinTroopsNeeded * TROOP_TRAIN_INK_COST)} ink/h of upkeep. Bounded in practice, unbounded in principle.`);

// ── ④ Gate: cheap-path ceiling + monotonicity ───────────────────────────────────────────────────
bar('④ GATE — structural invariants of the wave ladder');
const maxWave = cityWaveGarrison(WILD_CITY_MAX_LEVEL);
const ceilingOk = maxWave <= SIEGE_SYNTH_ARMY_MAX_TROOPS;
console.log(`  cheap-path ceiling: largest wave ${n0(maxWave)} vs SIEGE_SYNTH_ARMY_MAX_TROOPS ${n0(SIEGE_SYNTH_ARMY_MAX_TROOPS)} -> [${ceilingOk ? 'PASS' : 'FAIL'}]`);
console.log('    Above the ceiling shouldUseCheapSiege routes every wave to the cheap linear resolveSiege, where');
console.log('    the attacker loses exactly the garrison size and card quality stops mattering. The design doc\'s');
console.log('    DRAFT 1180/level (borrowed from STRONGHOLD_GARRISON_PER_LEVEL) crosses it at level 9.');
let monoOk = true;
for (const t of TIERS) {
  const row = costTable.get(t.name)!;
  let prev = 0;
  for (const L of CITY_LEVELS) {
    const cell = row.get(L)!;
    if (cell.clearRate === 0) continue;
    // Tolerance: the engine's defender formation geometry changes with unit count, so a few-percent dip
    // between adjacent levels is measurement noise. A material drop is a real inverted gate.
    if (prev > 0 && cell.troopCost < prev * 0.95) {
      console.log(`  [FAIL] ${t.name.trim()}: L${L} costs ${n0(cell.troopCost)}, materially less than the previous level's ${n0(prev)}`);
      monoOk = false;
    }
    prev = cell.troopCost;
  }
}
console.log(`  cost monotone by city level: [${monoOk ? 'PASS' : 'FAIL'}]`);
let reachOk = true;
for (const L of CITY_LEVELS) {
  const cell = costTable.get(TIER_RAIDER.name)!.get(L)!;
  if (cell.clearRate < 1) {
    console.log(`  [FAIL] the reference raider roster cannot reliably clear L${L} (${pct(cell.clearRate)}) — nobody realistic can damage that city`);
    reachOk = false;
  }
}
console.log(`  every city level is reachable by the reference roster: [${reachOk ? 'PASS' : 'FAIL'}]`);

// ── ⑤ Gate: attackers needed for a one-hour capture ─────────────────────────────────────────────
bar('⑤ GATE — attackers needed for a ONE-HOUR capture (reference roster)');
console.log(`Reference: ${TIER_RAIDER.name.trim()}`);
console.log('level | durability |  regen/h | dmg/h each | attackers (1h) | doc §6.2 | delta   | stall line');
console.log('-'.repeat(100));
let gate5 = true;
const measuredAttackers: Record<string, number> = {};
for (const L of CITY_LEVELS) {
  const p = damageProfile(TIER_RAIDER, shippedLadder(L), SEEDS, MULTS_NONE);
  const N = attackersFor(L, 'garrison', p.firstHour, 1);
  const H = cityDurabilityMax(L, 'garrison');
  const R = cityRegenPerHour(L, 'garrison');
  const stall = p.sustained > 0 ? R / p.sustained : Number.POSITIVE_INFINITY;
  const doc = DOC_ATTACKERS[L]!;
  const delta = (N - doc) / doc;
  const ok = Math.abs(delta) <= DOC_TOLERANCE;
  if (!ok) gate5 = false;
  measuredAttackers[`L${L}`] = N;
  console.log(
    `${String(L).padStart(5)} | ${n0(H).padStart(10)} | ${n0(R).padStart(8)} | ${n0(p.firstHour).padStart(10)} | ` +
    `${n1(N).padStart(14)} | ${String(doc).padStart(8)} | ${(delta >= 0 ? '+' : '') + (delta * 100).toFixed(0) + '%'} `.padStart(8) +
    `| ${n1(stall).padStart(10)} ${ok ? '' : '  <-- OUT OF TOLERANCE'}`,
  );
}
{
  const p = damageProfile(TIER_RAIDER, shippedLadder(WILD_CITY_MAX_LEVEL), SEEDS, MULTS_NONE);
  const N = attackersFor(WILD_CITY_MAX_LEVEL, 'worldCenter', p.firstHour, 1);
  const doc = DOC_ATTACKERS_WORLD_CENTER;
  const delta = (N - doc) / doc;
  if (Math.abs(delta) > DOC_TOLERANCE) gate5 = false;
  measuredAttackers.worldCenter = N;
  console.log(
    `   WC | ${n0(cityDurabilityMax(WILD_CITY_MAX_LEVEL, 'worldCenter')).padStart(10)} | ${n0(cityRegenPerHour(WILD_CITY_MAX_LEVEL, 'worldCenter')).padStart(8)} | ` +
    `${n0(p.firstHour).padStart(10)} | ${n1(N).padStart(14)} | ${String(doc).padStart(8)} | ${(delta >= 0 ? '+' : '') + (delta * 100).toFixed(0) + '%'} `.padStart(8) +
    `| ${n1(cityRegenPerHour(WILD_CITY_MAX_LEVEL, 'worldCenter') / Math.max(1, p.sustained)).padStart(10)} ${Math.abs(delta) <= DOC_TOLERANCE ? '' : '  <-- OUT OF TOLERANCE'}`,
  );
}
console.log(`\n  [${gate5 ? 'PASS' : 'FAIL'}] gate ⑤ — every level within ±${pct(DOC_TOLERANCE)} of the design doc's published table.`);
console.log('  "dmg/h each" is a FIRST-hour figure: it spends the standing troop pool plus one hour of training.');
console.log('  A raid that does not finish inside the hour falls back to the "stall line" — the attacker count');
console.log('  below which sustained damage never beats regen, i.e. the assault can never finish however long it');
console.log(`  runs. Both columns matter: a city siege is decided by the opening pool dump. With ${SIEGE_TEAM_CAP} teams and a`);
console.log('  ~1-minute round trip to an adjacent tile, march cycling is never the binding constraint — troops are.');

// The table above is BARE (MULTS_NONE) — matching how §6.2 was originally published, before the gear
// channel was real. Now that it is (§12.7), a raider whose gear happens to roll siege affixes needs
// fewer attackers than the doc table says. Printed informationally, not part of the PASS/FAIL gate —
// §6.2 itself is the design content decision, not something this script re-derives on its own.
console.log(`\n  Informational — same reference roster, gear saturated at +${pct(SIEGE_GEAR_PCT_CAP)} siege value (SLG_CITY_SIEGE_DESIGN §12.7):`);
for (const L of [WILD_CITY_MIN_LEVEL, WILD_CITY_MAX_LEVEL]) {
  const bareN = measuredAttackers[`L${L}`]!;
  const p = damageProfile(TIER_RAIDER, shippedLadder(L), SEEDS, { equipment: true, sect: false });
  const N = attackersFor(L, 'garrison', p.firstHour, 1);
  console.log(`    L${L}: ${n1(bareN)} bare -> ${n1(N)} geared (${pct((N - bareN) / bareN)})`);
}

// ── ⑥ Neighbourhood — what the two durability constants buy ─────────────────────────────────────
bar('⑥ SENSITIVITY — the neighbourhood of the two durability constants');
console.log('The solo gate is owned by regen (sustained) and durability (burst); the attackers-needed curve by');
console.log('their sum. Rows show what the WEAKEST city\'s two solo margins and the reference N would become.');
console.log('regenBase | durBase |  L3 sustained margin |  L3 burst margin | N(L3) | N(L10)');
console.log('-'.repeat(100));
const refWeak = damageProfile(TIER_RAIDER, shippedLadder(WILD_CITY_MIN_LEVEL), SEEDS, MULTS_NONE);
const refTop = damageProfile(TIER_RAIDER, shippedLadder(WILD_CITY_MAX_LEVEL), SEEDS, MULTS_NONE);
for (const rBase of [8_000, 10_000, 12_000, 14_000]) {
  for (const hBase of [20_000, 26_000, 32_000]) {
    const R = rBase + CITY_REGEN_PER_LEVEL * WILD_CITY_MIN_LEVEL;
    const H3 = hBase + CITY_DURABILITY_PER_LEVEL * WILD_CITY_MIN_LEVEL;
    const H10 = hBase + CITY_DURABILITY_PER_LEVEL * WILD_CITY_MAX_LEVEL;
    const R10 = rBase + CITY_REGEN_PER_LEVEL * WILD_CITY_MAX_LEVEL;
    const shipped = rBase === CITY_REGEN_BASE && hBase === CITY_DURABILITY_BASE;
    console.log(
      `${n0(rBase).padStart(9)} | ${n0(hBase).padStart(7)} | ${(R / soloMax.sustained).toFixed(2)}x`.padEnd(45) +
      `| ${(H3 / soloMax.burst).toFixed(2)}x`.padEnd(18) +
      `| ${n1((H3 + R) / refWeak.firstHour).padStart(5)} | ${n1((H10 + R10) / refTop.firstHour).padStart(6)}${shipped ? '   <- shipped' : ''}`,
    );
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────────────────────────
// -- (7) ADR-077: which lever a defender rung's progression can actually be spent on --------------
bar('(7) ADR-077 - a sect garrison rung: three ways to spend its progression, measured');
console.log('ADR-074 P3 put real players on the defending side but could not give them their own per-unit');
console.log('stats: a garrison fights on the plain baseline blueprint, exactly like the NPC waves beside it.');
console.log(`ADR-077 derives a factor from the team's own level+gear (hp ratio x attack ratio^${CITY_DEFENDER_ATK_AS_HP}, ceiling ${CITY_DEFENDER_FORTIFY_MAX}).`);
console.log('The open question is WHERE to spend it, and the answer is not the obvious one, so all three are');
console.log('measured here against the reference attacker at the weakest city level:');
console.log('');
console.log('  none    the pre-ADR baseline - the factor is not spent at all');
console.log('  hp      the factor scales the garrison entries\' initialHp (more troops to chew through)');
console.log('  baseHp  the factor scales the rung\'s symbolic defenderBaseHp (the position is dug in)');
console.log('');
console.log('defender roster                          | troops | factor | cost: none |     hp |  baseHp | clear(baseHp)');
console.log('-'.repeat(100));
const defenderTiers = [TIER_STARTER, TIER_MID, TIER_RAIDER, TIER_VETERAN, TIER_WHALE];
const gate7Rows: Array<{ name: string; factor: number; none: number; hp: number; baseHp: number }> = [];
let additiveOk = true;
const npcOnly = measureSiege(TIER_RAIDER, shippedLadder(WILD_CITY_MIN_LEVEL), SEEDS);
for (const dt of defenderTiers) {
  const rung = defenderRung(dt);
  const troops = rung.army.reduce((a, e) => a + (e.initialHp ?? 0), 0);
  const factor = rung.fortify;
  const base = shippedLadder(WILD_CITY_MIN_LEVEL);
  const cNone = measureSiege(TIER_RAIDER, { ...base, defenders: [rung], defenderLever: 'none' }, SEEDS);
  const cHp = measureSiege(TIER_RAIDER, { ...base, defenders: [rung], defenderLever: 'hp' }, SEEDS);
  const cBase = measureSiege(TIER_RAIDER, { ...base, defenders: [rung], defenderLever: 'baseHp' }, SEEDS);
  // P3's rule, re-checked per row and per lever: a defended city must never be CHEAPER for the attacker
  // than the same city with no garrison at all, or parking a team would be a way to help your attacker.
  for (const c of [cNone, cHp, cBase]) {
    if (Number.isFinite(c.troopCost) && c.troopCost < npcOnly.troopCost - 1) additiveOk = false;
  }
  gate7Rows.push({ name: dt.name.trim(), factor, none: cNone.troopCost, hp: cHp.troopCost, baseHp: cBase.troopCost });
  console.log(
    `${dt.name.trim().slice(0, 40).padEnd(40)} | ${n0(troops).padStart(6)} | ` +
    `${factor.toFixed(2)}x`.padStart(6) + ` | ${n0(cNone.troopCost).padStart(10)} | ${n0(cHp.troopCost).padStart(6)} | ` +
    `${n0(cBase.troopCost).padStart(7)} | ${pct(cBase.clearRate).padStart(13)}`,
  );
}
console.log(`\n  Reference point: the same city with NO garrison at all costs ${n0(npcOnly.troopCost)} troops per cleared assault.`);
console.log(`  [${additiveOk ? 'PASS' : 'FAIL'}] no lever ever makes a garrisoned city cheaper than an ungarrisoned one - P3's`);
console.log('  "additive, never substitutive" rule survives.');
console.log('');
console.log('  WHY the "hp" column barely moves, which is the finding this gate exists to record: the objective');
console.log('  is destroy_base against a deliberately small cityWaveBaseHp, and a timeout is a DEFENDER win. One');
console.log('  attacker unit slipping past the garrison ends the battle at once, however much HP that garrison');
console.log('  still has - so garrison HP is a blocking lever with ten lanes to cover and it cannot cover them.');
console.log('  simulateLadder\'s own baseHp=100-vs-600 note is the same observation from the NPC-wave side, and');
console.log('  citySiege.ts already calls waveBaseHp "the dominant attrition lever, not the garrison".');
console.log('');
console.log('');
console.log('  SAFETY CHECK - a maxed garrison repels the REFERENCE tier, so the city must still be takeable by');
console.log('  someone, or a well-parked team makes a city permanently untakeable and the capture loop dies.');
console.log('');
console.log('  attacker tier                            | vs MAXED garrison (baseHp) | clear | vs no garrison');
console.log('  ' + '-'.repeat(96));
const maxedRung = defenderRung(TIER_WHALE);
let takeableOk = false;
for (const at of TIERS) {
  const defended = measureSiege(at, { ...shippedLadder(WILD_CITY_MIN_LEVEL), defenders: [maxedRung], defenderLever: 'baseHp' }, SEEDS);
  const plain = measureSiege(at, shippedLadder(WILD_CITY_MIN_LEVEL), SEEDS);
  if (defended.clearRate > 0) takeableOk = true;
  console.log(
    `  ${at.name.trim().slice(0, 40).padEnd(40)} | ${n0(defended.troopCost).padStart(26)} | ${pct(defended.clearRate).padStart(5)} | ${n0(plain.troopCost).padStart(14)}`,
  );
}
console.log(`\n  [${takeableOk ? 'PASS' : 'FAIL'}] at least one attacker tier can still break a maxed garrison single-handed - and a`);
console.log('  sect raid stacks many of them, so the wall is a real threshold rather than an absolute one.');
console.log('  What NO lever here buys: attack, armor, attack speed, crit, lifesteal and the T3/T6/T9 traits all');
console.log('  stay at baseline, because the engine has ONE cardInstances slot with no side concept. A defender');
console.log('  that genuinely fights back needs a side-scoped blueprint input, an ENGINE_VERSION bump, regenerated');
console.log('  golden replays and a defender-carrying SiegeReplayInputs - deliberately out of scope here.');

bar('VERDICT');
const allOk = gate3 && ceilingOk && monoOk && reachOk && gate5 && additiveOk && takeableOk;
console.log(`  ③ solo-proof at the weakest wild city   ${gate3 ? '✅ PASS' : '❌ FAIL'}`);
console.log(`  ④ cheap-path ceiling / monotone / reach ${ceilingOk && monoOk && reachOk ? '✅ PASS' : '❌ FAIL'}`);
console.log(`  ⑤ attackers-needed matches the doc      ${gate5 ? '✅ PASS' : '❌ FAIL'}`);
console.log(`  ⑦ a garrison is never cheaper than none ${additiveOk ? '✅ PASS' : '❌ FAIL'}`);
console.log(`  ⑦ a maxed garrison is still breakable  ${takeableOk ? '✅ PASS' : '❌ FAIL'}`);
console.log(`\n${allOk ? '✅ CONSTANTS CONFIRMED' : '❌ NEEDS TUNING'} for TROOP_CAP_BASE/DRILL_TROOPCAP_STEP/card caps as they stand today.`);
console.log('\n⚠️  TWO CODE FACTS about the channels gate ③ is measured WITH (both are stacked into the worst case');
console.log('   above, which is why either one being real cannot move that verdict):');
console.log(`   1. teamSiegeValue() reads each card's equipped gear (SLG_CITY_SIEGE_DESIGN §12.7, wired 2026-08-29):`);
console.log(`      m_siege/s_siege affixes, summed then clamped to +${pct(SIEGE_GEAR_PCT_CAP)} — the same EFFECT_CAPS.siegePct_fp`);
console.log('      ceiling applyEquipment enforces on the engine blueprint\'s siegeValue_fp (in-battle damage). Both');
console.log('      channels now raise the SAME durability hit; gate ③ above is the real, not hypothetical, number.');
console.log(`   2. The §8.3 sect city bonus (x${SECT_SIEGE_MULT.toFixed(2)} at full map control) IS implemented as of ADR-074 P3`);
console.log('      (2026-08-27): applyCitySiege multiplies teamSiegeValue by (1 + sectPayoff.siegeBonus), on its');
console.log('      own channel, never summed into the capped equipment accumulator. Re-run confirmed PASS.');
console.log('\nRegister conclusions -> design/game/ECONOMY_VERIFICATION_LOG.md §13-SLG-CITYSIEGE');

/** Exported so citySiege.test.ts can assert the same conclusions without re-printing the report. */
export const RUN_SUMMARY = { gate3, ceilingOk, monoOk, reachOk, gate5, additiveOk, takeableOk, measuredAttackers, gate7Rows };
export const DOC_TABLE = { attackers: DOC_ATTACKERS, worldCenter: DOC_ATTACKERS_WORLD_CENTER, tolerance: DOC_TOLERANCE };
export type { RosterTier };
