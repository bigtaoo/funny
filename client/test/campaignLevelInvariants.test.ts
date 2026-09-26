import { describe, it, expect } from 'vitest';
import { ATTACK_LANES } from '@nw/engine/config';
import { CAMPAIGN_LEVELS, CAMPAIGN_LEVEL_ORDER } from '@nw/engine/campaign/levels';
import type { LevelDefinition } from '@nw/engine/campaign/LevelDefinition';

/**
 * Conventions across the 60 campaign levels that `parseLevelDefinition` cannot express.
 *
 * The schema validates each level in isolation — is `units` an integer, is `col` a legal
 * lane — and every one of these invariants is about the SET: all sixty share one lanePunish
 * spec, nobody's enemyScale has run away, no level leans on a single knob hard enough that
 * its waves stopped carrying the difficulty. They are exactly the things a batch script
 * (which is how all three of the 2026-09-22 passes edited these files) can quietly get
 * wrong on a subset, and the difficulty matrix will not say which knob drifted — it only
 * reports that the outcome moved.
 */

const LEVELS: LevelDefinition[] = CAMPAIGN_LEVEL_ORDER.map((id) => CAMPAIGN_LEVELS[id]!);
const LANE_SET = new Set<number>(ATTACK_LANES as readonly number[]);

describe('campaign level invariants', () => {
  it('every level is a real campaign level with at least one wave', () => {
    expect(LEVELS.length).toBe(60);
    for (const lv of LEVELS) {
      expect(lv.waves.entries.length, `${lv.id} has no waves`).toBeGreaterThan(0);
    }
  });

  it('every wave spawns into a legal attack lane', () => {
    // A base column (5/6) would put the spawn on top of the base itself; the schema checks
    // this per entry, and this re-checks it across the set so a batch edit cannot slip one in.
    for (const lv of LEVELS) {
      for (const [i, e] of lv.waves.entries.entries()) {
        expect(LANE_SET.has(e.col), `${lv.id} wave[${i}] spawns in col ${e.col}, not an attack lane`).toBe(true);
      }
    }
  });

  it('all 60 levels share one lanePunish spec (§4.9.5)', () => {
    // Per-level tuning of the punish is allowed by the schema and may well happen later.
    // Today the campaign deliberately ships one setting everywhere, and "one level quietly
    // differs" is the failure mode of the batch script that wrote them — so pin the set,
    // not the value: if the campaign moves to per-chapter punishment, this test is the
    // place that records the decision.
    const specs = new Set(LEVELS.map((lv) => JSON.stringify(lv.lanePunish ?? null)));
    expect(
      [...specs],
      'campaign levels disagree about lanePunish — if that is intended, this test wants updating',
    ).toEqual([JSON.stringify({ units: 5, sustainTicks: 120, cooldownTicks: 450, spell: 'rockslide' })]);
  });

  it('no level leans on enemyScale beyond the tuned band', () => {
    // The 2026-09-22 regression re-tune drives hp/damage by a feedback loop; a runaway
    // coefficient is its characteristic failure, and it reads as "enemies are sponges"
    // rather than as a harder level. ch4_lv8 sat at hp 2.29 for exactly that reason until
    // its waves were rebuilt (DIFFICULTY_SIM_TUNING_CH2-CH6.md), which is the precedent
    // this band exists to catch early: past ~1.8 the answer is the wave script, not the knob.
    for (const lv of LEVELS) {
      const { hp = 1, damage = 1 } = lv.enemyScale ?? {};
      expect(hp, `${lv.id} enemyScale.hp = ${hp}`).toBeGreaterThan(0.5);
      expect(hp, `${lv.id} enemyScale.hp = ${hp} — rebuild its waves instead of scaling HP further`).toBeLessThan(1.8);
      expect(damage, `${lv.id} enemyScale.damage = ${damage}`).toBeGreaterThan(0.5);
      expect(damage, `${lv.id} enemyScale.damage = ${damage}`).toBeLessThan(1.8);
    }
  });

  it('damage never outruns hp in a level\'s enemyScale', () => {
    // The authored ch1..ch6 curves all keep damage at or below hp, and the re-tune loop
    // moves damage at half hp's rate to preserve that. Damage swings leak-rate much harder
    // than hp does, so an inverted pair is a tuning bug, not a style choice.
    for (const lv of LEVELS) {
      const { hp = 1, damage = 1 } = lv.enemyScale ?? {};
      expect(damage, `${lv.id}: damage ${damage} exceeds hp ${hp}`).toBeLessThanOrEqual(hp + 1e-9);
    }
  });
});
