// Reforge (E6): material selection modal + confirm + the reforge action itself.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import type { EquipmentInstance, EquipRarity } from '../../game/meta/SaveData';
import { getEquipDef, REFORGE_MATERIAL_RARITY } from '../../game/meta/equipmentDefs';
import { buildEquipIcon } from '../../render/equipmentAtlas';
import { type Constructor, type EquipmentSceneBaseCtor, RARITY_COLOR } from './base';

/** One icon card in the reforge material grid: a defId stack of interchangeable (unenhanced) fuel. */
interface MaterialStack {
  defId: string;
  /** Any one instance id from the stack — reforge only ever consumes a single instance. */
  repId: string;
  count: number;
}

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

      // Fuel is restricted to never-enhanced (level 0) equipment — an enhanced item's affix rolls
      // and sunk materials would otherwise be silently consumed as reforge fuel.
      const equippedSet = this.equippedIds(save);
      const candidates = Object.values(save.equipmentInv ?? {}).filter(
        (m) => m.id !== target.id && getEquipDef(m.defId)?.slot === slot && m.rarity === requiredRarity
          && m.level === 0 && !equippedSet.has(m.id),
      );

      // Unenhanced items sharing a defId are interchangeable as fuel — one icon card per defId
      // (×N badge) instead of a separate row per instance.
      const stacks: MaterialStack[] = [];
      const stackIdx = new Map<string, number>();
      for (const c of candidates) {
        const i = stackIdx.get(c.defId);
        if (i !== undefined) { stacks[i].count++; continue; }
        stackIdx.set(c.defId, stacks.length);
        stacks.push({ defId: c.defId, repId: c.id, count: 1 });
      }

      const { w, h } = this;
      const ml = this.modalLayer;
      tearDownChildren(ml);
      this.modalHits = [];
      this.modalOpen = true;

      // Icon-card grid metrics (mirrors AuctionScene/picker.ts's responsive card grid).
      const cardW = 96, cardH = 120, gap = 10, pad = 14;
      const titleH = 30, closeAreaH = 44;
      const maxModalW = Math.min(420, w - 24);
      const cols = Math.max(1, Math.min(4, Math.floor((maxModalW - pad * 2 + gap) / (cardW + gap))));
      const rows = Math.max(1, Math.ceil((stacks.length || 1) / cols));
      const gridH = stacks.length > 0 ? rows * cardH + (rows - 1) * gap : 60;

      // Natural (unscaled) content size — everything below is laid out in this local frame.
      const mw = Math.min(maxModalW, pad * 2 + cols * cardW + (cols - 1) * gap);
      const mh = Math.min(titleH + pad + gridH + closeAreaH, h - 80);
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

      const titleLbl = this.stxt(t('equip.reforgeSelectTitle').replace('{rarity}', t(`equip.rarity.${requiredRarity}` as import('../../i18n').TranslationKey)), FS.tiny, C.dark, true);
      titleLbl.anchor.set(0.5, 0); titleLbl.x = mx + mw / 2; titleLbl.y = my + 10;
      panelRoot.addChild(titleLbl);

      const gridTop = my + titleH;
      stacks.forEach((s, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = mx + pad + col * (cardW + gap);
        const cy = gridTop + row * (cardH + gap);
        this.renderReforgeMaterialCard(target, s, requiredRarity, cx, cy, cardW, cardH);
      });
      if (stacks.length === 0) {
        const empty = this.stxt(t('equip.reforgeNoMat'), FS.tiny, C.mid);
        empty.anchor.set(0.5, 0.5); empty.x = mx + mw / 2; empty.y = gridTop + gridH / 2;
        panelRoot.addChild(empty);
      }

      const closeBtn = sketchPanel(60, 26, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 22, 60) });
      closeBtn.x = mx + (mw - 60) / 2; closeBtn.y = my + mh - 34;
      panelRoot.addChild(closeBtn);
      const closeLbl = this.stxt(t('equip.cancel'), FS.tiny, C.dark);
      closeLbl.anchor.set(0.5, 0.5); closeLbl.x = closeBtn.x + 30; closeLbl.y = closeBtn.y + 13;
      panelRoot.addChild(closeLbl);
      this.modalHits.push({ rect: this.toModalScreen({ x: closeBtn.x, y: closeBtn.y, w: 60, h: 26 }), action: () => { this.closeModal(); this.render(); } });
      this.modalHits.push({ rect: this.toModalScreen({ x: mx, y: my, w: mw, h: mh }), action: () => {} });
      this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { this.closeModal(); this.render(); } });
    }

    /**
     * One icon card in the material grid: glyph on top, name + stack count below, rarity-colored
     * border (mirrors the inventory grid's icon-card language, InventoryMixin.renderInstanceCell).
     * Drawn straight onto modalPanelRoot (not bodyLayer) since it lives inside the scaled modal frame.
     */
    private renderReforgeMaterialCard(
      target: EquipmentInstance, stack: MaterialStack, rarity: EquipRarity,
      x: number, y: number, cardW: number, cardH: number,
    ): void {
      const color = RARITY_COLOR[rarity];
      const cardBg = sketchPanel(cardW, cardH, { fill: 0xf8f4e8, border: color, seed: seedFor(x, y, cardW) });
      cardBg.x = x; cardBg.y = y;
      this.modalPanelRoot.addChild(cardBg);

      const padIn = 8;
      const imgBox = cardW - padIn * 2;
      const slot = getEquipDef(stack.defId)?.slot ?? 'weapon';
      const icon = buildEquipIcon(stack.defId, slot, rarity, imgBox, seedFor(x, y, cardW));
      icon.x = x + cardW / 2; icon.y = y + padIn + imgBox / 2;
      this.modalPanelRoot.addChild(icon);

      const nameLbl = this.stxt(this.itemName(stack.defId), FS.micro, C.dark, true);
      nameLbl.anchor.set(0.5, 0); nameLbl.x = x + cardW / 2; nameLbl.y = y + padIn + imgBox + 6;
      if (nameLbl.width > cardW - 6) nameLbl.scale.set(Math.max(0.4, (cardW - 6) / nameLbl.width));
      this.modalPanelRoot.addChild(nameLbl);

      if (stack.count > 1) {
        const badge = this.stxt(`×${stack.count}`, FS.micro, C.mid, true);
        badge.anchor.set(1, 0); badge.x = x + cardW - 4; badge.y = y + 3;
        this.modalPanelRoot.addChild(badge);
      }

      const matId = stack.repId;
      this.modalHits.push({ rect: this.toModalScreen({ x, y, w: cardW, h: cardH }), action: () => this.confirmReforge(target, matId) });
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
