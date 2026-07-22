// Detail modal + item actions. The modal itself is info-only (affix list, enhance rate/cost, the
// protect toggle); the action set (enhance / equip-unequip / reforge / salvage / salvage-all) is
// produced by instanceActions() and rendered as buttons on the grid cell (InventoryMixin), which
// call the doEnhance / doEquip / confirmSalvage / openReforgeSelect handlers that also live here.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import type { SaveData, EquipSlot, EquipmentInstance } from '../../game/meta/SaveData';
import {
  getEquipDef, enhanceSuccessRate, enhanceCost, salvageRefund, affixKind,
  EQUIP_MAX_LEVEL, REFORGE_MATERIAL_RARITY, PROTECT_ENHANCE_ITEM_ID, isSalvageable,
} from '../../game/meta/equipmentDefs';
import { buildIcon, type IconKind } from '../../render/icons';
import { type Constructor, type EquipmentSceneBaseCtor, type CellAction, RARITY_COLOR } from './base';

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
      tearDownChildren(ml);
      this.modalHits = [];
      this.modalOpen = true;

      const color = RARITY_COLOR[inst.rarity];
      const maxed = inst.level >= EQUIP_MAX_LEVEL;

      // Natural (unscaled) content size — everything below is laid out in this local frame.
      // This modal is now info-only: the action buttons moved onto the grid cell (see
      // InventoryMixin.renderInstanceCell), so it just shows affixes + enhance rate/cost + the
      // protect toggle and no longer reserves a button band at the bottom.
      const mw = Math.min(330, w - 24);
      const affixCount = inst.affixes.length;
      const protectCount = save.inventory?.items?.[PROTECT_ENHANCE_ITEM_ID] ?? 0;
      // 44 = top(12) + title(26) + affix-gap(6); enhance section is 58 (rate+cost+protect) or 24 (maxed); +12 bottom pad.
      const mh = 44 + affixCount * 20 + (maxed ? 24 : 58) + 12;
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

      const panel = sketchPanel(mw, mh, { fill: C.paper, border: color, width: 2.6, seed: seedFor(0, 9, mw) });
      panel.x = mx; panel.y = my;
      panelRoot.addChild(panel);

      let cy = my + 12;
      const title = this.stxt(this.itemName(inst.defId), FS.tiny, C.dark, true);
      title.x = mx + 12; title.y = cy;
      panelRoot.addChild(title);
      const rar = this.stxt(t(`equip.rarity.${inst.rarity}` as TranslationKey), FS.micro, color, true);
      rar.anchor.set(1, 0); rar.x = mx + mw - 12; rar.y = cy + 1;
      panelRoot.addChild(rar);
      // Enhance level as gold stars, squeezed into the gap between the name and the rarity tag.
      if (inst.level > 0) {
        const starsMaxW = (rar.x - rar.width) - (title.x + title.width) - 16;
        if (starsMaxW > 20) {
          const stars = this.buildLevelStars(inst.level, starsMaxW, 12, 2);
          stars.x = title.x + title.width + 8; stars.y = cy + 4;
          panelRoot.addChild(stars);
        }
      }
      cy += 26;

      // Affix lines (stat icon + text; main affixes highlighted in ink-blue).
      for (const af of inst.affixes) {
        const col = affixKind(af.id) === 'main' ? C.accent : C.dark;
        const kind = affixIconKind(af.id);
        let tx = mx + 16;
        if (kind) {
          const ic = buildIcon(kind, 15, col);
          ic.x = mx + 16; ic.y = cy - 1;
          panelRoot.addChild(ic);
          tx = mx + 16 + 19;
        }
        const line = this.stxt(this.affixDesc(af.id, af.value, inst.level), FS.micro, col);
        line.x = tx; line.y = cy;
        panelRoot.addChild(line);
        cy += 20;
      }
      cy += 6;

      // Enhance section.
      if (maxed) {
        const lbl = this.stxt(t('equip.maxLevel'), FS.tiny, C.gold, true);
        lbl.x = mx + 12; lbl.y = cy;
        panelRoot.addChild(lbl);
        cy += 24;
      } else {
        const rate = Math.round(enhanceSuccessRate(inst.level) * 100);
        const cost = enhanceCost(inst.level);
        const rateLbl = this.stxt(t('equip.enhanceRate').replace('{rate}', String(rate)), FS.micro, C.dark);
        rateLbl.x = mx + 12; rateLbl.y = cy;
        panelRoot.addChild(rateLbl);
        cy += 18;
        const affordable = this.canAffordEnhance(save, cost);
        const costColor = affordable ? C.mid : C.red;
        const costLbl = this.stxt(`${t('equip.cost')}:`, FS.micro, costColor);
        costLbl.anchor.set(0, 0.5); costLbl.x = mx + 12; costLbl.y = cy + 7;
        panelRoot.addChild(costLbl);
        this.drawCostChips(panelRoot, costLbl.x + costLbl.width + 8, cy + 7, cost.materials, cost.coins, costColor, 13);
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
        panelRoot.addChild(box);
        if (protecting) {
          const ck = buildIcon('check', boxSz, C.accent);
          ck.x = mx + 12; ck.y = cy;
          panelRoot.addChild(ck);
        }
        const protectLbl = this.stxt(t('equip.protect').replace('{n}', String(protectCount)), FS.micro, protectColor);
        protectLbl.x = mx + 12 + boxSz + 4; protectLbl.y = cy + 2;
        panelRoot.addChild(protectLbl);
        if (canToggle && !this.bt.busy) {
          this.modalHits.push({
            rect: this.toModalScreen({ x: mx + 10, y: cy - 2, w: mw - 20, h: 18 }),
            action: () => { this.useProtectEnhance = !this.useProtectEnhance; this.render(); },
          });
        }
        cy += 22;
      }

      // Hit priority is first-match: the protect toggle (above) wins, then the panel area is inert,
      // then a tap anywhere outside the panel closes the detail (added last = lowest). All actions
      // (enhance / equip / reforge / salvage) now live on the grid cell, not here.
      this.modalHits.push({ rect: this.toModalScreen({ x: mx, y: my, w: mw, h: mh }), action: () => {} });
      this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => this.closeDetail() });
    }

    /**
     * Available on-card actions for `inst`, in display order (Enhance / Equip|Unequip / Reforge /
     * Salvage / Salvage All). Only *available* actions are returned — unavailable ones (unaffordable
     * enhance, reforge without a matching material, salvage on an equipped/locked piece, …) are
     * omitted so the grid cell hides them rather than greying them out. Each `fn` fires directly.
     */
    instanceActions(save: SaveData, inst: EquipmentInstance): CellAction[] {
      const equipped = this.equippedIds(save).has(inst.id);
      const slot = getEquipDef(inst.defId)?.slot;
      const maxed = inst.level >= EQUIP_MAX_LEVEL;
      const busy = this.bt.busy;
      const salvageable = isSalvageable(inst.rarity, inst.level) && !equipped && !inst.locked;
      const stackIds = salvageable ? this.stackSiblingIds(save, inst) : [inst.id];
      const actions: CellAction[] = [];

      if (!maxed && this.canAffordEnhance(save, enhanceCost(inst.level)) && !busy) {
        actions.push({ key: 'enhance', label: t('equip.enhance'), icon: 'hammer', fill: C.dark, stroke: C.accent, fn: () => void this.doEnhance(inst.id) });
      }
      if (slot && !busy) {
        if (equipped) {
          // Unequip: in bag mode the item may be on any card → look up its owner; otherwise the active card.
          actions.push({ key: 'unequip', label: t('equip.unequip'), icon: 'close', fill: 0xf0e0e0, stroke: C.red, fn: () => {
            const cardId = this.bag ? this.ownerCardId(save, inst.id) : this.cb.activeCardInstanceId;
            if (cardId) void this.doEquip(slot, null, cardId);
          } });
        } else {
          // Equip: in bag mode we don't know the target card yet → open the card picker; otherwise the active card.
          actions.push({ key: 'equip', label: t('equip.equip'), icon: 'check', fill: C.dark, stroke: C.green, fn: () => {
            if (this.bag) this.beginAssign(inst.id, slot);
            else void this.doEquip(slot, inst.id, this.cb.activeCardInstanceId);
          } });
        }
      }
      const requiredMatRarity = REFORGE_MATERIAL_RARITY[inst.rarity];
      const hasMaterials = requiredMatRarity
        ? Object.values(save.equipmentInv ?? {}).some(
            (m) => m.id !== inst.id && getEquipDef(m.defId)?.slot === slot && m.rarity === requiredMatRarity
              && m.level === 0 && !this.equippedIds(save).has(m.id),
          )
        : false;
      if (!!requiredMatRarity && hasMaterials && !equipped && !inst.locked && !busy) {
        actions.push({ key: 'reforge', label: t('equip.reforge'), icon: 'replay', fill: 0x3355aa, stroke: 0x6688dd, fn: () => this.openReforgeSelect(inst) });
      }
      if (salvageable && !busy) {
        actions.push({ key: 'salvage', label: t('equip.salvage'), icon: 'scrap', fill: 0xeeeeee, stroke: C.mid, fn: () => this.confirmSalvage(inst, stackIds.length) });
        if (stackIds.length > 1) {
          actions.push({ key: 'salvageAll', label: t('equip.salvageAll'), icon: 'scrap', fill: 0xeeeeee, stroke: C.mid, fn: () => this.confirmSalvageAll(inst, stackIds) });
        }
      }
      return actions;
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
          // On failure, a protect stone was consumed to keep the materials (server skipMaterials, §6.2);
          // show the "materials kept" wording so it doesn't contradict the protect toggle the player ticked.
          const failKey = useProtect ? 'equip.enhanceFailKept' : 'equip.enhanceFail';
          this.showToast(res.success
            ? t('equip.enhanceOk').replace('{lv}', String(res.level))
            : t(failKey), res.success ? C.green : C.red);
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

    /** stackCount is the total ×N the item is currently stacked as (1 when not part of a stack) — only used to pick the confirm wording that makes clear this salvages one out of several. */
    private confirmSalvage(inst: EquipmentInstance, stackCount = 1): void {
      const refund = salvageRefund(inst.defId);
      const msg = (stackCount > 1 ? t('equip.confirmSalvageOne') : t('equip.confirmSalvage'))
        .replace('{name}', this.itemName(inst.defId))
        .replace('{count}', String(stackCount))
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

    /** Salvage every instance in the same ×N stack as `inst` in one batch call (see stackSiblingIds). */
    private confirmSalvageAll(inst: EquipmentInstance, ids: string[]): void {
      const perItem = salvageRefund(inst.defId);
      const total: Record<string, number> = {};
      for (const [mat, qty] of Object.entries(perItem)) total[mat] = qty * ids.length;
      const msg = t('equip.confirmSalvageAll')
        .replace('{name}', this.itemName(inst.defId))
        .replace('{count}', String(ids.length))
        .replace('{refund}', this.materialsStr(total) || t('equip.nothing'));
      this.showConfirm(msg, () => void this.doSalvageAll(ids));
    }

    private async doSalvageAll(instanceIds: string[]): Promise<void> {
      if (this.bt.busy) return;
      this.bt.start();
      try {
        const res = await withTimeout(this.cb.salvage(instanceIds));
        if (res.ok) { this.showToast(t('equip.salvagedAll').replace('{count}', String(instanceIds.length)), C.green); this.detailId = null; }
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
