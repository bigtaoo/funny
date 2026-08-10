// Split from AISystem.ts (2026-08-10, independent function module range 6, part 1/5).
// Difficulty curve data + the shared AiCtx passed by value to every free function
// in the sibling ai/*.ts files (see AISystem.ts's assembler comment for the split shape).
import { Prng } from '../../math/prng';
import { AIDifficulty, UnitType } from '../../types';

export type { AIDifficulty };

export interface DifficultyParams {
  /** Decision pacing in integer ticks (lower = acts more often). Floor is 12 ticks
   *  (0.4 s) — a professional-player reaction cadence, never frame-perfect. */
  thinkIntervalTicks: number;
  /** Enemy units at row ≥ this (closer to the AI base at row 17) trigger defense. */
  dangerRow: number;
  /** Own base HP ≤ this is treated as an emergency. */
  lowBaseHp: number;
  /** Spend meteor on enemy clusters (defensively near base / offensively anywhere). */
  useMeteor: boolean;
  /** Place arrow towers to defend pressured lanes. */
  useTowers: boolean;
  /** Build barracks for sustained pressure. */
  useBarracks: boolean;
  /** Minimum units inside the 2×2 footprint to justify an offensive meteor. */
  meteorOffenseCluster: number;
  /** Cast Haste on a push instead of only ever using Meteor (tempo play). */
  useHaste: boolean;
  /** Score every affordable unit card against the enemies actually on the board
   *  (config-driven matchup math) instead of a fixed species preference order. */
  useCounterPicking: boolean;
  /** Gate offensive AOE by ink-value (only nuke a cluster worth more than the spell). */
  useValueTrades: boolean;
  /** Track a short rolling window of per-lane threat to reinforce a lane that is
   *  building up pressure, instead of reacting only once it is already dangerous. */
  useThreatMemory: boolean;
}

/**
 * 10-level difficulty curve, L1 (passive punching bag) → L10 (professional-level
 * play). Every axis is continuous/monotonic across levels; new capabilities
 * (counter-picking, value trades, threat memory) unlock at the level where a
 * human opponent would start noticing that kind of play — they don't appear as
 * a single "hard mode" cliff.
 */
export const DIFFICULTY: Record<AIDifficulty, DifficultyParams> = {
  1:  { thinkIntervalTicks: 75, dangerRow: 16, lowBaseHp: 20, useMeteor: false, useTowers: false, useBarracks: false, meteorOffenseCluster: 99, useHaste: false, useCounterPicking: false, useValueTrades: false, useThreatMemory: false },
  2:  { thinkIntervalTicks: 65, dangerRow: 15, lowBaseHp: 24, useMeteor: false, useTowers: true,  useBarracks: true,  meteorOffenseCluster: 99, useHaste: false, useCounterPicking: false, useValueTrades: false, useThreatMemory: false },
  3:  { thinkIntervalTicks: 55, dangerRow: 14, lowBaseHp: 30, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 5,  useHaste: false, useCounterPicking: false, useValueTrades: false, useThreatMemory: false },
  4:  { thinkIntervalTicks: 48, dangerRow: 13, lowBaseHp: 35, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 4,  useHaste: false, useCounterPicking: false, useValueTrades: false, useThreatMemory: false },
  5:  { thinkIntervalTicks: 42, dangerRow: 12, lowBaseHp: 40, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 4,  useHaste: false, useCounterPicking: false, useValueTrades: false, useThreatMemory: false },
  6:  { thinkIntervalTicks: 36, dangerRow: 11, lowBaseHp: 45, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 3,  useHaste: false, useCounterPicking: true,  useValueTrades: false, useThreatMemory: false },
  7:  { thinkIntervalTicks: 30, dangerRow: 10, lowBaseHp: 50, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 3,  useHaste: true,  useCounterPicking: true,  useValueTrades: true,  useThreatMemory: false },
  8:  { thinkIntervalTicks: 24, dangerRow: 8,  lowBaseHp: 53, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 2,  useHaste: true,  useCounterPicking: true,  useValueTrades: true,  useThreatMemory: true  },
  9:  { thinkIntervalTicks: 18, dangerRow: 6,  lowBaseHp: 56, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 2,  useHaste: true,  useCounterPicking: true,  useValueTrades: true,  useThreatMemory: true  },
  10: { thinkIntervalTicks: 12, dangerRow: 4,  lowBaseHp: 60, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 2,  useHaste: true,  useCounterPicking: true,  useValueTrades: true,  useThreatMemory: true  },
};

/** At most this many AI barracks at once (also bounded by the 2 barracks cards). */
export const MAX_BARRACKS = 2;

/** How many past decideTick snapshots {@link DifficultyParams.useThreatMemory} keeps to detect a rising lane. */
export const THREAT_HISTORY_LEN = 5;

/** Legacy fallback preference order for levels below {@link DifficultyParams.useCounterPicking}. */
export const LEGACY_DEFENSE_PREFERENCE = [UnitType.ShieldBearer, UnitType.Infantry, UnitType.Archer];
export const LEGACY_OFFENSE_PREFERENCE = [UnitType.Infantry, UnitType.Archer, UnitType.ShieldBearer];

/**
 * Shared context passed by value to every free function in the sibling `ai/*.ts`
 * files — replaces what used to be `this.params`/`this.rng`/`this.threatHistory`
 * on the AISystem instance. `threatHistory` is the same array reference the class
 * holds, so `.push`/`.shift` on it inside a free function mutates the instance's
 * own rolling window (no getter/setter dance needed).
 */
export interface AiCtx {
  readonly params: DifficultyParams;
  readonly rng: Prng;
  readonly threatHistory: number[][];
}
