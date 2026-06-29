// Equipment system — mechanism catalogue and data contract (EQUIPMENT_DESIGN.md §3 / §7 / §17).
//
// This file is the server-authoritative source for the equipment "definition catalogue + instance data contract", used by:
//   · metaserver  /equipment/craft to validate recipes and produce instances
//   · worldsvc    auction equipment branch: category key for valuation/price guardrails, snapshot validation
//   · client mirror  inventory/forge/equip UI (i18n keys derived from this table's defId)
// Combat stats (main-affix amplification coefficients, affix→engine field mapping, cross-system caps) live in @nw/engine
// (`balance/equipment.ts`); this file does not repeat them (README §0 three iron rules: stats live in code).
//
// Rarity uses a dedicated EquipRarity (common/fine/rare/epic), intentionally not reusing the skin Rarity
// (which includes legendary and carries different semantics; see types.ts note).

// ── Slot / Rarity ─────────────────────────────────────────────────────────
export type EquipSlot = 'weapon' | 'armor' | 'trinket';
export const EQUIP_SLOTS: readonly EquipSlot[] = ['weapon', 'armor', 'trinket'];

export type EquipRarity = 'common' | 'fine' | 'rare' | 'epic';

/** Rarity → affix slot count (EQUIPMENT_DESIGN §7.2): main is always 1 + sub + skill. */
export const RARITY_AFFIX_SLOTS: Record<EquipRarity, { sub: number; skill: number }> = {
  common: { sub: 0, skill: 0 },
  fine: { sub: 1, skill: 0 },
  rare: { sub: 2, skill: 0 },
  epic: { sub: 2, skill: 1 },
};

// ── Equipment definition catalogue (§17.2, 3 slots × 4 rarities = 12 items) ────────────────────────
// defId locks three things: slot + rarity + media skin (§3.1). Once obtained, only enhancement level and sub-affix reforging are possible;
// rarity cannot change. craftCost is DRAFT [adjustable] (authoritative values pending ECONOMY_NUMBERS §5, placeholder for now).

export interface EquipDef {
  defId: string;
  slot: EquipSlot;
  rarity: EquipRarity;
  /** Media skin (stationery), used for i18n/rendering; art-direction §9.2 maps to bone slot. */
  media: string;
  /** Crafting recipe (material id → quantity); undefined = not craftable (drop/gacha source only, e.g. some epics). */
  craftCost?: Record<string, number>;
}

export const EQUIPMENT_DEFS: Record<string, EquipDef> = {
  // weapon
  wp_pencil: { defId: 'wp_pencil', slot: 'weapon', rarity: 'common', media: 'pencil', craftCost: { scrap: 5 } },
  wp_pen: { defId: 'wp_pen', slot: 'weapon', rarity: 'fine', media: 'pen', craftCost: { scrap: 8, lead: 2 } },
  wp_marker: { defId: 'wp_marker', slot: 'weapon', rarity: 'rare', media: 'marker', craftCost: { lead: 6, binding: 2 } },
  wp_highlighter: { defId: 'wp_highlighter', slot: 'weapon', rarity: 'epic', media: 'highlighter' }, // gacha / very late game, not craftable
  // armor
  ar_draft: { defId: 'ar_draft', slot: 'armor', rarity: 'common', media: 'draft', craftCost: { scrap: 5 } },
  ar_cardstock: { defId: 'ar_cardstock', slot: 'armor', rarity: 'fine', media: 'cardstock', craftCost: { scrap: 8, lead: 2 } },
  ar_leather: { defId: 'ar_leather', slot: 'armor', rarity: 'rare', media: 'leather', craftCost: { lead: 6, binding: 2 } },
  ar_foil: { defId: 'ar_foil', slot: 'armor', rarity: 'epic', media: 'foil' },
  // trinket
  tk_clip: { defId: 'tk_clip', slot: 'trinket', rarity: 'common', media: 'clip', craftCost: { scrap: 5 } },
  tk_bookmark: { defId: 'tk_bookmark', slot: 'trinket', rarity: 'fine', media: 'bookmark', craftCost: { scrap: 8, lead: 2 } },
  tk_sticker: { defId: 'tk_sticker', slot: 'trinket', rarity: 'rare', media: 'sticker', craftCost: { lead: 6, binding: 2 } },
  tk_seal: { defId: 'tk_seal', slot: 'trinket', rarity: 'epic', media: 'seal' },
};

export function getEquipDef(defId: string): EquipDef | undefined {
  return EQUIPMENT_DEFS[defId];
}

/** Enhancement level cap (EQUIPMENT_DESIGN §6.1, +0..+9). */
export const EQUIP_MAX_LEVEL = 9;

/** Hard cap on individual inventory instances (EQUIPMENT_DESIGN §3.3, ADR-012, DRAFT [adjustable]). */
export const EQUIPMENT_INV_CAP = 300;

/** Equipment idempotency ledger (craft/escrow) TTL (seconds): retained for 7 days, covering client retries + worldsvc refund window (§18.2). */
export const EQUIPMENT_IDEM_TTL_SEC = 7 * 24 * 3600;

/** Salvage refund ratio / level threshold (§6.3, ADR-012). */
export const SALVAGE_REFUND_RATIO = 0.7;
export const SALVAGE_MAX_LEVEL = 4; // +5 and above cannot be salvaged

// ── Enhancement (E3, EQUIPMENT_DESIGN §6 / ECONOMY_NUMBERS §5.2, DRAFT [adjustable]) ────────
//
// Enhancement increments an instance's level by 1 (0→9), is probability-based, and can fail. Failure does not
// reduce level or break the item — it only consumes the materials + coins for that attempt (mild mode, §6.1).
// The primary coin/material sink comes from the sustained failure cost at high levels with low success rates (§6.2).
// Final values live in ECONOMY_NUMBERS §5 (pending); placeholders below are runnable (README §0: stats live in code).

/**
 * Enhancement success rate (by current level fromLevel, starting at 0→1). EQUIPMENT_DESIGN §6.1: each level step reduces by −10%,
 * 0→1=90%, 1→2=80%…8→9=10% (aligns with ECONOMY_NUMBERS §5.2 +1→2=80%…+8→9=10%;
 * §6.1 starting point is 0→1=90%). fromLevel ≥ 9 = already max level (returns 0; caller should gate on ENHANCE_MAX_LEVEL first).
 */
export function enhanceSuccessRate(fromLevel: number): number {
  if (fromLevel < 0 || fromLevel >= EQUIP_MAX_LEVEL) return 0;
  return (EQUIP_MAX_LEVEL - fromLevel) / 10; // 0→0.9, 8→0.1
}

/** Per-attempt enhancement cost (materials + coins), increasing with level (DRAFT, authoritative values in ECONOMY_NUMBERS §5.2). */
export interface EnhanceCost {
  materials: Record<string, number>;
  coins: number;
}

/**
 * Cost to enhance fromLevel→fromLevel+1 (DRAFT [adjustable]): low levels consume scrap, mid levels add lead, high levels add binding;
 * coins increase linearly with level. Deducted on both success and failure (failure cost is the core sink, §6.2).
 */
export function enhanceCost(fromLevel: number): EnhanceCost {
  const lv = Math.max(0, Math.min(fromLevel, EQUIP_MAX_LEVEL - 1));
  const materials: Record<string, number> = { scrap: 4 + 2 * lv };
  if (lv >= 3) materials.lead = lv - 2; // lead required from +3
  if (lv >= 6) materials.binding = lv - 5; // binding required from +6
  return { materials, coins: 40 * (lv + 1) };
}

/**
 * Enhancement dice roll (**server-authoritative**, deterministically bound to idempotencyKey + fromLevel): same key always
 * produces the same result on replay/retry, preventing "retry-fishing for a better roll" (§18.2).
 * The seed incorporates fromLevel so that consecutive enhancements at different levels using the same key are independent.
 */
export function rollEnhanceSuccess(seedKey: string, fromLevel: number): boolean {
  const rng = seededRng(hashSeed(`enhance:${seedKey}:${fromLevel}`));
  return rng() < enhanceSuccessRate(fromLevel);
}

/**
 * Salvage refund (§6.3, ADR-012): returns SALVAGE_REFUND_RATIO (70%, floored) of the **base crafting cost** for the defId.
 * Enhancement investment is not refunded (failure cost is the core sink and must not leak back via salvage). Non-craftable items (no craftCost) return empty.
 * Caller is responsible for validating level ≤ SALVAGE_MAX_LEVEL (+5 and above cannot be salvaged).
 */
export function salvageRefund(defId: string): Record<string, number> {
  const def = EQUIPMENT_DEFS[defId];
  if (!def?.craftCost) return {};
  const out: Record<string, number> = {};
  for (const [mat, qty] of Object.entries(def.craftCost)) {
    const r = Math.floor(qty * SALVAGE_REFUND_RATIO);
    if (r > 0) out[mat] = r;
  }
  return out;
}

// ── Craft affix roll (E2, EQUIPMENT_DESIGN §7.2/§7.4/§7.5, DRAFT [adjustable]) ─────────
//
// Crafting produces one +0 base item: 1 slot-locked main affix (m_*) + N sub-affixes by rarity (s_*).
// Affix id ↔ engine field mapping + enhancement amplification live in @nw/engine (balance/equipment.ts AFFIX_FIELD_MAP);
// this file only determines "which ids are rolled and what values". Concrete value ranges/weights are in ECONOMY_NUMBERS §5 (pending);
// the constants below are runnable placeholders (README §0: stats live in code, tuning only changes these constants).

/** Main affix locked by slot (§7.4; crit not yet implemented → trinket falls back to m_spd). value = +0 base value (percentage/flat). */
export const MAIN_AFFIX_BY_SLOT: Record<EquipSlot, { id: string; base: number }> = {
  weapon: { id: 'm_atk', base: 8 }, // ATK +8% (base, amplified by enhancement)
  armor: { id: 'm_hp', base: 10 }, // HP +10%
  trinket: { id: 'm_spd', base: 6 }, // SPD +6%
};

/** Sub-affix pool (§7.5 combat-power class, only rolled for rare/epic). Each entry: [id, min, max] (DRAFT). */
export const SUB_AFFIX_POOL: ReadonlyArray<readonly [string, number, number]> = [
  ['s_atk', 3, 6],
  ['s_hp', 4, 8],
  ['s_armor', 2, 5],
  ['s_spd', 2, 5],
  ['s_atkspd', 3, 6],
];

/** Rarity → number of sub-affixes rolled on craft (§7.2; epic skill-slot proc framework not yet implemented, this slice does not roll k_*). */
export const CRAFT_SUB_AFFIX_COUNT: Record<EquipRarity, number> = {
  common: 0,
  fine: 1,
  rare: 2,
  epic: 2,
};

/**
 * Deterministic mini-PRNG (mulberry32): used for craft rolls, seed derived from idempotencyKey;
 * same key always produces the same item on replay (reproducible even if idempotency ledger misses, preventing "retry-fishing").
 */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** String → 32-bit integer seed (FNV-1a). */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Rolls affixes for a crafted +0 base item (main affix + N non-duplicate sub-affixes by rarity).
 * @param defId Equipment definition id (determines slot/rarity).
 * @param seedKey Deterministic seed source (use idempotencyKey to guarantee replay consistency).
 * @returns affixes array (Affix[] structure, {id,value}); unknown defId → throws, caller handles.
 */
export function rollCraftedAffixes(defId: string, seedKey: string): { id: string; value: number }[] {
  const def = EQUIPMENT_DEFS[defId];
  if (!def) throw new Error(`unknown defId: ${defId}`);
  const rng = seededRng(hashSeed(`${defId}:${seedKey}`));
  const out: { id: string; value: number }[] = [];
  // Main affix (slot-locked, base value; amplified by engine on enhancement)
  const main = MAIN_AFFIX_BY_SLOT[def.slot];
  out.push({ id: main.id, value: main.base });
  // Sub-affixes: draw N non-duplicate entries from the pool
  const n = CRAFT_SUB_AFFIX_COUNT[def.rarity];
  const pool = [...SUB_AFFIX_POOL];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    const [id, lo, hi] = pool.splice(idx, 1)[0]!;
    const value = lo + Math.floor(rng() * (hi - lo + 1));
    out.push({ id, value });
  }
  return out;
}

// ── E7 Gacha equipment output + protection item ──────────────────────────────────────────────

/** Protection item id (purchasable from shop; on enhancement failure, materials are preserved, E7). Stored in `save.inventory.items[PROTECT_ENHANCE_ITEM_ID]`. */
export const PROTECT_ENHANCE_ITEM_ID = 'protect_enhance';

/**
 * Produces a gacha equipment instance (E7 §4). defId is already determined by the gacha pool; instanceId serves as the deterministic seed (replay-consistent).
 * Differs from `makeDropInstance`: slot is determined by defId, with no random slot-selection step.
 */
export function makeGachaEquipInstance(
  defId: string,
  instanceId: string,
): { id: string; defId: string; rarity: EquipRarity; level: number; affixes: { id: string; value: number }[] } {
  const def = EQUIPMENT_DEFS[defId];
  if (!def) throw new Error(`unknown defId: ${defId}`);
  return {
    id: instanceId,
    defId,
    rarity: def.rarity,
    level: 0,
    affixes: rollCraftedAffixes(defId, instanceId),
  };
}

/** Count of individual inventory instances (stacked items not counted; all instances in this slice are individual, so directly count keys). */
export function equipmentInvCount(inv: Record<string, unknown> | undefined): number {
  return inv ? Object.keys(inv).length : 0;
}

/**
 * Equipment auction cold-start reference unit price (per item, by rarity, DRAFT): fallback when price guardrail sliding window has insufficient samples (AUCTION_DESIGN §4.A/§4.G).
 * Equipment qty is always 1, so "unit price" equals the full item valuation. Derivation goes to ECONOMY_NUMBERS §5.
 */
export const EQUIP_AUCTION_REF_PRICE_BY_RARITY: Record<EquipRarity, number> = {
  common: 50,
  fine: 150,
  rare: 400,
  epic: 1200,
};

// Deterministic drop: instanceId is used as seed; same id always replays the same result (caller passes randomUUID to ensure id uniqueness).
// Slot is randomly selected via instanceId hash (three slots, equal probability); rarity is determined by the caller (pveRewards config).

/**
 * Level drop: produces one +0 base equipment instance (E2 §4).
 * @param rarity Rarity (determined by level configuration).
 * @param instanceId Unique instance id (typically `drop_${randomUUID()}`); also serves as the deterministic seed.
 */
export function makeDropInstance(
  rarity: EquipRarity,
  instanceId: string,
): { id: string; defId: string; rarity: EquipRarity; level: number; affixes: { id: string; value: number }[] } {
  const rng = seededRng(hashSeed(`drop:${instanceId}`));
  const slotIdx = Math.floor(rng() * EQUIP_SLOTS.length);
  const slot = EQUIP_SLOTS[slotIdx]!;
  const def = Object.values(EQUIPMENT_DEFS).find((d) => d.slot === slot && d.rarity === rarity);
  if (!def) throw new Error(`no equipment def for slot=${slot} rarity=${rarity}`);
  return {
    id: instanceId,
    defId: def.defId,
    rarity,
    level: 0,
    affixes: rollCraftedAffixes(def.defId, instanceId),
  };
}

// ── Reforge (E6, EQUIPMENT_DESIGN §7.8) ────────────────────────────────────────
//
// Reforge: retains the main affix (slot-locked) and re-rolls all sub-affixes (sub + future skill).
// Cost: 1 item of the same slot and same rarity (the material degrades by one rarity: fine→common, rare→fine, epic→rare).
// common (0 sub-affixes) cannot be reforged.

/** Reforge cost: target rarity → required material equipment rarity (EQUIPMENT_DESIGN §7.8, ADR-017). */
export const REFORGE_MATERIAL_RARITY: Partial<Record<EquipRarity, EquipRarity>> = {
  fine: 'common',
  rare: 'fine',
  epic: 'rare',
};

/**
 * Reforge: re-rolls sub-affixes (main affix is kept unchanged).
 * @param defId   defId of the equipment being reforged.
 * @param seedKey Idempotency key (same key always produces the same result on replay).
 * @returns New affixes array (main affix + re-rolled sub-affixes).
 */
export function rollReforgedAffixes(
  defId: string,
  seedKey: string,
): { id: string; value: number }[] {
  const def = EQUIPMENT_DEFS[defId];
  if (!def) throw new Error(`unknown defId: ${defId}`);
  const rng = seededRng(hashSeed(`reforge:${defId}:${seedKey}`));
  const out: { id: string; value: number }[] = [];
  // Main affix kept (base value unchanged, enhancement amplification managed by engine)
  const main = MAIN_AFFIX_BY_SLOT[def.slot];
  out.push({ id: main.id, value: main.base });
  // Re-roll all sub-affixes
  const n = CRAFT_SUB_AFFIX_COUNT[def.rarity];
  const pool = [...SUB_AFFIX_POOL];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    const [id, lo, hi] = pool.splice(idx, 1)[0]!;
    const value = lo + Math.floor(rng() * (hi - lo + 1));
    out.push({ id, value });
  }
  return out;
}
