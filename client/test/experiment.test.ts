import { describe, it } from 'vitest';
import { simulateLevel, type SimResult } from './difficultySim';
import { CAMPAIGN_LEVELS } from '../src/game/campaign/levels';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';

/**
 * Tuning experiment: A/B tests using the simulator to find "what changes make the first level fair for a zero-progression beginner".
 * Each variant is run with the same baseline AI and a fresh progression profile to check pass/fail and how close the result is.
 */

function clone(level: LevelDefinition): LevelDefinition {
  return JSON.parse(JSON.stringify(level));
}

// Delay all waves by dTick ticks and multiply count by mult (floored, minimum 1)
function rescaleWaves(level: LevelDefinition, delayTicks: number, countMult: number): void {
  for (const e of level.waves.entries) {
    e.atTick += delayTicks;
    e.count = Math.max(1, Math.floor(e.count * countMult));
  }
}

describe('ch1_lv1 tuning experiment (fresh + baseline AI)', () => {
  it('Compare difficulty reduction variants', () => {
    const base = CAMPAIGN_LEVELS['ch1_lv1']!;

    const variants: { name: string; level: LevelDefinition }[] = [];

    // 0) original
    variants.push({ name: 'original (as-is)', level: base });

    // 1) economy only: starting ink + ink regen doubled
    {
      const l = clone(base);
      l.startInk = 40;
      l.inkRegenMult = 2;
      variants.push({ name: 'economy-A startInk40/regen×2', level: l });
    }

    // 2) economy even stronger
    {
      const l = clone(base);
      l.startInk = 60;
      l.inkRegenMult = 2.5;
      variants.push({ name: 'economy-B startInk60/regen×2.5', level: l });
    }

    // 3) pacing only: first wave delayed by 5s, wave counts ×0.6
    {
      const l = clone(base);
      rescaleWaves(l, 90, 0.6); // +3s buffer + cut 40% of troops
      variants.push({ name: 'pacing delay3s+troops×0.6', level: l });
    }

    // 4) enemy strength only: HP×0.6
    {
      const l = clone(base);
      l.enemyScale = { hp: 0.6, damage: 1 };
      variants.push({ name: 'strength enemyHP×0.6', level: l });
    }

    // probe) extreme economy: startInk 200 + regen×5 (isolates whether ink is the sole bottleneck)
    {
      const l = clone(base);
      l.startInk = 200;
      l.inkRegenMult = 5;
      variants.push({ name: 'probe extreme-economy(ink200/×5)', level: l });
    }

    // 5) gentle combo: startInk 30 / regen×1.5 + troop count×0.75 + delay 2s
    {
      const l = clone(base);
      l.startInk = 30;
      l.inkRegenMult = 1.5;
      rescaleWaves(l, 60, 0.75);
      variants.push({ name: 'combo economy+pacing(gentle)', level: l });
    }

    // recommended A: pacing/troop count only (no economy changes, cleanest) — delay 5s + troop count×0.5
    {
      const l = clone(base);
      rescaleWaves(l, 150, 0.5);
      variants.push({ name: 'recommended-A delay5s+troops×0.5', level: l });
    }

    // recommended B: pacing + small economy head-start + slight difficulty reduction (more beginner-friendly)
    {
      const l = clone(base);
      l.startInk = 30;
      l.inkRegenMult = 1.3;
      l.enemyScale = { hp: 0.85, damage: 1 };
      rescaleWaves(l, 120, 0.55);
      variants.push({ name: 'recommended-B pacing+startInk30+enemyHP0.85', level: l });
    }

    const rows: { name: string; r: SimResult }[] = variants.map((v) => ({
      name: v.name,
      r: simulateLevel(v.level, { preset: 'fresh' }),
    }));

    console.log('\nVariant                        | Result | End HP | Min HP | Duration | Peak enemies');
    console.log('-'.repeat(78));
    for (const { name, r } of rows) {
      const res = r.win ? '✓pass' : '✗fail';
      console.log(
        `${name.padEnd(30)}| ${res} | ${String(r.finalBaseHp).padStart(5)} | ${String(r.minBaseHp).padStart(5)} | ${String(r.seconds).padStart(5)}s | ${String(r.peakEnemies).padStart(4)}`
      );
    }
    console.log('\nGoal: ✓pass with min HP > 20 = fair; ✓pass but very low min HP = hard but beatable; ✗ = unbeatable\n');
  });
});
