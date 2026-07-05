// Instance picker (scene-level overlay): choosing an equipment/card instance to list, reached from the
// create form's item field. Selecting an instance (or cancelling) returns to the create form.
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { t } from '../../i18n';
import { buildIcon } from '../../render/icons';
import type { EquipmentInstance, CardInstance } from '../../game/meta/SaveData';
import { HUD_H, ROW_H, type Constructor, type AuctionSceneBaseCtor } from './base';

export interface PickerHandlers {
  renderPicker(): void;
  listableEquipment(): EquipmentInstance[];
  listableCards(): CardInstance[];
  selectedInstanceLabel(): string | null;
  openPicker(kind: 'equipment' | 'card'): void;
  cancelPicker(): void;
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

    /** Label of the currently selected equipment/card instance for the create form, or null when none is chosen (or it is no longer listable). */
    selectedInstanceLabel(): string | null {
      if (this.createClass === 'equipment') {
        const inst = this.listableEquipment().find((e) => e.id === this.createEquipId);
        return inst ? `${this.equipName(inst.defId)} +${inst.level}` : null;
      }
      if (this.createClass === 'card') {
        const inst = this.listableCards().find((c) => c.id === this.createCardId);
        return inst ? `${this.cardName(inst.defId)} Lv.${inst.level}` : null;
      }
      return null;
    }

    openPicker(kind: 'equipment' | 'card'): void {
      this.closeModal();
      this.pickerKind = kind;
      this.scrollY = 0;
      this.render();
    }

    /** Cancel the picker and return to the create form (keeps any prior selection). */
    cancelPicker(): void {
      this.pickerKind = null;
      this.scrollY = 0;
      this.render();
      this.openCreateForm();
    }

    renderPicker(): void {
      const { w, h } = this;
      const kind = this.pickerKind!;
      const titleY = HUD_H + 8;
      const title = txt(t(kind === 'equipment' ? 'auction.pickEquip' : 'auction.pickCard'), 14, C.dark, true);
      title.x = 12; title.y = titleY;
      this.bodyLayer.addChild(title);

      const listY = HUD_H + 40;
      const listH = h - listY - 10;

      const equip = kind === 'equipment' ? this.listableEquipment() : [];
      const cards = kind === 'card' ? this.listableCards() : [];
      const count = kind === 'equipment' ? equip.length : cards.length;

      if (count === 0) {
        const lbl = txt(t(kind === 'equipment' ? 'auction.noEquip' : 'auction.noCards'), 13, C.dark);
        lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + listH / 2;
        this.bodyLayer.addChild(lbl);
        return;
      }

      const totalH = count * ROW_H;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));
      let cy = listY - this.scrollY;
      for (let i = 0; i < count; i++) {
        if (cy + ROW_H < listY || cy > listY + listH) { cy += ROW_H; continue; }
        const row = sketchPanel(w - 12, ROW_H - 4, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 4, w) });
        row.x = 6; row.y = cy;
        this.bodyLayer.addChild(row);

        let label: string;
        let locked = false;
        let onPick: () => void;
        if (kind === 'equipment') {
          const e = equip[i]!;
          label = `${this.equipName(e.defId)} +${e.level}`;
          const id = e.id;
          onPick = () => { this.createEquipId = id; this.pickerKind = null; this.scrollY = 0; this.render(); this.openCreateForm(); };
        } else {
          const c = cards[i]!;
          label = `${this.cardName(c.defId)} Lv.${c.level}`;
          locked = c.locked;
          const id = c.id;
          onPick = () => { this.createCardId = id; this.pickerKind = null; this.scrollY = 0; this.render(); this.openCreateForm(); };
        }
        const nameLbl = txt(label, 13, C.dark, true);
        nameLbl.x = 14; nameLbl.y = cy + (ROW_H - 4) / 2 - 8;
        this.bodyLayer.addChild(nameLbl);
        if (locked) {
          const lk = buildIcon('lock', 14, C.mid);
          lk.x = nameLbl.x + nameLbl.width + 6; lk.y = cy + (ROW_H - 4) / 2 - 9;
          this.bodyLayer.addChild(lk);
        }
        const hint = txt(t('auction.pickHint'), 11, C.accent, true);
        hint.anchor.set(1, 0.5); hint.x = w - 16; hint.y = cy + ROW_H / 2 - 2;
        this.bodyLayer.addChild(hint);

        this.hitRects.push({ rect: { x: 6, y: cy, w: w - 12, h: ROW_H - 4 }, action: onPick });
        cy += ROW_H;
      }
    }
  };
}
