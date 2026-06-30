// Engine PlayerStats → achievement statKey delta mapping (S9-3b / S9-6).
// Achievement statKeys are strings (authoritative definitions in @nw/shared/achievements.ts);
// the engine only produces raw counters. This file centralises the "engine unit/spell type →
// statKey" mapping in one place so that PvP match reporting (client) and PvE settlement
// ingestion (server, S9-3b PvE half) share the same mapping and cannot drift apart.
import { PlayerStats, SpellType, UnitType } from './types';

/**
 * Convert one side's PlayerStats for a match into achievement statKey deltas (non-zero entries only).
 * - `kill.archer`  ← kills of Archer units
 * - `kill.guard`   ← kills of ShieldBearer units (i18n "shield-breaker")
 * - `cast.meteor`  ← number of Meteor casts (not hit count)
 * Returns `Record<string, number>` (statKey→delta); callers (client reporting / meta accumulation)
 * consume as needed.
 */
export function achievementStatDelta(stats: PlayerStats): Record<string, number> {
  const kills = stats.killsByType ?? {};
  const casts = stats.castsByType ?? {};
  const out: Record<string, number> = {};
  const archer = kills[UnitType.Archer] ?? 0;
  const guard = kills[UnitType.ShieldBearer] ?? 0;
  const meteor = casts[SpellType.Meteor] ?? 0;
  if (archer > 0) out['kill.archer'] = archer;
  if (guard > 0) out['kill.guard'] = guard;
  if (meteor > 0) out['cast.meteor'] = meteor;
  return out;
}
