// Unified item picker (scene-level overlay): choosing what to list, reached from the create form's item
// field. Lists every sellable item across all three classes (materials + equipment + cards) in one scrollable
// list, sorted by estimated value descending. Picking an entry returns to the create form.
import { AUCTION_STATIC_REF_PRICE } from '@nw/shared';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { t } from '../../i18n';
import { buildIcon, type IconKind } from '../../render/icons';
import type { EquipmentInstance, CardInstance, EquipRarity } from '../../game/meta/SaveData';
import { HUD_H, ROW_H, MATERIALS, type Constructor, type AuctionSceneBaseCtor } from './base';

// Client tsconfig maps @nw/shared → server/shared/src/slg/index.ts only, so the server's per-rarity/per-card
// auction reference prices (equipment.ts, not under slg/) aren't reachable here. These mirror the server's
// EQUIP_AUCTION_REF_PRICE_BY_RARITY values for sort-order purposes only — not a suggested listing price.
const EQUIP_VALUE_BY_RARITY: Record<EquipRarity, number> = { common: 50, fine: 150, rare: 400, epic: 1200 };
// Cards have no server reference price at all — this is a level-based sort heuristic only.
const CARD_VALUE_BASE = 500;
const CARD_VALUE_PER_LEVEL = 300;

interface PickEntry {
  icon: IconKind;
  label: string;
  value: number;
  locked: boolean;
  onPick: () => void;
}

export interface PickerHandlers {
  renderItemPicker(): void;
  listableEquipment(): EquipmentInstance[];
  listableCards(): CardInstance[];
  selectedItemLabel(): string | null;
  openItemPicker(): void;
  cancelItemPicker(): void;
}

export function PickerMixin<TBase extends AuctionSceneBaseCtor>(Base: TBase): TBase & Constructor<PickerHandlers> {
  return class extends Base {
    /** Equipment instances eligible for listing: not locked and not equipped by any card (mirrors server escrow guard). */
    listableEquipment(): EquipmentInstance[] {
      const save = this.cb.getSave?.();
      if (!save) return [];
      const equippedIds = new Set<string>();
      for (const card of Object.values(save.cardInv ?? {})) {
        for (const id of Object.values(card.gear ?? {})) if (id) equippedIds.add(id);
      }
      return Object.values(save.equipmentInv ?? {}).filter((e) => !e.locked && !equippedIds.has(e.id));
    }

    /** Card instances eligible for listing: gear must be empty before listing (mirrors server escrow guard, §11). */
    listableCards(): CardInstance[] {
      const save = this.cb.getSave?.();
      if (!save) return [];
      return Object.values(save.cardInv ?? {}).filter((c) => !Object.values(c.gear ?? {}).some((v) => !!v));
    }

    /** Label of the currently selected item (any class) for the create form, or null when none is chosen (or it is no longer listable). */
    selectedItemLabel(): string | null {
      if (this.createClass === 'material') {
        return t(`auction.${this.createMaterial}` as 'auction.scrap' | 'auction.lead' | 'auction.binding');
      }
      if (this.createClass === 'equipment') {
        const inst = this.listableEquipment().find((e) => e.id === this.createEquipId);
        return inst ? `${this.equipName(inst.defId)} +${inst.level}` : null;
      }
      const inst = this.listableCards().find((c) => c.id === this.createCardId);
      return inst ? `${this.cardName(inst.defId)} Lv.${inst.level}` : null;
    }

    /** Combined pick list across all three classes, sorted by estimated value descending. */
    private buildPickEntries(): PickEntry[] {
      const entries: PickEntry[] = [];
      for (const mat of MATERIALS) {
        entries.push({
          icon: mat, label: t(`auction.${mat}` as 'auction.scrap' | 'auction.lead' | 'auction.binding'),
          value: AUCTION_STATIC_REF_PRICE[mat] ?? 0, locked: false,
          onPick: () => { this.createClass = 'material'; this.createMaterial = mat; this.closeItemPicker(); },
        });
      }
      for (const e of this.listableEquipment()) {
        entries.push({
          icon: 'armor', label: `${this.equipName(e.defId)} +${e.level}`,
          value: EQUIP_VALUE_BY_RARITY[e.rarity] ?? 0, locked: false,
          onPick: () => { this.createClass = 'equipment'; this.createEquipId = e.id; this.closeItemPicker(); },
        });
      }
      for (const c of this.listableCards()) {
        entries.push({
          icon: 'cards', label: `${this.cardName(c.defId)} Lv.${c.level}`,
          value: CARD_VALUE_BASE + (c.level - 1) * CARD_VALUE_PER_LEVEL, locked: c.locked,
          onPick: () => { this.createClass = 'card'; this.createCardId = c.id; this.closeItemPicker(); },
        });
      }
      entries.sort((a, b) => b.value - a.value);
      return entries;
    }

    openItemPicker(): void {
      this.closeModal();
      this.itemPickerOpen = true;
      this.scrollY = 0;
      this.render();
    }

    private closeItemPicker(): void {
      this.itemPickerOpen = false;
      this.scrollY = 0;
      this.render();
      this.openCreateForm();
    }

    /** Cancel the picker and return to the create form (keeps any prior selection). */
    cancelItemPicker(): void {
      this.itemPickerOpen = false;
      this.scrollY = 0;
      this.render();
      this.openCreateForm();
    }

    renderItemPicker(): void {
      const { w, h } = this;
      const titleY = HUD_H + 8;
      const title = txt(t('auction.pickItem'), 14, C.dark, true);
      title.x = 12; title.y = titleY;
      this.bodyLayer.addChild(title);

      const listY = HUD_H + 40;
      const listH = h - listY - 10;

      const entries = this.buildPickEntries();
      if (entries.length === 0) {
        const lbl = txt(t('auction.noItems'), 13, C.dark);
        lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + listH / 2;
        this.bodyLayer.addChild(lbl);
        return;
      }

      const totalH = entries.length * ROW_H;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));
      let cy = listY - this.scrollY;
      for (const entry of entries) {
        if (cy + ROW_H < listY || cy > listY + listH) { cy += ROW_H; continue; }
        const row = sketchPanel(w - 12, ROW_H - 4, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 4, w) });
        row.x = 6; row.y = cy;
        this.bodyLayer.addChild(row);

        const ic = buildIcon(entry.icon, 16, C.dark);
        ic.x = 14; ic.y = cy + (ROW_H - 4) / 2 - 8;
        this.bodyLayer.addChild(ic);

        const nameLbl = txt(entry.label, 13, C.dark, true);
        nameLbl.x = 36; nameLbl.y = cy + (ROW_H - 4) / 2 - 8;
        this.bodyLayer.addChild(nameLbl);
        if (entry.locked) {
          const lk = buildIcon('lock', 14, C.mid);
          lk.x = nameLbl.x + nameLbl.width + 6; lk.y = cy + (ROW_H - 4) / 2 - 9;
          this.bodyLayer.addChild(lk);
        }
        const hint = txt(t('auction.pickHint'), 11, C.accent, true);
        hint.anchor.set(1, 0.5); hint.x = w - 16; hint.y = cy + ROW_H / 2 - 2;
        this.bodyLayer.addChild(hint);

        this.hitRects.push({ rect: { x: 6, y: cy, w: w - 12, h: ROW_H - 4 }, action: entry.onPick });
        cy += ROW_H;
      }
    }
  };
}
