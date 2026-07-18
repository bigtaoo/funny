// Bag "assign to card" sub-mode. Reached only in bag mode (roster group): tapping Equip on a bag
// item opens a full-view card picker (reusing the main drag-scroll), and choosing a card equips
// the item onto that card.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { FACTION_COLOR } from '../../render/factionIcon';
import { UNIT_ART_URLS, getArtTexture } from '../../render/cardArt';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import type { SaveData, EquipSlot, CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS, cardPower } from '../../game/meta/cardDefs';
import { type Constructor, type EquipmentSceneBaseCtor, RES_H, SLOTS } from './base';

// Card-picker grid: icon cards mirroring the Hero Roster (CardScene/list.ts) so the assign flow reads
// with the same visual language — full-height portrait + name/stars/power stacked to its right, plus
// an assign-specific slot-occupant hint (Slot free / Now: <item>) along the bottom.
const PICK_CELL_H = 266;      // matches CARD_CELL_H (roster hero cards)
const PICK_CELL_W_TARGET = 300;
const PICK_COLS = 5;
const PICK_GAP = 24;

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

      const sidebarW = sidebarNavW(w, h, this.landscape);
      const top = this.headerH;
      const barBg = new PIXI.Graphics();
      barBg.beginFill(0xf3f1ea).drawRect(sidebarW, top, w - sidebarW, RES_H).endFill();
      this.bodyLayer.addChild(barBg);
      const title = txt(t('equip.assignTitle').replace('{name}', this.itemLabel(inst.defId, inst.level)), FS.label, C.dark, true);
      title.anchor.set(0.5, 0.5); title.x = sidebarW + (w - sidebarW) / 2; title.y = top + RES_H / 2;
      this.bodyLayer.addChild(title);

      const listY = top + RES_H;
      const listH = h - listY - 8;
      const cards = Object.values(save.cardInv ?? {});
      if (cards.length === 0) {
        const lbl = txt(t('equip.assignEmpty'), FS.heading, C.mid);
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

      // Icon-card grid, packed like the Hero Roster: fixed PICK_COLS per row (clamped on narrow
      // viewports), roomier gaps, portrait-tall cells.
      const left = sidebarW + PICK_GAP;
      const avail = w - left - PICK_GAP;
      const cols = Math.max(1, Math.min(PICK_COLS, Math.floor((avail + PICK_GAP) / (PICK_CELL_W_TARGET + PICK_GAP))));
      const cellW = (avail - PICK_GAP * (cols - 1)) / cols;
      const rows = Math.ceil(sorted.length / cols);
      const totalH = rows * (PICK_CELL_H + PICK_GAP) + PICK_GAP;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));

      sorted.forEach((card, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = left + col * (cellW + PICK_GAP);
        const y = listY + PICK_GAP + row * (PICK_CELL_H + PICK_GAP) - this.scrollY;
        if (y + PICK_CELL_H >= listY && y <= listY + listH) this.renderAssignCell(card, x, y, cellW, slot, save);
      });

      drawScrollIndicator(this.bodyLayer, { x: left, y: listY, w: avail, h: listH }, this.scrollY, Math.max(0, totalH - listH));
    }

    /**
     * Assign-picker card cell: mirrors the Hero Roster cell (full-height portrait + name/level-stars/
     * power stacked to its right) and adds an assign-specific slot-occupant hint along the bottom so
     * the player knows whether equipping here fills a free slot or swaps out the current piece.
     */
    private renderAssignCell(card: CardInstance, x: number, y: number, cellW: number, slot: EquipSlot, save: SaveData): void {
      const def = CARD_DEFS[card.defId];
      const pad = 10;

      const cell = sketchPanel(cellW, PICK_CELL_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cellW) });
      cell.x = x; cell.y = y;
      this.bodyLayer.addChild(cell);

      // ── Left: full-height portrait in a light frame ──
      const imgH = PICK_CELL_H - pad * 2;
      const imgW = Math.round(imgH * 0.72);
      const imgX = x + pad;
      const imgY = y + pad;
      const frame = sketchPanel(imgW, imgH, { fill: 0xf0eee7, border: C.mid, seed: seedFor(x, y, imgW) });
      frame.x = imgX; frame.y = imgY;
      this.bodyLayer.addChild(frame);
      const artUrl = def ? UNIT_ART_URLS[def.unitType] : undefined;
      if (artUrl) this.drawCardArt(artUrl, imgX + 2, imgY + 2, imgW - 4, imgH - 4);

      // ── Right: info column ──
      const ax = imgX + imgW + 12;
      const rightW = x + cellW - pad - ax;

      const dot = new PIXI.Graphics();
      dot.beginFill(FACTION_COLOR[def?.faction ?? 'tao']).drawCircle(0, 0, 5).endFill();
      dot.x = ax + 5; dot.y = y + pad + 7;
      this.bodyLayer.addChild(dot);

      const nameLbl = txt(t(`card.${card.defId}.name` as TranslationKey), FS.bodyLg, C.dark, true);
      nameLbl.x = ax + 16; nameLbl.y = y + pad;
      nameLbl.style.wordWrap = false;
      if (nameLbl.width > rightW - 16) nameLbl.scale.set(Math.min(1, (rightW - 16) / nameLbl.width));
      this.bodyLayer.addChild(nameLbl);

      let ay = y + pad + 34;
      // Level as a row of gold stars (one filled star per level, max 9), shrunk to fit the column.
      const stars = new PIXI.Container();
      const starN = Math.max(1, Math.min(9, card.level));
      const starSize = 15;
      const starGap = 3;
      for (let i = 0; i < starN; i++) {
        const st = buildIcon('star', starSize, C.gold);
        st.x = i * (starSize + starGap);
        stars.addChild(st);
      }
      const starsW = starN * starSize + (starN - 1) * starGap;
      if (starsW > rightW) stars.scale.set(rightW / starsW);
      stars.x = ax; stars.y = ay;
      this.bodyLayer.addChild(stars);
      ay += 24;

      const power = Math.round(cardPower(card, save.equipmentInv ?? {}));
      const pwrLbl = txt(`${t('roster.power')} ${power}`, FS.small, C.dark);
      pwrLbl.x = ax; pwrLbl.y = ay; this.bodyLayer.addChild(pwrLbl);

      // ── Bottom: slot-occupant hint (Slot free / Now: <item>), with the current item's icon ──
      const curId = card.gear[slot];
      const cur = curId ? save.equipmentInv[curId] : undefined;
      const hintY = y + PICK_CELL_H - pad - 20;
      let hintX = ax;
      let hintW = rightW;
      if (cur) {
        const iconSize = 22;
        this.addGlyph(slot, cur.rarity, ax + iconSize / 2, hintY + FS.tiny / 2, iconSize, seedFor(x, y, cellW), 1, cur.defId);
        hintX = ax + iconSize + 6;
        hintW = rightW - iconSize - 6;
      }
      const hint = txt(
        cur ? t('equip.assignCurrent').replace('{name}', this.itemLabel(cur.defId, cur.level)) : t('equip.assignSlotFree'),
        FS.tiny, cur ? C.gold : C.mid,
      );
      hint.x = hintX; hint.y = hintY;
      hint.style.wordWrap = true; hint.style.wordWrapWidth = hintW;
      this.bodyLayer.addChild(hint);

      const cardId = card.id;
      this.hitRects.push({ rect: { x, y, w: cellW, h: PICK_CELL_H }, action: () => void this.doEquipTo(cardId) });
    }

    /** Draw a unit portrait fitted into (x, y, box × boxH); re-renders once the texture finishes loading. */
    private drawCardArt(url: string, x: number, y: number, box: number, boxH: number): void {
      const tex = getArtTexture(url);
      if (!tex.baseTexture.valid) {
        if (!this.assignArtHooked.has(url)) {
          this.assignArtHooked.add(url);
          tex.baseTexture.once('loaded', () => this.render());
        }
        return;
      }
      const scale = Math.min(box / tex.width, boxH / tex.height);
      const sp = new PIXI.Sprite(tex);
      sp.anchor.set(0.5);
      sp.scale.set(scale);
      sp.position.set(x + box / 2, y + boxH / 2);
      this.bodyLayer.addChild(sp);
    }

    private readonly assignArtHooked = new Set<string>();
  };
}
