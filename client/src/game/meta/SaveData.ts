// SaveData — single authoritative root of the meta system (META_DESIGN.md §3.1). Pure data, no PIXI / no platform dependencies.
// This file is the client-side mirror; the server-authoritative copy lives in server/shared/src/types.ts. The SaveData
// schema in openapi.yml is derived from both. Changing a field requires syncing all three places + adding a migration (migrate.ts), or old saves break.

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface LevelRecord {
  timeMs?: number;
  leaked?: number;
  [k: string]: unknown;
}

// ── Equipment instance (EQUIPMENT_DESIGN §3.1). Client mirror, derived from server/shared/src/types.ts ──
export type EquipSlot = 'weapon' | 'armor' | 'trinket';
export type EquipRarity = 'common' | 'fine' | 'rare' | 'epic';

/** Affix (unified shape for primary / secondary / skill affixes). */
export interface Affix {
  id: string;
  value: number;
}

/** Equipment instance (server-authoritative, client read-only). */
export interface EquipmentInstance {
  id: string;
  defId: string;
  rarity: EquipRarity;
  level: number; // 0..9
  affixes: Affix[];
  locked?: boolean;
}

export type GearSlotMap = Partial<Record<EquipSlot, string /* instanceId */>>;

/** Gear loadout (global army-wide / byUnit reserved per unit type). */
export interface GearLoadout {
  global?: GearSlotMap;
  byUnit?: Record<string, GearSlotMap>;
}

export interface SaveData {
  version: number; // schema version, used for migrations
  accountId: string; // cloud-save identity (empty string = not yet obtained / local-only)
  rev: number; // monotonically increasing revision number, used for optimistic locking / conflict resolution
  updatedAt: number; // server timestamp (display only, not trusted on the client)

  // —— Server-authoritative section (client read-only, §2) ——
  // wallet/gacha are read-only mirrors of the commercial service authority since S5 (meta fills them after economic operation receipts; client never writes them).
  wallet: { coins: number };
  inventory: {
    skins: string[];
    items: Record<string, number>;
  };
  gacha: { pity: Record<string, number> };
  // Delivered purchase orders (commercial orderId); server-authoritative, client read-only (S5-5).
  deliveredOrders: string[];
  pvp: {
    elo: number;
    rank: string;
    wins: number;
    losses: number;
    streak: number;
    // —— S11 season fields (may be absent in legacy saves) ——
    seasonNo?: number;
    seasonPeakElo?: number;
    seasonPeakRank?: string;
    reachedRanks?: string[];
  };
  // —— S11 battle pass (lazy-created; appears after the first ranked game or purchase this season) ——
  battlePass?: {
    seasonNo: number;
    xp: number;
    level: number;
    hasPass: boolean;
    claimedFree: number[];
    claimedPaid: number[];
  };

  // —— Retention (B5, RETENTION_DESIGN). Server-authoritative; not sent up on PUT /save (client read-only). ——
  retention?: {
    checkin?: { monthKey: string; claimedDays: number[] };
    daily?: { dayKey: string; completedTasks: Record<string, number>; taskPoints: number; rewardClaimed: boolean };
  };

  // —— Stamina (A4, server-authoritative, not sent up on PUT /save). Regenerates 1 point every 6 min, cap 120. Absent defaults to full.
  stamina?: { current: number; regenAt: number };

  // —— Titles (S10, TITLE_DESIGN §2). Server-authoritative, not sent up on PUT /save (client read-only).
  // The equipped slot is at equipped['title'] (sync section, client-writable); servers broadcast the opponent's title from it.
  titles?: string[];

  // —— Client sync section (light validation, §2) ——
  progress: {
    cleared: string[];
    stars: Record<string, 1 | 2 | 3>;
    best: Record<string, LevelRecord>;
  };
  materials: Record<string, number>;
  /**
   * @deprecated S3-2 per-stat material upgrades. Since S12 unit progression uses a single level + card-merge system (unitLevels/cardInventory);
   * the engine no longer reads this for progression. Kept for old-save compatibility; to be retired after the S12 cleanup.
   */
  pveUpgrades: Record<string, number>;
  // —— Unit progression (S12, ECONOMY_NUMBERS §4). Server-authoritative, client read-only (not in SyncPatch) ——
  /** Unit power level unitId→1..9, derived from cardInventory; the engine reads this to apply blueprints. */
  unitLevels: Record<string, number>;
  /** Unit card inventory `${unitId}:${level}`→count; the raw source for card-merge (5→1). */
  cardInventory: Record<string, number>;
  /** Cosmetic equipment (slot→skinId). Visual only; sent up with the sync section. */
  equipped: Record<string, string>;
  flags: Record<string, boolean>;

  // —— Equipment system (server-authoritative, client read-only, EQUIPMENT_DESIGN §3.1) ——
  // Separate from cosmetic `equipped` (skins); written by /equipment/* server endpoints, not included in the sync section.
  equipmentInv: Record<string, EquipmentInstance>;
  gear: GearLoadout;

  // —— Achievement system (server-authoritative, ACHIEVEMENT_DESIGN §3). Lazy-created: absent defaults to all-zero / empty;
  //    legacy saves are not migrated; client read-only (not sent up on PUT /save, A2). antiCheat is not pushed down, so the mirror excludes it. ——
  stats?: Record<string, number>; // lifetime cumulative statistics (StatKey→value), monotonically increasing
  achievements?: Record<string, { claimedTiers: number[] }>; // achId→subset of claimed tier indices
}

/**
 * Client sync section accepted by PUT /save (SERVER_API.md §2.2). Server-authoritative sections are never sent up.
 * Structurally identical to SyncPatch in server/shared/src/types.ts.
 * Since PVE_INTEGRITY_PLAN §8, progress/materials/pveUpgrades are server-authoritative
 * (written only by /pve/* + ranked settlement), so the sync section narrows to equipped/flags only.
 */
export type SyncPatch = Partial<Pick<SaveData, 'equipped' | 'flags'>>;

/** Field names for the client sync section (single source of truth for push extraction / merge). */
export const SYNC_KEYS = ['equipped', 'flags'] as const;

// v2 (2026-06-21): Added equipmentInv + gear (equipment system E0). See migrate.ts for v1→v2 migration.
// v3 (2026-06-21): Unit progression rework (S12) — added unitLevels + cardInventory, pveUpgrades marked deprecated.
export const SAVE_VERSION = 3;

/** Primary storage key for local saves (IPlatform.storage). */
export const SAVE_STORAGE_KEY = 'nw_save_v1';

/** Default save for a new account. All authoritative sections start from zero (consistent with server-side makeNewSave). */
export function makeNewSave(accountId = '', now = 0): SaveData {
  return {
    version: SAVE_VERSION,
    accountId,
    rev: 0,
    updatedAt: now,
    wallet: { coins: 0 },
    inventory: { skins: [], items: {} },
    gacha: { pity: {} },
    deliveredOrders: [],
    pvp: { elo: 1000, rank: 'unranked', wins: 0, losses: 0, streak: 0 },
    progress: { cleared: [], stars: {}, best: {} },
    materials: {},
    pveUpgrades: {},
    unitLevels: {},
    cardInventory: {},
    equipped: {},
    flags: {},
    equipmentInv: {},
    gear: {},
  };
}

/** Extract only the client sync section (equipped/flags) for push upload. */
export function extractSyncPatch(save: SaveData): Required<SyncPatch> {
  return {
    equipped: save.equipped,
    flags: save.flags,
  };
}
