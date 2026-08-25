// Equipment mutation callbacks (E5) — the craft / enhance / salvage / equip / reforge half of
// EquipmentCallbacks, split out of ./campaignRoster.ts (2026-08-25) when the ADR-072 overlay wiring
// pushed that file over the 500-line convention. Form① free function: this block never touched the
// nav closure (no `views`/`nav`/`state`), only the API client + the save mirror + analytics, which is
// exactly why it is the clean seam. What stayed behind in campaignRoster.ts is the part that IS nav —
// which scene to mount, with which peer tabs, and where `back` goes.
//
// Every one of these follows the same server-authoritative shape: call the endpoint, fold the lean
// response into the local save mirror (adoptServerPartial), track, and map any error code to an i18n
// key via {@link equipErrKey}.
import * as analytics from '../../../analytics';
import type { TranslationKey } from '../../../i18n';
import { ApiError, type ApiClient } from '../../../net/ApiClient';
import { genUuid } from '../../../platform/uuid';
import type { EquipSlot } from '../../../game/meta/SaveData';
import type { SaveManager } from '../../../game/meta/SaveManager';
import type { EquipmentCallbacks } from '../../../scenes/EquipmentScene';

/** Map equipment endpoint error codes → i18n key (E5). */
function equipErrKey(e: unknown): TranslationKey {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'INSUFFICIENT_MATERIALS': return 'equip.err.materials';
      case 'INSUFFICIENT_FUNDS':     return 'equip.err.coins';
      case 'INVENTORY_FULL':         return 'equip.err.full';
      case 'ENHANCE_MAX_LEVEL':      return 'equip.err.maxLevel';
      case 'NOT_SALVAGEABLE':        return 'equip.err.notSalvageable';
      case 'INVALID_SLOT':           return 'equip.err.invalidSlot';
      case 'EQUIP_LOCKED':           return 'equip.err.locked';
      case 'EQUIP_IN_USE':           return 'equip.err.inUse';
      case 'NOT_REFORGE_ELIGIBLE':   return 'equip.err.notReforgeEligible';
      case 'INVALID_RARITY':         return 'equip.err.invalidRarity';
    }
  }
  return 'equip.err.generic';
}

/** The mutation half of EquipmentCallbacks, bound to one logged-in API client + save mirror. */
export function buildEquipmentActions(
  client: ApiClient,
  saveManager: SaveManager,
): Pick<EquipmentCallbacks, 'craft' | 'enhance' | 'salvage' | 'equip' | 'reforge'> {
  return {
    async craft(defId: string) {
      try {
        const { save, instance } = await client.craftEquipment(defId, genUuid());
        saveManager.adoptServerPartial(save, { upsert: [instance] });
        analytics.track('equip_craft', { def_id: defId });
        return { ok: true as const };
      } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
    },
    async enhance(instanceId: string, useProtect?: boolean) {
      // Captured before the call (not derived from the response) because a failed +7/+8 attempt can
      // now demote the item (ADR-063) — `instance.level - (success?1:0)` would silently mis-attribute
      // a demoted result's from_level once level could move by more than the success/fail delta.
      const fromLevel = saveManager.get().equipmentInv[instanceId]?.level ?? 0;
      try {
        const { success, instance, save } = await client.enhanceEquipment(instanceId, genUuid(), useProtect);
        saveManager.adoptServerPartial(save, { upsert: [instance] });
        analytics.track('equip_enhance', {
          def_id: instance.defId, from_level: fromLevel, success,
          demoted: instance.level < fromLevel, use_protect: !!useProtect,
        });
        return { ok: true as const, success, level: instance.level };
      } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
    },
    async salvage(instanceIds: string[]) {
      try {
        const { save } = await client.salvageEquipment(instanceIds, genUuid());
        saveManager.adoptServerPartial(save, { remove: instanceIds });
        analytics.track('equip_salvage', { count: instanceIds.length });
        return { ok: true as const };
      } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
    },
    async equip(slot: EquipSlot, instanceId: string | null, cid: string) {
      try {
        const { save } = await client.equipEquipment(slot, instanceId, cid);
        // The response is lean (cardInv omitted, EQUIPMENT_DESIGN §3.3 phase 2) — equip only moves a
        // gear pointer on `cid`'s card, so mirror that single mutation locally via cardUpsert instead
        // of leaving the local cardInv stale (adoptServerPartial's own cardInv reconstruction otherwise
        // just re-applies the unchanged local copy, so nothing reflected the new/removed gear pointer
        // until the next full save refresh — CardScene/the Equipped loadout strip stayed stuck showing
        // the pre-equip gear, 2026-07-29 fix). Mirrors equipEquipment's own gear[slot] mutation exactly.
        const card = saveManager.get().cardInv[cid];
        const cardUpsert = card ? (() => {
          const gear = { ...card.gear };
          if (instanceId === null) delete gear[slot]; else gear[slot] = instanceId;
          return [{ ...card, gear }];
        })() : undefined;
        saveManager.adoptServerPartial(save, { cardUpsert });
        analytics.track('equip_equip', { slot, instance_id: instanceId ?? '', card_instance_id: cid });
        return { ok: true as const };
      } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
    },
    async reforge(targetId: string, materialId: string) {
      try {
        const { instance, save } = await client.reforgeEquipment(targetId, materialId, genUuid());
        saveManager.adoptServerPartial(save, { upsert: [instance], remove: [materialId] });
        analytics.track('equip_reforge', { target_id: targetId });
        return { ok: true as const };
      } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
    },
  };
}
