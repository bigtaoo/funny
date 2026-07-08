// Detail modal: the instance panel (affix list, enhance / equip-unequip / reforge / salvage
// buttons) plus the enhance and salvage actions. Equip/unequip itself (doEquip) lives here since
// it's the target of both the detail modal's buttons and the assign mixin's card picker.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import type { SaveData, EquipSlot, EquipmentInstance } from '../../game/meta/SaveData';
import {
  getEquipDef, enhanceSuccessRate, enhanceCost, salvageRefund, affixKind,
  EQUIP_MAX_LEVEL, SALVAGE_MAX_LEVEL, REFORGE_MATERIAL_RARITY, PROTECT_ENHANCE_ITEM_ID,
} from '../../game/meta/equipmentDefs';
import { buildIcon, type IconKind } from '../../render/icons';
import { type Constructor, type EquipmentSceneBaseCtor, RARITY_COLOR } from './base';

/** Affix id (strip m_/s_/k_ prefix) → stat icon kind; returns null for unknown affixes. */
function affixIconKind(affixId: string): IconKind | null {
  const stat = affixId.replace(/^[a-z]_/, '');
  if (stat === 'atk' || stat === 'hp' || stat === 'armor' || stat === 'spd' || stat === 'atkspd') return stat;
  return null;
}

export interface DetailHandlers {
  openDetail(instanceId: string): void;
  doEquip(slot: EquipSlot, instanceId: string | null, cardId: string): Promise<void>;
}

export function DetailMixin<TBase extends EquipmentSceneBaseCtor>(Base: TBase): TBase & Constructor<DetailHandlers> {
  return class extends Base {
    openDetail(instanceId: string): void {
      const save = this.cb.getSave();
      const inst = save.equipmentInv[instanceId];
      if (!inst) { this.detailId = null; this.closeModal(); return; }
      this.detailId = instanceId;

      const { w, h } = this;
      const ml = this.modalLayer;
      ml.removeChildren();
      this.modalHits = [];
      this.modalOpen = true;

      const color = RARITY_COLOR[inst.rarity];
      const equipped = this.equippedIds(save).has(inst.id);
      const slot = getEquipDef(inst.defId)?.slot;
      const maxed = inst.level >= EQUIP_MAX_LEVEL;
      const salvageable = inst.level <= SALVAGE_MAX_LEVEL && !equipped && !inst.locked;

      const mw = Math.min(330, w - 24);
      const affixCount = inst.affixes.length;
      const protectCount = save.inventory?.items?.[PROTECT_ENHANCE_ITEM_ID] ?? 0;
      // Extra 22px for the protect-item row when not max level
      const mh = 64 + affixCount * 20 + (maxed ? 24 : 64 + 22) + 44 + 24;
      const mx = (w - mw) / 2;
      const my = Math.max(this.headerH + 4, (h - mh) / 2);

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);

      const panel = sketchPanel(mw, mh, { fill: C.paper, border: color, width: 2.6, seed: seedFor(0, 9, mw) });
      panel.x = mx; panel.y = my;
      ml.addChild(panel);

      let cy = my + 12;
      const title = txt(`${this.itemName(inst.defId)} +${inst.level}`, 14, C.dark, true);
      title.x = mx + 12; title.y = cy;
      ml.addChild(title);
      const rar = txt(t(`equip.rarity.${inst.rarity}` as TranslationKey), 11, color, true);
      rar.anchor.set(1, 0); rar.x = mx + mw - 12; rar.y = cy + 1;
      ml.addChild(rar);
      cy += 26;

      // Affix lines (stat icon + text; main affixes highlighted in ink-blue).
      for (const af of inst.affixes) {
        const col = affixKind(af.id) === 'main' ? C.accent : C.dark;
        const kind = affixIconKind(af.id);
        let tx = mx + 16;
        if (kind) {
          const ic = buildIcon(kind, 15, col);
          ic.x = mx + 16; ic.y = cy - 1;
          ml.addChild(ic);
          tx = mx + 16 + 19;
        }
        const line = txt(this.affixDesc(af.id, af.value, inst.level), 11, col);
        line.x = tx; line.y = cy;
        ml.addChild(line);
        cy += 20;
      }
      cy += 6;

      // Enhance section.
      if (maxed) {
        const lbl = txt(t('equip.maxLevel'), 12, C.gold, true);
        lbl.x = mx + 12; lbl.y = cy;
        ml.addChild(lbl);
        cy += 24;
      } else {
        const rate = Math.round(enhanceSuccessRate(inst.level) * 100);
        const cost = enhanceCost(inst.level);
        const rateLbl = txt(t('equip.enhanceRate').replace('{rate}', String(rate)), 11, C.dark);
        rateLbl.x = mx + 12; rateLbl.y = cy;
        ml.addChild(rateLbl);
        cy += 18;
        const affordable = this.canAffordEnhance(save, cost);
        const costColor = affordable ? C.mid : C.red;
        const costLbl = txt(`${t('equip.cost')}:`, 10, costColor);
        costLbl.anchor.set(0, 0.5); costLbl.x = mx + 12; costLbl.y = cy + 7;
        ml.addChild(costLbl);
        this.drawCostChips(ml, costLbl.x + costLbl.width + 8, cy + 7, cost.materials, cost.coins, costColor, 13);
        cy += 18;
        // Protect-item row (E7): show quantity held + toggle switch.
        const canToggle = protectCount > 0;
        const protecting = this.useProtectEnhance && canToggle;
        const protectColor = canToggle ? (protecting ? C.accent : C.dark) : C.mid;
        // Toggle checkbox: a small ink box, ticked with a hand-drawn check when on (replaces [✓]/[ ]).
        const boxSz = 14;
        const box = new PIXI.Graphics();
        box.lineStyle(1.5, protectColor, 1);
        box.drawRect(mx + 12, cy, boxSz, boxSz);
        ml.addChild(box);
        if (protecting) {
          const ck = buildIcon('check', boxSz, C.accent);
          ck.x = mx + 12; ck.y = cy;
          ml.addChild(ck);
        }
        const protectLbl = txt(`${t('equip.protect')} ×${protectCount}`, 10, protectColor);
        protectLbl.x = mx + 12 + boxSz + 4; protectLbl.y = cy + 2;
        ml.addChild(protectLbl);
        if (canToggle && !this.bt.busy) {
          this.modalHits.push({
            rect: { x: mx + 10, y: cy - 2, w: mw - 20, h: 18 },
            action: () => { this.useProtectEnhance = !this.useProtectEnhance; this.render(); },
          });
        }
        cy += 22;
      }

      // Reforge availability
      const requiredMatRarity = REFORGE_MATERIAL_RARITY[inst.rarity];
      const hasMaterials = requiredMatRarity
        ? Object.values(save.equipmentInv ?? {}).some(
            (m) => m.id !== inst.id && getEquipDef(m.defId)?.slot === slot && m.rarity === requiredMatRarity && !this.equippedIds(save).has(m.id),
          )
        : false;
      const reforgeOn = !!requiredMatRarity && hasMaterials && !equipped && !inst.locked && !this.bt.busy;

      // Action buttons row.
      const btnY = my + mh - 40;
      const btnH = 30;
      const buttons: { label: string; fill: number; stroke: number; fn: () => void; on: boolean }[] = [];
      if (!maxed) {
        const cost = enhanceCost(inst.level);
        const on = this.canAffordEnhance(save, cost) && !this.bt.busy;
        buttons.push({ label: t('equip.enhance'), fill: on ? C.dark : C.btnOff, stroke: on ? C.accent : C.mid, on, fn: () => void this.doEnhance(inst.id) });
      }
      if (slot) {
        if (equipped) {
          // Unequip: in bag mode the item may be on any card → look up its owner; otherwise the active card.
          buttons.push({ label: t('equip.unequip'), fill: 0xf0e0e0, stroke: C.red, on: !this.bt.busy, fn: () => {
            const cardId = this.bag ? this.ownerCardId(save, inst.id) : this.cb.activeCardInstanceId;
            if (cardId) void this.doEquip(slot, null, cardId);
          } });
        } else {
          // Equip: in bag mode we don't know the target card yet → open the card picker; otherwise the active card.
          buttons.push({ label: t('equip.equip'), fill: C.dark, stroke: C.green, on: !this.bt.busy, fn: () => {
            if (this.bag) this.beginAssign(inst.id, slot);
            else void this.doEquip(slot, inst.id, this.cb.activeCardInstanceId);
          } });
        }
      }
      if (requiredMatRarity) {
        buttons.push({ label: t('equip.reforge'), fill: reforgeOn ? 0x3355aa : C.btnOff, stroke: reforgeOn ? 0x6688dd : C.mid, on: reforgeOn, fn: () => this.openReforgeSelect(inst) });
      }
      if (salvageable) {
        buttons.push({ label: t('equip.salvage'), fill: 0xeeeeee, stroke: C.mid, on: !this.bt.busy, fn: () => this.confirmSalvage(inst) });
      }
      const n = buttons.length;
      const gap = 8;
      const bw = (mw - 24 - gap * (n - 1)) / n;
      buttons.forEach((b, i) => {
        const x = mx + 12 + i * (bw + gap);
        const g = sketchPanel(bw, btnH, { fill: b.on ? b.fill : C.btnOff, border: b.on ? b.stroke : C.mid, seed: seedFor(i, 11, bw) });
        g.x = x; g.y = btnY;
        ml.addChild(g);
        const lbl = txt(b.label, 12, b.on ? (b.fill === 0xeeeeee || b.fill === 0xf0e0e0 ? C.dark : C.light) : C.mid, true);
        lbl.anchor.set(0.5, 0.5); lbl.x = x + bw / 2; lbl.y = btnY + btnH / 2;
        ml.addChild(lbl);
        if (b.on) this.modalHits.push({ rect: { x, y: btnY, w: bw, h: btnH }, action: b.fn });
      });

      // Hit priority is first-match: buttons (above) win, then panel-area is inert,
      // then a tap anywhere outside the panel closes the detail (added last = lowest).
      this.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
      this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => this.closeDetail() });
    }

    private closeDetail(): void {
      this.detailId = null;
      this.closeModal();
    }

    private async doEnhance(instanceId: string): Promise<void> {
      if (this.bt.busy) return;
      this.bt.start(); this.render();
      const save = this.cb.getSave();
      const protectCount = save.inventory?.items?.[PROTECT_ENHANCE_ITEM_ID] ?? 0;
      const useProtect = this.useProtectEnhance && protectCount > 0;
      try {
        const res = await withTimeout(this.cb.enhance(instanceId, useProtect || undefined));
        if (res.ok) {
          this.showToast(res.success
            ? t('equip.enhanceOk').replace('{lv}', String(res.level))
            : t('equip.enhanceFail'), res.success ? C.green : C.red);
        } else {
          this.showToast(t(res.key), C.red);
        }
      } catch (e) {
        this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'equip.err.generic'), C.red);
      } finally {
        this.bt.stop();
        this.render();
      }
    }

    private confirmSalvage(inst: EquipmentInstance): void {
      const refund = salvageRefund(inst.defId);
      const msg = t('equip.confirmSalvage')
        .replace('{name}', this.itemName(inst.defId))
        .replace('{refund}', this.materialsStr(refund) || t('equip.nothing'));
      this.showConfirm(msg, () => void this.doSalvage(inst.id));
    }

    private async doSalvage(instanceId: string): Promise<void> {
      if (this.bt.busy) return;
      this.bt.start();
      try {
        const res = await withTimeout(this.cb.salvage([instanceId]));
        if (res.ok) { this.showToast(t('equip.salvaged'), C.green); this.detailId = null; }
        else this.showToast(t(res.key), C.red);
      } catch (e) {
        this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'equip.err.generic'), C.red);
      } finally {
        this.bt.stop();
        this.render();
      }
    }

    async doEquip(slot: EquipSlot, instanceId: string | null, cardId: string): Promise<void> {
      if (this.bt.busy) return;
      this.bt.start();
      try {
        const res = await withTimeout(this.cb.equip(slot, instanceId, cardId));
        if (res.ok) this.showToast(instanceId ? t('equip.equipped') : t('equip.unequipped'), C.green);
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
