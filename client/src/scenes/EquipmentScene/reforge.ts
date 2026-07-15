// Reforge (E6): material selection modal + confirm + the reforge action itself.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import type { EquipmentInstance } from '../../game/meta/SaveData';
import { getEquipDef, REFORGE_MATERIAL_RARITY } from '../../game/meta/equipmentDefs';
import { type Constructor, type EquipmentSceneBaseCtor, RARITY_COLOR } from './base';

export interface ReforgeHandlers {
  openReforgeSelect(target: EquipmentInstance): void;
}

export function ReforgeMixin<TBase extends EquipmentSceneBaseCtor>(Base: TBase): TBase & Constructor<ReforgeHandlers> {
  return class extends Base {
    /** Open the reforge material selection modal (the target item is already set in detailId). */
    openReforgeSelect(target: EquipmentInstance): void {
      const save = this.cb.getSave();
      const slot = getEquipDef(target.defId)?.slot;
      const requiredRarity = REFORGE_MATERIAL_RARITY[target.rarity];
      if (!slot || !requiredRarity) return;

      const equippedSet = this.equippedIds(save);
      const candidates = Object.values(save.equipmentInv ?? {}).filter(
        (m) => m.id !== target.id && getEquipDef(m.defId)?.slot === slot && m.rarity === requiredRarity && !equippedSet.has(m.id),
      );

      const { w, h } = this;
      const ml = this.modalLayer;
      ml.removeChildren();
      this.modalHits = [];
      this.modalOpen = true;

      // Natural (unscaled) content size — everything below is laid out in this local frame.
      const mw = Math.min(320, w - 24);
      const rowH = 48;
      const mh = Math.min(60 + candidates.length * rowH + 40, h - 80);
      const mx = 0;
      const my = 0;

      // Scale the whole panel to fill 80% of the constrained screen axis — landscape fills height,
      // portrait fills width — while keeping its natural aspect ratio (popup-scale fix, 2026-07-14).
      const scale = this.landscape ? (h * 0.8) / mh : (w * 0.8) / mw;
      const screenW = mw * scale;
      const screenH = mh * scale;
      const screenX = (w - screenW) / 2;
      const screenY = Math.max(this.headerH + 4, (h - screenH) / 2);
      this.modalScale = scale;
      this.modalOriginX = screenX;
      this.modalOriginY = screenY;

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);
      const panelRoot = new PIXI.Container();
      panelRoot.position.set(screenX, screenY);
      panelRoot.scale.set(scale);
      ml.addChild(panelRoot);
      this.modalPanelRoot = panelRoot;
      const panel = sketchPanel(mw, mh, { fill: C.paper, border: 0x3355aa, width: 2, seed: seedFor(0, 20, mw) });
      panel.x = mx; panel.y = my;
      panelRoot.addChild(panel);

      const titleLbl = txt(t('equip.reforgeSelectTitle').replace('{rarity}', t(`equip.rarity.${requiredRarity}` as import('../../i18n').TranslationKey)), 13, C.dark, true);
      titleLbl.anchor.set(0.5, 0); titleLbl.x = mx + mw / 2; titleLbl.y = my + 10;
      panelRoot.addChild(titleLbl);

      let cy = my + 36;
      for (const mat of candidates) {
        const color = RARITY_COLOR[mat.rarity];
        const rowBg = sketchPanel(mw - 16, rowH - 4, { fill: 0xf8f4e8, border: color, seed: seedFor(cy, 21, mw) });
        rowBg.x = mx + 8; rowBg.y = cy;
        panelRoot.addChild(rowBg);
        const nameLbl = txt(this.itemLabel(mat.defId, mat.level), 12, C.dark, true);
        nameLbl.x = mx + 18; nameLbl.y = cy + 6;
        panelRoot.addChild(nameLbl);
        const rarLbl = txt(t(`equip.rarity.${mat.rarity}` as import('../../i18n').TranslationKey), 10, color);
        rarLbl.x = mx + 18; rarLbl.y = cy + 24;
        panelRoot.addChild(rarLbl);
        const matId = mat.id;
        this.modalHits.push({ rect: this.toModalScreen({ x: mx + 8, y: cy, w: mw - 16, h: rowH - 4 }), action: () => this.confirmReforge(target, matId) });
        cy += rowH;
      }
      if (candidates.length === 0) {
        const empty = txt(t('equip.reforgeNoMat'), 12, C.mid);
        empty.anchor.set(0.5, 0.5); empty.x = mx + mw / 2; empty.y = my + mh / 2;
        panelRoot.addChild(empty);
      }

      const closeBtn = sketchPanel(60, 26, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 22, 60) });
      closeBtn.x = mx + (mw - 60) / 2; closeBtn.y = my + mh - 34;
      panelRoot.addChild(closeBtn);
      const closeLbl = txt(t('equip.cancel'), 12, C.dark);
      closeLbl.anchor.set(0.5, 0.5); closeLbl.x = closeBtn.x + 30; closeLbl.y = closeBtn.y + 13;
      panelRoot.addChild(closeLbl);
      this.modalHits.push({ rect: this.toModalScreen({ x: closeBtn.x, y: closeBtn.y, w: 60, h: 26 }), action: () => { this.closeModal(); this.render(); } });
      this.modalHits.push({ rect: this.toModalScreen({ x: mx, y: my, w: mw, h: mh }), action: () => {} });
      this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { this.closeModal(); this.render(); } });
    }

    private confirmReforge(target: EquipmentInstance, materialId: string): void {
      const save = this.cb.getSave();
      const mat = save.equipmentInv?.[materialId];
      if (!mat) return;
      const msg = t('equip.confirmReforge')
        .replace('{target}', this.itemName(target.defId))
        .replace('{material}', this.itemLabel(mat.defId, mat.level));
      this.showConfirm(msg, () => void this.doReforge(target.id, materialId));
    }

    private async doReforge(targetId: string, materialId: string): Promise<void> {
      if (this.bt.busy) return;
      this.bt.start();
      try {
        const res = await withTimeout(this.cb.reforge(targetId, materialId));
        if (res.ok) this.showToast(t('equip.reforged'), C.green);
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
