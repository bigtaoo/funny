// Authoritative single source of truth for PvE economy (PVE_INTEGRITY_PLAN §8.1). Pure data + pure functions, no game logic
// (M12: metaserver may import this; reverse imports from client/src/game are strictly forbidden).
// The client retains a display mirror (campaign/levels JSON starThresholds for local star calculation;
// balance/pveUpgrades effect multipliers for blueprint simulation), but **material grants / upgrade costs
// are authoritative here** (server /pve/* endpoints recompute them).

export type PveMaterial = 'scrap' | 'lead' | 'binding';

/** Equipment drop configuration (EQUIPMENT_DESIGN §4 level drop faucet, DRAFT [tunable]). */
export interface EquipmentDropConfig {
  /** Drop rarity (maps to EquipRarity; slot is randomly chosen from three slots at drop time). */
  rarity: 'common' | 'fine' | 'rare' | 'epic';
  /** Drop probability 0..1 (independently rolled on each clear; not subject to the daily material cap, DRAFT [tunable]). */
  rate: number;
}

export interface PveLevelConfig {
  id: string;
  /** Unlock prerequisite: the level id that must be cleared first (null = first level, no prerequisite). Sequential unlock. */
  requires: string | null;
  /** Materials granted per clear (§8 decision 3: repeatable, subject to daily cap). Empty = no material reward (e.g. stress test levels). */
  reward: Partial<Record<PveMaterial, number>>;
  /**
   * Level equipment drop (exclusive bonus for Boss/Elite levels, EQUIPMENT_DESIGN §4).
   * Probability is rolled independently (not affected by the daily material cap); silently skipped when inventory is full.
   * Only lv5 (chapter mid-elite) and lv10 (chapter Boss) have drops configured; other normal levels have none.
   */
  equipmentDrop?: EquipmentDropConfig;
  /** Stamina cost (A4), deducted at /pve/enter (not at clear). Default = 10 (flat rate, 2026-07-06); unset on all current levels. */
  staminaCost?: number;
}

/**
 * Ordered campaign levels (sequential unlock). Values match the `rewards.materials` in the client
 * `campaign/levels/*.json`, but **this is the authoritative source for grants** (client JSON is demoted to reference only).
 * First clear additionally unlocks the next level + records stars; materials follow this table (granted on every clear).
 */
export const PVE_LEVELS: PveLevelConfig[] = [
  // ── Chapter 1 ────────────────────────────────────────────────────────────
  { id: 'ch1_lv1',  requires: null,       reward: { scrap: 6,  lead: 2 } },
  { id: 'ch1_lv2',  requires: 'ch1_lv1',  reward: { scrap: 8,  lead: 3,  binding: 1 } },
  { id: 'ch1_lv3',  requires: 'ch1_lv2',  reward: { scrap: 10, lead: 4,  binding: 2 } },
  { id: 'ch1_lv4',  requires: 'ch1_lv3',  reward: { scrap: 8,  lead: 3 } },
  { id: 'ch1_lv5',  requires: 'ch1_lv4',  reward: { scrap: 10, lead: 4 },          equipmentDrop: { rarity: 'common', rate: 0.10 } },
  { id: 'ch1_lv6',  requires: 'ch1_lv5',  reward: { scrap: 10, lead: 4,  binding: 1 } },
  { id: 'ch1_lv7',  requires: 'ch1_lv6',  reward: { scrap: 12, lead: 5 } },
  { id: 'ch1_lv8',  requires: 'ch1_lv7',  reward: { scrap: 14, lead: 6,  binding: 1 } },
  { id: 'ch1_lv9',  requires: 'ch1_lv8',  reward: { scrap: 16, lead: 7,  binding: 2 } },
  { id: 'ch1_lv10', requires: 'ch1_lv9',  reward: { scrap: 18, lead: 8,  binding: 3 }, equipmentDrop: { rarity: 'common', rate: 0.18 } },
  // ── Chapter 2 ────────────────────────────────────────────────────────────
  { id: 'ch2_lv1',  requires: 'ch1_lv10', reward: { scrap: 6,  lead: 5 } },
  { id: 'ch2_lv2',  requires: 'ch2_lv1',  reward: { scrap: 7,  lead: 5 } },
  { id: 'ch2_lv3',  requires: 'ch2_lv2',  reward: { scrap: 8,  lead: 6 } },
  { id: 'ch2_lv4',  requires: 'ch2_lv3',  reward: { scrap: 9,  lead: 6,  binding: 1 } },
  { id: 'ch2_lv5',  requires: 'ch2_lv4',  reward: { scrap: 8,  lead: 7 },           equipmentDrop: { rarity: 'common', rate: 0.12 } },
  { id: 'ch2_lv6',  requires: 'ch2_lv5',  reward: { scrap: 9,  lead: 7,  binding: 1 } },
  { id: 'ch2_lv7',  requires: 'ch2_lv6',  reward: { scrap: 10, lead: 8,  binding: 1 } },
  { id: 'ch2_lv8',  requires: 'ch2_lv7',  reward: { scrap: 10, lead: 8,  binding: 1 } },
  { id: 'ch2_lv9',  requires: 'ch2_lv8',  reward: { scrap: 9,  lead: 8,  binding: 2 } },
  { id: 'ch2_lv10', requires: 'ch2_lv9',  reward: { scrap: 12, lead: 10, binding: 2 }, equipmentDrop: { rarity: 'fine',   rate: 0.15 } },
  // ── Chapter 3 ────────────────────────────────────────────────────────────
  { id: 'ch3_lv1',  requires: 'ch2_lv10', reward: { scrap: 8,  lead: 4 } },
  { id: 'ch3_lv2',  requires: 'ch3_lv1',  reward: { scrap: 8,  lead: 4 } },
  { id: 'ch3_lv3',  requires: 'ch3_lv2',  reward: { scrap: 9,  lead: 5 } },
  { id: 'ch3_lv4',  requires: 'ch3_lv3',  reward: { scrap: 9,  lead: 5 } },
  { id: 'ch3_lv5',  requires: 'ch3_lv4',  reward: { scrap: 9,  lead: 6,  binding: 1 }, equipmentDrop: { rarity: 'fine',   rate: 0.10 } },
  { id: 'ch3_lv6',  requires: 'ch3_lv5',  reward: { scrap: 10, lead: 6,  binding: 1 } },
  { id: 'ch3_lv7',  requires: 'ch3_lv6',  reward: { scrap: 10, lead: 7,  binding: 2 } },
  { id: 'ch3_lv8',  requires: 'ch3_lv7',  reward: { scrap: 11, lead: 7,  binding: 2 } },
  { id: 'ch3_lv9',  requires: 'ch3_lv8',  reward: { scrap: 11, lead: 8,  binding: 2 } },
  { id: 'ch3_lv10', requires: 'ch3_lv9',  reward: { scrap: 12, lead: 8,  binding: 3 }, equipmentDrop: { rarity: 'rare',   rate: 0.12 } },
  // ── Chapter 4 ────────────────────────────────────────────────────────────
  { id: 'ch4_lv1',  requires: 'ch3_lv10', reward: { scrap: 10, lead: 7,  binding: 2 } },
  { id: 'ch4_lv2',  requires: 'ch4_lv1',  reward: { scrap: 10, lead: 7,  binding: 2 } },
  { id: 'ch4_lv3',  requires: 'ch4_lv2',  reward: { scrap: 11, lead: 8,  binding: 2 } },
  { id: 'ch4_lv4',  requires: 'ch4_lv3',  reward: { scrap: 11, lead: 8,  binding: 3 } },
  { id: 'ch4_lv5',  requires: 'ch4_lv4',  reward: { scrap: 12, lead: 9,  binding: 3 }, equipmentDrop: { rarity: 'fine',   rate: 0.10 } },
  { id: 'ch4_lv6',  requires: 'ch4_lv5',  reward: { scrap: 12, lead: 9,  binding: 3 } },
  { id: 'ch4_lv7',  requires: 'ch4_lv6',  reward: { scrap: 13, lead: 10, binding: 3 } },
  { id: 'ch4_lv8',  requires: 'ch4_lv7',  reward: { scrap: 13, lead: 10, binding: 4 } },
  { id: 'ch4_lv9',  requires: 'ch4_lv8',  reward: { scrap: 14, lead: 11, binding: 4 } },
  { id: 'ch4_lv10', requires: 'ch4_lv9',  reward: { scrap: 15, lead: 12, binding: 4 }, equipmentDrop: { rarity: 'rare',   rate: 0.12 } },
  // ── Chapter 5 ────────────────────────────────────────────────────────────
  { id: 'ch5_lv1',  requires: 'ch4_lv10', reward: { scrap: 14, lead: 10, binding: 4 } },
  { id: 'ch5_lv2',  requires: 'ch5_lv1',  reward: { scrap: 14, lead: 11, binding: 4 } },
  { id: 'ch5_lv3',  requires: 'ch5_lv2',  reward: { scrap: 15, lead: 11, binding: 4 } },
  { id: 'ch5_lv4',  requires: 'ch5_lv3',  reward: { scrap: 15, lead: 12, binding: 4 } },
  { id: 'ch5_lv5',  requires: 'ch5_lv4',  reward: { scrap: 16, lead: 12, binding: 4 }, equipmentDrop: { rarity: 'rare',   rate: 0.08 } },
  { id: 'ch5_lv6',  requires: 'ch5_lv5',  reward: { scrap: 16, lead: 13, binding: 5 } },
  { id: 'ch5_lv7',  requires: 'ch5_lv6',  reward: { scrap: 17, lead: 13, binding: 5 } },
  { id: 'ch5_lv8',  requires: 'ch5_lv7',  reward: { scrap: 18, lead: 14, binding: 5 } },
  { id: 'ch5_lv9',  requires: 'ch5_lv8',  reward: { scrap: 19, lead: 14, binding: 5 } },
  { id: 'ch5_lv10', requires: 'ch5_lv9',  reward: { scrap: 20, lead: 15, binding: 6 }, equipmentDrop: { rarity: 'rare',   rate: 0.12 } },
  // ── Chapter 6 ────────────────────────────────────────────────────────────
  { id: 'ch6_lv1',  requires: 'ch5_lv10', reward: { scrap: 18, lead: 14, binding: 6 } },
  { id: 'ch6_lv2',  requires: 'ch6_lv1',  reward: { scrap: 19, lead: 15, binding: 7 } },
  { id: 'ch6_lv3',  requires: 'ch6_lv2',  reward: { scrap: 20, lead: 15, binding: 7 } },
  { id: 'ch6_lv4',  requires: 'ch6_lv3',  reward: { scrap: 20, lead: 16, binding: 7 } },
  { id: 'ch6_lv5',  requires: 'ch6_lv4',  reward: { scrap: 21, lead: 16, binding: 8 }, equipmentDrop: { rarity: 'rare',   rate: 0.10 } },
  { id: 'ch6_lv6',  requires: 'ch6_lv5',  reward: { scrap: 22, lead: 17, binding: 8 } },
  { id: 'ch6_lv7',  requires: 'ch6_lv6',  reward: { scrap: 22, lead: 17, binding: 8 } },
  { id: 'ch6_lv8',  requires: 'ch6_lv7',  reward: { scrap: 24, lead: 18, binding: 9 } },
  { id: 'ch6_lv9',  requires: 'ch6_lv8',  reward: { scrap: 25, lead: 19, binding: 9 } },
  { id: 'ch6_lv10', requires: 'ch6_lv9',  reward: { scrap: 28, lead: 20, binding: 10 }, equipmentDrop: { rarity: 'epic',   rate: 0.08 } },
  // ── Extras ───────────────────────────────────────────────────────────────
  { id: 'ch_stress', requires: 'ch1_lv3', reward: {} },
];

export function findPveLevel(id: string): PveLevelConfig | undefined {
  return PVE_LEVELS.find((l) => l.id === id);
}

// ── Achievement: chapter clear count (ACHIEVEMENT_DESIGN §3.1 `campaign.chaptersCleared`) ──────
// The only achievement stat that PvE can produce with server authority (other kill.*/cast.* stats await typed engine instrumentation, §6.2).

/**
 * The "finale" levelId for each chapter (the highest lv index in that chapter), derived from {@link PVE_LEVELS} (single source of truth).
 * Special levels without the `_lvN` suffix (e.g. `ch_stress`) do not belong to any chapter and are ignored.
 */
function chapterFinales(): Map<string, string> {
  const maxLv = new Map<string, number>();
  const finale = new Map<string, string>();
  for (const l of PVE_LEVELS) {
    const m = /^(.+)_lv(\d+)$/.exec(l.id);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const ch = m[1];
    const n = Number(m[2]);
    if (n > (maxLv.get(ch) ?? -1)) {
      maxLv.set(ch, n);
      finale.set(ch, l.id);
    }
  }
  return finale;
}

/**
 * Number of cleared chapters = count of chapters whose finale level appears in cleared (`ch{N}_lv{max}` in cleared set).
 * Pure function, derived from {@link PVE_LEVELS}; reads no clock and makes no DB calls. cleared is monotonically increasing →
 * result is monotonically increasing (increments only on first clear, not on replays), so the server uses `$max` writes.
 * Special levels (e.g. `ch_stress`, no finale index) are not counted as chapters.
 */
export function chaptersClearedCount(cleared: readonly string[]): number {
  const clearedSet = new Set(cleared);
  let count = 0;
  for (const finaleId of chapterFinales().values()) {
    if (clearedSet.has(finaleId)) count++;
  }
  return count;
}

// ── Chapter-clear exclusive reward: anchor character card (CHARACTER_CARDS_DESIGN §4, CHARACTER_DESIGN §5.1) ──
// First clear of a chapter's finale (`ch{N}_lv{max}`) grants a **level-2** instance of that chapter's anchor
// character card — a one-time reward, distinct from the per-level drop (level 1). Only triggered when
// chaptersClearedCount increments (first clear; replays do not re-grant). See metaserver pve.ts grantChapterClearCard.

/**
 * Chapter id (`ch{N}`) → anchor character card def id (matches CARD_DEFS keys in @nw/shared cards.ts).
 * Tao anchors on odd chapters, Anna variants on even chapters, paired by unit-type position
 * (infantry / shieldbearer / archer): Ch1↔Ch2 (lichuang / max), Ch3↔Ch4 (chenshou / lena),
 * Ch5↔Ch6 (suyuan / mara). §5.1 pins the even (Anna) chapters explicitly (Ch2 Max / Ch4 Lena / Ch6 Mara);
 * the odd (Tao) chapters follow the same position pairing.
 */
export const CHAPTER_ANCHOR_CARD: Readonly<Record<string, string>> = {
  ch1: 'lichuang',
  ch2: 'max',
  ch3: 'chenshou',
  ch4: 'lena',
  ch5: 'suyuan',
  ch6: 'mara',
};

/** The chapter id (`ch{N}`) a level belongs to, or undefined for special levels without a `_lvN` suffix (e.g. `ch_stress`). */
export function chapterOf(levelId: string): string | undefined {
  const m = /^(ch\d+)_lv\d+$/.exec(levelId);
  return m?.[1];
}

/** The anchor character card def id granted (at level 2) on first clear of the given chapter, or undefined if the chapter has no anchor. */
export function chapterAnchorCard(chapterId: string): string | undefined {
  return CHAPTER_ANCHOR_CARD[chapterId];
}

/** Card level of the chapter-clear exclusive reward (§4: "the level-2 card of the corresponding character"). Distinct from the per-level drop level (1). */
export const CHAPTER_ANCHOR_CARD_LEVEL = 2;

/** Daily cap on "material-rewarding clears" (excess clears still record progress/stars but grant no materials, §8 decision 3). DRAFT pending playtesting. */
export const PVE_DAILY_CLEAR_REWARD_CAP = 20;

/**
 * Upgrade material costs (authoritative). **Effects** (HP/damage multipliers) remain in the client `game/balance/pveUpgrades`
 * (game logic, used for blueprint simulation); **costs** are defined here and recomputed by the server /pve/upgrade endpoint.
 * id / maxLevel / baseCost must stay in sync with the client mirror.
 */
export interface PveUpgradeCost {
  id: string;
  material: PveMaterial;
  maxLevel: number;
  /** Cost to go from level n to n+1 = baseCost × (n+1) (linear scaling). */
  baseCost: number;
}

export const PVE_UPGRADE_COSTS: PveUpgradeCost[] = [
  { id: 'inf_hp', material: 'scrap', maxLevel: 5, baseCost: 3 },
  { id: 'inf_dmg', material: 'scrap', maxLevel: 5, baseCost: 3 },
  { id: 'shd_hp', material: 'lead', maxLevel: 5, baseCost: 2 },
  { id: 'shd_dmg', material: 'lead', maxLevel: 5, baseCost: 2 },
  { id: 'arc_dmg', material: 'binding', maxLevel: 5, baseCost: 1 },
  { id: 'arc_hp', material: 'binding', maxLevel: 5, baseCost: 1 },
];

export function findPveUpgrade(id: string): PveUpgradeCost | undefined {
  return PVE_UPGRADE_COSTS.find((u) => u.id === id);
}

// ── L1 replay spot-check re-verification trigger (PVE_INTEGRITY_PLAN §8.6 step 3) ──────
// Sends the clear result to a headless client for re-computation (reuses S1-J); materials are only issued
// if the recomputed star count >= the claimed count. Replays are not sent by default; only when selected
// does the server respond with needsReplay to prompt the client to upload. Triggers: ① proportional random
// sampling ② first clear of a high-value level ③ L0 anomaly (opening blueprint power does not match
// server-authoritative pveUpgrades — "blueprint mismatch at start → must be cheating", §0).

/** Random sampling rate for re-clears of already-cleared levels (first clears and anomalies always trigger, bypassing this rate). DRAFT pending tuning. */
export const PVE_VERIFY_SAMPLE_RATE = 0.1;

/** When PvE re-verification rejections reach this threshold, the account is banned (pveBanned=true). */
export const PVE_REJECT_BAN_THRESHOLD = 3;

export interface SpotCheckInput {
  /** Whether this is the first clear of the level (includes unlock; high-value). */
  isFirstClear: boolean;
  /** L0 anomaly: the opening blueprint snapshot reported by the client does not match the server-authoritative pveUpgrades. */
  blueprintMismatch: boolean;
  /** 0..1 random number (injected by caller for deterministic testing). */
  rand: number;
  /** Sampling rate (defaults to {@link PVE_VERIFY_SAMPLE_RATE}). */
  sampleRate?: number;
}

/**
 * Whether to perform L1 replay spot-check re-verification for this clear. Always triggers on first clear or anomaly; otherwise sampled at the configured rate.
 * Pure function (random number injected externally); reads no clock and makes no DB calls.
 */
export function shouldSpotCheck(input: SpotCheckInput): boolean {
  if (input.blueprintMismatch || input.isFirstClear) return true;
  const rate = input.sampleRate ?? PVE_VERIFY_SAMPLE_RATE;
  return input.rand < rate;
}

/** Cost to go from currentLevel to currentLevel+1; returns null if already at max level. */
export function pveUpgradeCost(
  cost: PveUpgradeCost,
  currentLevel: number,
): { material: PveMaterial; amount: number } | null {
  if (currentLevel >= cost.maxLevel) return null;
  return { material: cost.material, amount: cost.baseCost * (currentLevel + 1) };
}
