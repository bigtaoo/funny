// SLG shop items (S8-8, §8).
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).

export interface SlgShopItem {
  id: string;
  /** Coin price. */
  cost: number;
  kind: 'troop_speedup' | 'resource_pack' | 'protection' | 'battle_pass';
  /** Effect parameters (duration_sec / resource_each / pass_season). */
  effect: Record<string, number | string>;
  description: string;
}

export const SLG_SHOP_ITEMS: readonly SlgShopItem[] = [
  // training speed-ups
  { id: 'slg_speedup_1h',    cost: 200,   kind: 'troop_speedup', effect: { duration_sec: 3600 },  description: 'Speed up training by 1 hour' },
  { id: 'slg_speedup_8h',    cost: 1400,  kind: 'troop_speedup', effect: { duration_sec: 28800 }, description: 'Speed up training by 8 hours' },
  { id: 'slg_speedup_24h',   cost: 3600,  kind: 'troop_speedup', effect: { duration_sec: 86400 }, description: 'Speed up training by 24 hours' },
  // resource packs (equal amounts of every season resource)
  { id: 'slg_res_s',  cost: 300,   kind: 'resource_pack', effect: { each: 20000 },  description: 'Small resource pack (20k each)' },
  { id: 'slg_res_m',  cost: 1000,  kind: 'resource_pack', effect: { each: 80000 },  description: 'Medium resource pack (80k each)' },
  { id: 'slg_res_l',  cost: 3000,  kind: 'resource_pack', effect: { each: 200000 }, description: 'Large resource pack (200k each)' },
  // protection shields
  { id: 'slg_shield_8h',  cost: 500,  kind: 'protection', effect: { duration_sec: 28800 }, description: 'Capital protection shield 8 hours' },
  { id: 'slg_shield_24h', cost: 1200, kind: 'protection', effect: { duration_sec: 86400 }, description: 'Capital protection shield 24 hours' },
  // season battle pass
  { id: 'slg_battle_pass', cost: 9800, kind: 'battle_pass', effect: { pass_season: 1 }, description: 'Season battle pass (valid for current season)' },
] as const;
