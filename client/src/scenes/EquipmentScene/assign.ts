// Bag "assign to card" sub-mode. Reached only in bag mode (roster group): tapping Equip on a bag
// item opens a full-view card picker (reusing the main drag-scroll), and choosing a card equips
// the item onto that card.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, marginLineX } from '../../render/sketchUi';
import type { SaveData, EquipSlot, CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS, cardPower } from '../../game/meta/cardDefs';
import { type Constructor, type EquipmentSceneBaseCtor, HUD_H, RES_H, ROW_H, SLOTS } from './base';

export interface AssignHandlers {
  renderAssign(save: SaveData): void;
  cancelAssign(): void;
  beginAssign(instId: string, slot: EquipSlot): void;
  ownerCardId(save: SaveData, instId: string): string | null;
}

export function AssignMixin<TBase extends EquipmentSceneBaseCtor>(Base: TBase): TBase & Constructor<AssignHandlers> {
  return class extends Base {
    /** Find the card currently wearing `instId` in any slot (bag-mode unequip needs the owner). */
    ownerCardId(save: SaveData, instId: string): string | null {
      for (const card of Object.values(save.cardInv ?? {})) {
        for (const slot of SLOTS) if (card.gear[slot] === instId) return card.id;
      }
      return null;
    }

    beginAssign(instId: string, slot: EquipSlot): void {
      this.assign = { instId, slot };
      this.detailId = null;
      this.closeModal();
      this.scrollY = 0;
      this.render();
    }

    cancelAssign(): void {
      this.assign = null;
      this.scrollY = 0;
      this.render();
    }

    private async doEquipTo(cardId: string): Promise<void> {
      if (!this.assign || this.bt.busy) return;
      const { instId, slot } = this.assign;
      this.assign = null;
      this.scrollY = 0;
      await this.doEquip(slot, instId, cardId);
    }

    /** Full-view card picker shown while assigning a bag item to a card (reuses the main scrollY). */
    renderAssign(save: SaveData): void {
      const { w, h } = this;
      if (!this.assign) return;
      const inst = save.equipmentInv[this.assign.instId];
      if (!inst) { this.assign = null; this.render(); return; }
      const slot = this.assign.slot;

      const sidebarW = marginLineX(w);
      const top = HUD_H;
      const barBg = new PIXI.Graphics();
      barBg.beginFill(0xf3f1ea).drawRect(sidebarW, top, w - sidebarW, RES_H).endFill();
      this.bodyLayer.addChild(barBg);
      const title = txt(t('equip.assignTitle').replace('{name}', `${this.itemName(inst.defId)} +${inst.level}`), 12, C.dark, true);
      title.anchor.set(0.5, 0.5); title.x = sidebarW + (w - sidebarW) / 2; title.y = top + RES_H / 2;
      this.bodyLayer.addChild(title);

      const listY = top + RES_H;
      const listH = h - listY - 8;
      const cards = Object.values(save.cardInv ?? {});
      if (cards.length === 0) {
        const lbl = txt(t('equip.assignEmpty'), 13, C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = sidebarW + (w - sidebarW) / 2; lbl.y = listY + listH / 2;
        this.bodyLayer.addChild(lbl);
        return;
      }

      const equipInv = save.equipmentInv ?? {};
      const sorted = [...cards].sort((a, b) => {
        const pd = cardPower(b, equipInv) - cardPower(a, equipInv);
        if (pd !== 0) return pd;
        if (b.level !== a.level) return b.level - a.level;
        return a.id < b.id ? -1 : 1;
      });
      const totalH = sorted.length * ROW_H;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));
      let cy = listY - this.scrollY;
      for (const card of sorted) {
        if (cy + ROW_H >= listY && cy <= listY + listH) this.renderAssignRow(card, cy, slot, save);
        cy += ROW_H;
      }
    }

    private renderAssignRow(card: CardInstance, cy: number, slot: EquipSlot, save: SaveData): void {
      const { w } = this;
      const left = marginLineX(w) + 6;
      const rowW = w - left - 6;
      const def = CARD_DEFS[card.defId];
      const row = sketchPanel(rowW, ROW_H - 4, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 30, w) });
      row.x = left; row.y = cy;
      this.bodyLayer.addChild(row);

      const factionColor = def?.faction === 'anna' ? 0xcc4466 : 0x4477cc;
      const dot = new PIXI.Graphics();
      dot.beginFill(factionColor).drawCircle(0, 0, 5).endFill();
      dot.x = left + 12; dot.y = cy + 18;
      this.bodyLayer.addChild(dot);

      const nameLbl = txt(t(`card.${card.defId}.name` as TranslationKey), 13, C.dark, true);
      nameLbl.x = left + 24; nameLbl.y = cy + 8;
      this.bodyLayer.addChild(nameLbl);
      const lvLbl = txt(`Lv.${card.level}`, 11, C.mid);
      lvLbl.x = left + 24; lvLbl.y = cy + 26;
      this.bodyLayer.addChild(lvLbl);

      // Current occupant of the target slot (so the player knows an equip here will swap it out).
      const curId = card.gear[slot];
      const cur = curId ? save.equipmentInv[curId] : undefined;
      const curLbl = txt(
        cur ? t('equip.assignCurrent').replace('{name}', `${this.itemName(cur.defId)} +${cur.level}`) : t('equip.assignSlotFree'),
        10, cur ? C.gold : C.mid,
      );
      curLbl.anchor.set(1, 0.5); curLbl.x = w - 18; curLbl.y = cy + ROW_H / 2 - 2;
      this.bodyLayer.addChild(curLbl);

      const cardId = card.id;
      this.hitRects.push({ rect: { x: left, y: cy, w: rowW, h: ROW_H - 4 }, action: () => void this.doEquipTo(cardId) });
    }
  };
}
