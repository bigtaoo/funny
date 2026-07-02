// Unit progression cards — collect-and-merge model (ECONOMY_NUMBERS §4 / ADR-009).
//
// Pure data + pure functions, no game logic (M12: metaserver may import; reverse imports from client/engine are strictly forbidden).
// Card inventory (cardInventory) is the raw collection source; unit strength level (unitLevels) = the highest card tier
// owned per unit type, derived from inventory by deriveUnitLevels (server-authoritative; the engine only reads unitLevels to run blueprints).
//
// Card sources (gacha / level drops) see S12-C; unit strength is derived from inventory by deriveUnitLevels (server-authoritative).
// NOTE: the S12 collect-and-merge sink (5→1) and its /pve/merge endpoint were retired with the Hero Roster migration (CC-1); merge
// logic has been removed here. Historical merge coefficient/design is preserved in ECONOMY_NUMBERS §4.1.

/** Card / unit level cap (same value as @nw/engine UNIT_MAX_LEVEL, decoupled to avoid import). */
export const UNIT_CARD_MAX_LEVEL = 9;

/**
 * Progressable unit ids — must match the string values of @nw/engine `UnitType` exactly; the keys in SaveData.unitLevels are fed directly to the engine.
 * Order determines the chapter rotation for levelCardReward (ch1→index0, ch2→index1, …):
 *   odd chapters (Tao): infantry / shieldbearer / archer
 *   even chapters (Anna): max / lena / mara
 */
export const PROGRESSABLE_UNIT_IDS = ['infantry', 'max', 'shieldbearer', 'lena', 'archer', 'mara'] as const;
export type ProgressableUnitId = (typeof PROGRESSABLE_UNIT_IDS)[number];

export function isProgressableUnit(id: string): id is ProgressableUnitId {
  return (PROGRESSABLE_UNIT_IDS as readonly string[]).includes(id);
}

/** Key format for cardInventory: `${unitId}:${level}`. */
export function cardKey(unitId: string, level: number): string {
  return `${unitId}:${level}`;
}

/** Parses a card key; invalid format / out-of-range level / unknown unit type → null. */
export function parseCardKey(key: string): { unitId: ProgressableUnitId; level: number } | null {
  const idx = key.lastIndexOf(':');
  if (idx <= 0) return null;
  const unitId = key.slice(0, idx);
  const level = Number(key.slice(idx + 1));
  if (!isProgressableUnit(unitId)) return null;
  if (!Number.isInteger(level) || level < 1 || level > UNIT_CARD_MAX_LEVEL) return null;
  return { unitId, level };
}

/**
 * Derives the strength level per unit type from the card inventory = the **highest owned card tier** (count>0) for that unit; no cards = level 1 (base).
 * Only emits entries with level>1 (base L1 is the engine default for missing keys, saving storage and keeping save data lean).
 */
export function deriveUnitLevels(inv: Record<string, number>): Record<string, number> {
  const max: Record<string, number> = {};
  for (const [key, count] of Object.entries(inv)) {
    if (!count || count <= 0) continue;
    const parsed = parseCardKey(key);
    if (!parsed) continue;
    if (parsed.level > (max[parsed.unitId] ?? 0)) max[parsed.unitId] = parsed.level;
  }
  const out: Record<string, number> = {};
  for (const unitId of PROGRESSABLE_UNIT_IDS) {
    const lvl = max[unitId] ?? 1;
    if (lvl > 1) out[unitId] = lvl;
  }
  return out;
}

/** Adds a batch of cards to the inventory (for level drops / gacha delivery; pure function returning a new inventory). Invalid keys are skipped. */
export function grantCards(
  inv: Record<string, number>,
  grants: Record<string, number>,
): Record<string, number> {
  const next = { ...inv };
  for (const [key, amount] of Object.entries(grants)) {
    if (!amount || amount <= 0) continue;
    if (!parseCardKey(key)) continue;
    next[key] = (next[key] ?? 0) + amount;
  }
  return next;
}

// ── Card sources (S12-C, ECONOMY_NUMBERS §3 level drops / §4.1 gacha cards) ────────────────
// Two card sources: ① gacha (independent unit card pool, RNG rolled by commercial) ② level drops (deterministic integer rewards on PvE clear).
// All cards enter the system through grantCards → cardInventory; unitLevels is recomputed by deriveUnitLevels (server-authoritative).

/** Unit card gacha pool id (separate from the skin pool `standard`: progression ≠ cosmetics, motivations and tuning parameters are independent). */
export const UNIT_CARD_POOL_ID = 'units';

/**
 * Gacha rarity → unit card level mapping (independent unit card pool, §4.1 "gacha card" supplemental source).
 * Gacha produces T1–T4: common→T1 / rare→T2 / epic→T3 / legendary→T4 (accelerates access to higher tiers; T5+ still requires merging/auction).
 * Same rarity weights as the skin pool (economy.ts `RARITY_WEIGHTS`); cards are collectibles → **no dupe coin refund**, all go into inventory.
 */
export const GACHA_RARITY_TO_CARD_LEVEL: Record<string, number> = {
  common: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};

/**
 * Builds the unit card pool's itemsByRarity (cardKey used as itemId, 3 unit types × 1 tier per rarity).
 * Called when economy.ts assembles GACHA_POOLS, ensuring "pool item = valid cardKey" so the delivery side can identify them with parseCardKey.
 */
export function unitCardPoolItems(): Record<'common' | 'rare' | 'epic' | 'legendary', string[]> {
  const at = (rarity: string) =>
    PROGRESSABLE_UNIT_IDS.map((u) => cardKey(u, GACHA_RARITY_TO_CARD_LEVEL[rarity]!));
  return { common: at('common'), rare: at('rare'), epic: at('epic'), legendary: at('legendary') };
}

/**
 * Level drop for unit cards (deterministic integer, §3 stamina-gated + §4.1 "late chapters produce T3 cards").
 * Derived from levelId `ch{N}_lv{M}`: later chapters yield higher tiers (ch1–2→T1 / ch3–4→T2 / ch5–6→T3);
 * unit type rotates by chapter (inf/shd/arc); final level (lv10) drops double. Non-chapter levels (e.g. `ch_stress`) drop no cards.
 * `[tunable]`: tier/count are the "high-tier card acquisition rate" knobs (tuned together with gacha/auction supply); **do not touch the 5→1 merge coefficient**.
 * Pure function, no RNG (ensures PvE audit idempotency + server-authoritative determinism).
 */
export function levelCardReward(levelId: string): Record<string, number> {
  const m = /^ch(\d+)_lv(\d+)$/.exec(levelId);
  if (!m) return {};
  const chapter = Number(m[1]);
  const lv = Number(m[2]);
  if (!chapter || !lv) return {};
  const tier = Math.min(3, Math.floor((chapter - 1) / 2) + 1);
  const unitId = PROGRESSABLE_UNIT_IDS[(chapter - 1) % PROGRESSABLE_UNIT_IDS.length]!;
  const count = lv >= 10 ? 2 : 1;
  return { [cardKey(unitId, tier)]: count };
}
