// Pure types/interfaces for the EquipmentScene composition (see ../EquipmentScene.ts assembly and
// ./core.ts's file-header comment) — zero logic, split out of core.ts purely to keep it under the
// 500-line convention (claudedocs/client-modules.md's split-form priority note). core.ts re-exports
// everything here so existing `from './core'` (formerly `from './base'`) imports keep resolving.
import type { TranslationKey } from '../../i18n';
import type { SaveData, EquipSlot } from '../../game/meta/SaveData';
import type { IconKind } from '../../render/icons';

export type EquipResult = { ok: true } | { ok: false; key: TranslationKey };
export type EnhanceResult =
  | { ok: true; success: boolean; level: number }
  | { ok: false; key: TranslationKey };

export interface EquipmentCallbacks {
  onBack(): void;
  /**
   * Peer-level navigation within a progression hub group (LOBBY_IA_REDESIGN P1.5). Injected only in
   * a group context; when set, a [<peer>|Equipment] tab strip appears below the header and tapping
   * the peer runs onSelect (back to the sibling scene). Absent from the campaign entry and the
   * per-card edit entry → no strip, plain back.
   *   - from Collection : { labelKey: 'collection.title', ... }  → [Collection|Equipment]
   *   - from Card roster : { labelKey: 'roster.title', ... }      → [Cards|Equipment]
   */
  peerTab?: { labelKey: TranslationKey; icon?: IconKind; onSelect(): void };
  /**
   * Peers that sit *after* Equipment in the growth group and so must render below Equipment's own
   * Inventory/Craft sub-tabs, not be dropped. The roster group is [Cards | Equipment | Skins]: the
   * leading Cards peer comes in via {@link peerTab}, and Skins is injected here so it stays visible —
   * shifted down under the sub-tabs — instead of vanishing when Equipment is the active scene
   * (LOBBY_IA_REDESIGN §15). See InventoryPanel.renderSidebar.
   */
  trailingPeers?: { labelKey: TranslationKey; icon?: IconKind; onSelect(): void }[];
  /** Read the current authoritative save (server pushes after each action → adoptServer; this scene re-reads and redraws). */
  getSave(): SaveData;
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene changes the save (wallet/inventory/...). Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
  craft(defId: string): Promise<EquipResult>;
  /** When useProtect=true, consume a protect-enhance item; on failure no materials are lost (E7 §6.2). */
  enhance(instanceId: string, useProtect?: boolean): Promise<EnhanceResult>;
  salvage(instanceIds: string[]): Promise<EquipResult>;
  /**
   * Equip / unequip an equipment piece onto the active card (CC-1).
   * cardInstanceId is the hero card that owns this loadout slot.
   */
  equip(slot: EquipSlot, instanceId: string | null, cardInstanceId: string): Promise<EquipResult>;
  /** Reforge (E6): consume the item identified by materialId to re-roll the secondary affixes of targetId. */
  reforge(targetId: string, materialId: string): Promise<EquipResult>;
  /** The card instance whose gear this EquipmentScene is editing (CC-1 flow: CardScene → EquipmentScene). */
  readonly activeCardInstanceId: string;
  /** Slot to pre-select in the inventory filter bar on entry (a specific gear-slot tap from CardScene); defaults to "All". */
  readonly initialFilterSlot?: EquipSlot;
}

export type EquipTab = 'inv' | 'craft';

/**
 * Label + glyph for the two sub-tabs, shared by BOTH strips that draw them: landscape's sidebar rail
 * (InventoryPanel.renderSidebar) and portrait's header strip (the assembly's renderHeaderRow, §18).
 * One table because they are one control drawn two ways — the batch-5 wiring first landed only on the
 * sidebar, and portrait silently kept its label-only cells.
 *
 * The glyphs are a backpack and an anvil. Never a hammer for the forge: that shape is already
 * `bidTabIcon`, the auction gavel (design/product/tab-icon-art-prompts-batch5.md).
 */
export const EQUIP_SUBTABS: { key: EquipTab; label: TranslationKey; icon: IconKind }[] = [
  { key: 'inv', label: 'equip.tabInv', icon: 'bagTabIcon' },
  { key: 'craft', label: 'equip.tabCraft', icon: 'craftTabIcon' },
];
export type SectionKey = 'equipped' | 'bag';

export interface Rect { x: number; y: number; w: number; h: number; }

/**
 * A single on-card action button (Enhance / Equip / Unequip / Reforge / Salvage / Salvage All).
 * Only *available* actions are emitted — unavailable ones (unaffordable enhance, reforge without a
 * matching material, salvage on an equipped/locked piece, …) are omitted entirely rather than shown
 * disabled, so the grid cell hides them rather than greying them out. A momentarily-busy action
 * (another action already in flight) is the one exception — it stays in the list with `disabled:
 * true` instead of being omitted (2026-07-28 fix: omitting it shrank the button band and resized
 * every cell's icon frame for the whole grid while any single action was in flight, reading as the
 * grid getting "stretched"). `fn` fires the action directly (equip / confirm dialog / material
 * picker), bypassing the info modal — except Enhance, whose `fn` opens that modal instead (it needs
 * the modal's protect-stone toggle before it can commit, 2026-07-22b). See DetailPanel.instanceActions.
 */
export interface CellAction {
  key: string;
  label: string;
  icon: IconKind;
  fill: number;
  stroke: number;
  disabled?: boolean;
  fn: () => void;
}

/** Column count + cell width + centering offset for the inventory grid (InventoryPanel.renderInventory). */
export interface EquipGridLayout { cols: number; cellW: number; offset: number; }
