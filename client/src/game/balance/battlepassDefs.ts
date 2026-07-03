// Client-side mirror of the battle pass definition table (read-only copy of @nw/shared/battlepass.ts, consumed by BattlePassScene).
// Does not import @nw/shared (the client only depends on pure data inside game/).
// Authoritative numbers = ECONOMY_NUMBERS §13; update the server-side battlepass.ts in sync with any changes here.

export const BATTLEPASS_MAX_LEVEL = 30;
export const BATTLEPASS_BUY_COST = 600;
export const BP_XP_PER_LEVEL = 600;

export type BpRewardKind = 'coins' | 'material' | 'skin';

export interface BpReward {
  kind: BpRewardKind;
  id?: string;
  count: number;
}

export interface BpLevelDef {
  level: number;
  xpRequired: number;
  free?: BpReward;
  paid?: BpReward;
}

// Reward shorthands — keep the table terse (mirror of @nw/shared/battlepass.ts REWARD_ROWS).
const coins = (count: number): BpReward => ({ kind: 'coins', count });
const scrap = (count: number): BpReward => ({ kind: 'material', id: 'scrap', count });
const lead = (count: number): BpReward => ({ kind: 'material', id: 'lead', count });
const binding = (count: number): BpReward => ({ kind: 'material', id: 'binding', count });

// Re-planned reward curve (ECONOMY_NUMBERS §13.3). Both tracks escalate; milestones (every 5th level)
// pay coins; free-track coins total 960 (< one 10-pull). Keep byte-identical to the server table.
const REWARD_ROWS: Array<[free: BpReward, paid: BpReward]> = [
  /* Lv1  */ [scrap(2), coins(20)],
  /* Lv2  */ [scrap(3), coins(20)],
  /* Lv3  */ [scrap(3), scrap(5)],
  /* Lv4  */ [scrap(4), coins(25)],
  /* Lv5  */ [coins(60), coins(60)],
  /* Lv6  */ [lead(1), coins(25)],
  /* Lv7  */ [scrap(5), lead(2)],
  /* Lv8  */ [lead(1), coins(30)],
  /* Lv9  */ [lead(2), coins(30)],
  /* Lv10 */ [coins(150), coins(220)],
  /* Lv11 */ [lead(2), coins(30)],
  /* Lv12 */ [scrap(6), lead(3)],
  /* Lv13 */ [lead(2), coins(35)],
  /* Lv14 */ [lead(3), coins(35)],
  /* Lv15 */ [coins(90), coins(90)],
  /* Lv16 */ [binding(1), coins(35)],
  /* Lv17 */ [lead(3), binding(2)],
  /* Lv18 */ [binding(1), coins(40)],
  /* Lv19 */ [binding(2), coins(40)],
  /* Lv20 */ [coins(220), coins(320)],
  /* Lv21 */ [binding(2), coins(40)],
  /* Lv22 */ [lead(4), binding(3)],
  /* Lv23 */ [binding(2), coins(45)],
  /* Lv24 */ [binding(3), coins(45)],
  /* Lv25 */ [coins(120), coins(120)],
  /* Lv26 */ [binding(3), coins(45)],
  /* Lv27 */ [lead(5), binding(4)],
  /* Lv28 */ [binding(3), coins(50)],
  /* Lv29 */ [binding(4), coins(50)],
  /* Lv30 */ [coins(320), coins(520)],
];

export const BATTLEPASS_DEFS: BpLevelDef[] = REWARD_ROWS.map(([free, paid], i) => {
  const level = i + 1;
  return { level, xpRequired: level * BP_XP_PER_LEVEL, free, paid };
});

export function xpToLevel(xp: number): number {
  return Math.min(BATTLEPASS_MAX_LEVEL, Math.max(1, Math.floor(xp / BP_XP_PER_LEVEL) + 1));
}

export function xpToNextLevel(xp: number): number {
  if (xp >= BATTLEPASS_MAX_LEVEL * BP_XP_PER_LEVEL) return 0;
  const curLevel = xpToLevel(xp);
  return curLevel * BP_XP_PER_LEVEL - xp;
}
