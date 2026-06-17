import type { Prng } from '../math/prng';
import type { UnitType } from '../types';
import type { LevelDefinition } from './LevelDefinition';

/** A single enemy spawn request emitted by the director for the current tick. */
export interface WaveSpawn {
  unitType: UnitType;
  col: number;
  isBoss?: boolean;
}

interface ExpandedSpawn {
  tick: number;
  unitType: UnitType;
  col: number;
  isBoss?: boolean;
}

/**
 * WaveDirector — scripted PvE enemy source.
 *
 * Replaces the threat AI on the enemy side (owner 1 / Top) in campaign mode.
 * At construction it expands every {@link import('./LevelDefinition').WaveEntry}
 * (with its `count` / `spacingTicks`) into a flat, tick-sorted list of
 * individual spawns. `tick(t)` returns all spawns due at or before tick `t`
 * (a monotonic cursor walks the list), and `exhausted` reports when the whole
 * script has been emitted.
 *
 * Determinism: reads only the current tick and its own static (immutable) script.
 * The injected {@link Prng} is reserved for future randomized behaviour
 * (death-split spawns, randomized lanes) so those stay reproducible too.
 */
export class WaveDirector {
  private readonly spawns: ExpandedSpawn[];
  private cursor = 0;

  constructor(level: LevelDefinition, private readonly rng: Prng) {
    const activeLanes = level.board?.activeLanes;
    const expanded: ExpandedSpawn[] = [];
    for (const entry of level.waves.entries) {
      // Skip lanes not in activeLanes (if the level restricts lanes).
      if (activeLanes && !activeLanes.includes(entry.col)) continue;
      const spacing = entry.spacingTicks ?? 0;
      for (let i = 0; i < entry.count; i++) {
        expanded.push({
          tick: entry.atTick + i * spacing,
          unitType: entry.unitType,
          col: entry.col,
          isBoss: entry.isBoss,
        });
      }
    }
    // Stable sort by tick so spawn order within a tick follows declaration order.
    expanded.sort((a, b) => a.tick - b.tick);
    this.spawns = expanded;
  }

  /** All spawns due at or before `tick`. Advances an internal monotonic cursor. */
  tick(tick: number): WaveSpawn[] {
    const out: WaveSpawn[] = [];
    while (this.cursor < this.spawns.length && this.spawns[this.cursor]!.tick <= tick) {
      const s = this.spawns[this.cursor++]!;
      out.push({ unitType: s.unitType, col: s.col, isBoss: s.isBoss });
    }
    return out;
  }

  /** True once every scripted spawn has been emitted. */
  get exhausted(): boolean {
    return this.cursor >= this.spawns.length;
  }
}
