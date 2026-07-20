// Craft tab: the craftable-equipment grid (icon-card cells with cost chips + Craft button) and the
// craft action itself.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import type { SaveData } from '../../game/meta/SaveData';
import { craftableDefs, getEquipDef, EQUIPMENT_INV_CAP } from '../../game/meta/equipmentDefs';
import {
  type Constructor, type EquipmentSceneBaseCtor,
  CELL_GAP, CELL_GAP_X, EQUIP_CELL_W_TARGET, CRAFT_CELL_H, RARITY_COLOR,
} from './base';

export interface CraftHandlers {
  renderCraft(bodyTop: number): void;
}

export function CraftMixin<TBase extends EquipmentSceneBaseCtor>(Base: TBase): TBase & Constructor<CraftHandlers> {
  return class extends Base {
    renderCraft(bodyTop: number): void {
      const { w, h } = this;
      const save = this.cb.getSave();
      const defs = craftableDefs();
      const listY = bodyTop + 4;
      const availH = h - listY - 8;
      const full = Object.keys(save.equipmentInv).length >= EQUIPMENT_INV_CAP;

      // Cells start right of the sidebar rail; right pad stays one CELL_GAP.
      const left = sidebarNavW(w, h, this.landscape) + CELL_GAP;
      const avail = w - left - CELL_GAP;
      const cols = Math.max(1, Math.floor((avail + CELL_GAP_X) / (EQUIP_CELL_W_TARGET + CELL_GAP_X)));
      const cellW = (avail - CELL_GAP_X * (cols - 1)) / cols;
      const rows = Math.ceil(defs.length / cols);
      const totalH = CELL_GAP + rows * (CRAFT_CELL_H + CELL_GAP);
      // Clamp the viewport so it always cuts mid-row when there's more below (see inventory.ts).
      const listH = peekViewportH(availH, CRAFT_CELL_H + CELL_GAP, totalH);
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));

      // Masked sub-layer so an overscrolled row never bleeds up past listY and paints over the
      // materials band above it (see the matching fix in inventory.ts's renderInventory).
      const gridLayer = new PIXI.Container();
      this.bodyLayer.addChild(gridLayer);
      const clip = new PIXI.Graphics();
      clip.beginFill(0xffffff).drawRect(0, listY, w, listH).endFill();
      this.bodyLayer.addChild(clip);
      gridLayer.mask = clip;
      const outerLayer = this.bodyLayer;
      this.bodyLayer = gridLayer;
      defs.forEach((def, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = left + col * (cellW + CELL_GAP_X);
        const y = listY + CELL_GAP + row * (CRAFT_CELL_H + CELL_GAP) - this.scrollY;
        if (y + CRAFT_CELL_H < listY || y > listY + listH) return;
        this.renderCraftCell(def.defId, x, y, cellW, save, full);
      });
      this.bodyLayer = outerLayer;

      drawScrollIndicator(this.bodyLayer, { x: left, y: listY, w: avail, h: listH }, this.scrollY, Math.max(0, totalH - listH));
    }

    /**
     * Craft icon-card cell: name +rarity across the top, equipment glyph in a
     * rarity-bordered frame on the left, cost chips + Craft button on the right.
     * Mirrors the inventory grid's `renderInstanceCell` visual language.
     */
    private renderCraftCell(defId: string, x: number, y: number, cellW: number, save: SaveData, full: boolean): void {
      const pad = 8;
      const def = getEquipDef(defId)!;
      const color = RARITY_COLOR[def.rarity];
      const cell = sketchPanel(cellW, CRAFT_CELL_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cellW) });
      cell.x = x; cell.y = y;
      this.bodyLayer.addChild(cell);

      // Top: name (scaled to fit) + rarity tag.
      const name = txt(this.itemName(defId), FS.bodyLg, C.dark, true);
      name.x = x + pad; name.y = y + pad;
      if (name.width > cellW - pad * 2 - 80) name.scale.set(Math.min(1, (cellW - pad * 2 - 80) / name.width));
      this.bodyLayer.addChild(name);
      const rar = txt(t(`equip.rarity.${def.rarity}` as import('../../i18n').TranslationKey), FS.small, color, true);
      rar.anchor.set(1, 0); rar.x = x + cellW - pad; rar.y = y + pad + 2;
      this.bodyLayer.addChild(rar);

      // Left: glyph in a rarity-bordered frame.
      const imgBox = CRAFT_CELL_H - (pad + 32) - pad;
      const imgX = x + pad;
      const imgY = y + pad + 32;
      const frame = sketchPanel(imgBox, imgBox, { fill: 0xf0eee7, border: color, seed: seedFor(x, y, imgBox) });
      frame.x = imgX; frame.y = imgY;
      this.bodyLayer.addChild(frame);
      this.addGlyph(def.slot, def.rarity, imgX + imgBox / 2, imgY + imgBox / 2, imgBox - 8, seedFor(x, imgBox, cellW), 1, defId);

      // Right: cost chips (top) + Craft button (bottom).
      const ax = imgX + imgBox + 12;
      const cost = def.craftCost ?? {};
      const affordable = this.canAffordMaterials(save, cost);
      this.drawCostChips(this.bodyLayer, ax, imgY + 14, cost, null, affordable ? C.mid : C.red, 20);

      const enabled = affordable && !full && !this.bt.busy;
      const btnW = Math.min(104, x + cellW - pad - ax);
      const btnH = 36;
      const btnX = x + cellW - pad - btnW;
      const btnY = y + CRAFT_CELL_H - pad - btnH;
      const btn = sketchPanel(btnW, btnH, { fill: enabled ? C.dark : C.btnOff, border: enabled ? C.accent : C.mid, seed: seedFor(x, y, btnW) });
      btn.x = btnX; btn.y = btnY;
      this.bodyLayer.addChild(btn);
      const bl = txt(t('equip.craftBtn'), FS.body, enabled ? C.light : C.mid);
      bl.anchor.set(0.5, 0.5); bl.x = btnX + btnW / 2; bl.y = btnY + btnH / 2;
      this.bodyLayer.addChild(bl);
      if (enabled) this.hitRects.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, action: () => void this.doCraft(defId) });
    }

    private async doCraft(defId: string): Promise<void> {
      if (this.bt.busy) return;
      this.bt.start(); this.render();
      try {
        const res = await withTimeout(this.cb.craft(defId));
        if (res.ok) this.showToast(t('equip.crafted').replace('{name}', this.itemName(defId)), C.green);
        else this.showToast(t(res.key), C.red);
      } catch (e) {
        this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'equip.err.generic'), C.red);
      } finally {
        this.bt.stop();
        this.render();
      }
    }
  };
}
