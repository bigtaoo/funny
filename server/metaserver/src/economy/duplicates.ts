// Gacha result duplicate/NEW-badge bookkeeping (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08). Split out
// of economy.ts (2026-08-10, 独立函数模块 form — see economy.ts's facade comment). Pure functions, no
// shared state with the delivery/order-routing/ads-gate siblings — only `markDuplicates` is consumed
// by orders.ts (deliverLootBox).
import type { Rarity, SaveData } from '@nw/shared';
import { CARD_DEFS, EQUIPMENT_DEFS, GACHA_MATERIAL_GRANTS } from '@nw/shared';
import type { GachaResultEntry } from '../commercialClient.js';

/**
 * Mark each result as duplicate or not — drives the reveal UI's NEW badge. "Duplicate" means
 * lifetime ownership, not merely current possession (2026-08-08 fix; the previous version only
 * special-cased character cards — see the two bug classes below — and dumped materials/equipment
 * into the generic "skin" branch, whose within-batch-only dedup meant a material/equipment item the
 * player had owned for ages still got badged NEW on every draw as long as it wasn't a *second* copy
 * within the very same pull):
 *   - materials/equipment routed to `save.materials`/`equipmentInstances` (not `inventory.skins`)
 *     were never checked against real ownership at all — every first-in-batch material/equipment
 *     result showed NEW regardless of how much was already in the bag.
 *   - character cards routed to `cardInv` were checked against `ownedCardDefIds`, which is correct
 *     but doesn't survive every last copy of a defId being consumed away (fusion fodder) — same gap
 *     equipment/materials have when spent to zero then re-earned.
 * Callers own the ownership computation per kind, unioning the live inventory (current cardInv/
 * equipmentInstances/materials-with-count>0) with that kind's `save.everOwned.*` ledger (additive-
 * only, survives salvage/consume/sell — see SaveData.everOwned doc comment) so a legacy save whose
 * everOwned ledger has gaps still gets the right answer from the live inventory, and vice versa.
 *
 * `newSkins` stays a separate concern from the skin `duplicate` flag: it drives `inventory.skins`
 * $addToSet (has this exact skinId ever landed in the array?), which must stay keyed off the plain
 * array — a skin currently absent from inventory.skins (sold via auction escrow) needs re-adding
 * even though `everOwned.skin` means it's not a "NEW" pull.
 */
export function markDuplicates(
  ownedSkins: string[],
  everOwnedSkins: string[],
  ownedHero: string[],
  ownedEquipment: string[],
  ownedMaterial: string[],
  results: GachaResultEntry[],
): { newSkins: string[]; marked: { itemId: string; rarity: Rarity; duplicate: boolean }[] } {
  const owned = new Set(ownedSkins);
  const everOwnedSkin = new Set(everOwnedSkins);
  const ownedHeroSet = new Set(ownedHero);
  const ownedEquipSet = new Set(ownedEquipment);
  const ownedMaterialSet = new Set(ownedMaterial);
  const newSkins: string[] = [];
  const marked = results.map((r) => {
    if (CARD_DEFS[r.itemId]) {
      const duplicate = ownedHeroSet.has(r.itemId);
      if (!duplicate) ownedHeroSet.add(r.itemId);
      return { itemId: r.itemId, rarity: r.rarity, duplicate };
    }
    if (EQUIPMENT_DEFS[r.itemId]) {
      const duplicate = ownedEquipSet.has(r.itemId);
      if (!duplicate) ownedEquipSet.add(r.itemId);
      return { itemId: r.itemId, rarity: r.rarity, duplicate };
    }
    const matGrant = GACHA_MATERIAL_GRANTS[r.itemId];
    if (matGrant) {
      const matKey = Object.keys(matGrant)[0]!;
      const duplicate = ownedMaterialSet.has(matKey);
      if (!duplicate) ownedMaterialSet.add(matKey);
      return { itemId: r.itemId, rarity: r.rarity, duplicate };
    }
    // Skin: `alreadyInInv` alone still decides `newSkins` (what to $addToSet); `duplicate` (the badge)
    // additionally checks everOwnedSkin so a re-pulled, previously-sold skin doesn't show NEW.
    const alreadyInInv = owned.has(r.itemId);
    const duplicate = alreadyInInv || everOwnedSkin.has(r.itemId);
    if (!alreadyInInv) {
      owned.add(r.itemId);
      newSkins.push(r.itemId);
    }
    return { itemId: r.itemId, rarity: r.rarity, duplicate };
  });
  return { newSkins, marked };
}

/**
 * Union the live inventory (current cardInstances/equipmentInstances defIds + materials-with-
 * count>0) with each kind's `save.everOwned.*` ledger into the ownedHero/ownedEquipment/
 * ownedMaterial inputs `markDuplicates` needs. See `markDuplicates`'s doc comment for why the union
 * — live inventory covers a legacy save whose everOwned ledger predates that item's first grant;
 * everOwned covers an item since spent/salvaged/fused away entirely. Pure/sync so callers can fetch
 * `cardDocs`/`equipDocs` concurrently with the save read instead of serializing after it.
 */
export function unionOwnershipForDuplicateCheck(
  cardDefIds: string[],
  equipDefIds: string[],
  save: SaveData,
): { ownedHero: string[]; ownedEquipment: string[]; ownedMaterial: string[] } {
  const ownedHero = [...new Set([...cardDefIds, ...(save.everOwned?.hero ?? [])])];
  const ownedEquipment = [...new Set([...equipDefIds, ...(save.everOwned?.equipment ?? [])])];
  const ownedMaterial = [...new Set([
    ...Object.entries(save.materials ?? {}).filter(([, n]) => n > 0).map(([k]) => k),
    ...(save.everOwned?.material ?? []),
  ])];
  return { ownedHero, ownedEquipment, ownedMaterial };
}
