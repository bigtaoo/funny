// Reforge (E6): material selection modal + confirm + the reforge action itself. Depends only on
// EquipmentSceneCore — no cross-domain calls in either direction (detail.ts calls into this file's
// openReforgeSelect, but nothing here calls back into detail.ts).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import type { EquipmentInstance, EquipRarity } from '../../game/meta/SaveData';
import { getEquipDef, REFORGE_MATERIAL_RARITY, reforgeCoinCost } from '../../game/meta/equipmentDefs';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { RARITY_COLOR } from './layout';
import { itemName, itemLabel, equippedIds } from './helpers';
import type { EquipmentSceneCore } from './core';

/** One icon card in the reforge material grid: a defId stack of interchangeable (unenhanced) fuel. */
interface MaterialStack {
  defId: string;
  /** Any one instance id from the stack — reforge only ever consumes a single instance. */
  repId: string;
  count: number;
}

export class ReforgePanel {
  constructor(private readonly core: EquipmentSceneCore) {}

  /** Open the reforge material selection modal (the target item is already set in detailId). */
  openReforgeSelect(target: EquipmentInstance): void {
    const core = this.core;
    const save = core.cb.getSave();
    const slot = getEquipDef(target.defId)?.slot;
    const requiredRarity = REFORGE_MATERIAL_RARITY[target.rarity];
    if (!slot || !requiredRarity) return;

    // Fuel is restricted to never-enhanced (level 0) equipment — an enhanced item's affix rolls
    // and sunk materials would otherwise be silently consumed as reforge fuel.
    // Locked items are excluded (2026-08-03 fix) — a player locks an item specifically to protect
    // it from being destroyed, and reforge fuel is consumed/destroyed just like a salvage input.
    const equippedSet = equippedIds(save);
    const candidates = Object.values(save.equipmentInv ?? {}).filter(
      (m) => m.id !== target.id && getEquipDef(m.defId)?.slot === slot && m.rarity === requiredRarity
        && m.level === 0 && !m.locked && !equippedSet.has(m.id),
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

    const { w, h } = core;
    const ml = core.modalLayer;
    tearDownChildren(ml);
    core.modalHits = [];
    core.modalOpen = true;

    // Icon-card grid metrics (mirrors AuctionScene/itemPickerRender.ts's responsive card grid).
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

    // Scale the whole panel to ~80% of the *fitted* axis (min(w,h) — 1080 in both orientations by
    // design-width convention), clamped to 92% of each real screen axis (CityScene.modalScaleFor
    // fix, 2026-07-30): the old `this.landscape ? (h*0.8)/mh : (w*0.8)/mw` used the raw landscape
    // height directly, which overscaled short popups whenever landscape h was much smaller than mh
    // would suggest.
    const modalRef = Math.min(w, h);
    const scale = Math.min((modalRef * 0.8) / mw, (w * 0.92) / mw, (h * 0.92) / mh);
    const screenW = mw * scale;
    const screenH = mh * scale;
    const screenX = (w - screenW) / 2;
    const screenY = Math.max(core.headerH + 4, (h - screenH) / 2);
    core.modalScale = scale;
    core.modalOriginX = screenX;
    core.modalOriginY = screenY;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    const panelRoot = new PIXI.Container();
    panelRoot.position.set(screenX, screenY);
    panelRoot.scale.set(scale);
    ml.addChild(panelRoot);
    core.modalPanelRoot = panelRoot;
    const panel = sketchPanel(mw, mh, { fill: C.paper, border: 0x3355aa, width: 2, seed: seedFor(0, 20, mw) });
    panel.x = mx; panel.y = my;
    panelRoot.addChild(panel);

    const titleLbl = core.stxt(t('equip.reforgeSelectTitle').replace('{rarity}', t(`equip.rarity.${requiredRarity}` as import('../../i18n').TranslationKey)), FS.tiny, C.dark, true);
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
      const empty = core.stxt(t('equip.reforgeNoMat'), FS.tiny, C.mid);
      empty.anchor.set(0.5, 0.5); empty.x = mx + mw / 2; empty.y = gridTop + gridH / 2;
      panelRoot.addChild(empty);
    }

    const closeBtn = sketchPanel(60, 26, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 22, 60) });
    closeBtn.x = mx + (mw - 60) / 2; closeBtn.y = my + mh - 34;
    panelRoot.addChild(closeBtn);
    const closeLbl = core.stxt(t('equip.cancel'), FS.tiny, C.dark);
    closeLbl.anchor.set(0.5, 0.5); closeLbl.x = closeBtn.x + 30; closeLbl.y = closeBtn.y + 13;
    panelRoot.addChild(closeLbl);
    core.modalHits.push({ rect: core.toModalScreen({ x: closeBtn.x, y: closeBtn.y, w: 60, h: 26 }), sound: 'sfx.ui.back', fn: () => { core.closeModal(); core.render(); } });
    core.modalHits.push({ rect: core.toModalScreen({ x: mx, y: my, w: mw, h: mh }), fn: () => {} });
    core.modalHits.push({ rect: { x: 0, y: 0, w, h }, sound: 'sfx.ui.back', fn: () => { core.closeModal(); core.render(); } });
  }

  /**
   * One icon card in the material grid: glyph on top, name + stack count below, rarity-colored
   * border (mirrors the inventory grid's icon-card language, InventoryPanel.renderInstanceCell).
   * Drawn straight onto modalPanelRoot (not bodyLayer) since it lives inside the scaled modal frame.
   */
  private renderReforgeMaterialCard(
    target: EquipmentInstance, stack: MaterialStack, rarity: EquipRarity,
    x: number, y: number, cardW: number, cardH: number,
  ): void {
    const core = this.core;
    const color = RARITY_COLOR[rarity];
    const cardBg = sketchPanel(cardW, cardH, { fill: 0xf8f4e8, border: color, seed: seedFor(x, y, cardW) });
    cardBg.x = x; cardBg.y = y;
    core.modalPanelRoot.addChild(cardBg);

    const padIn = 8;
    const imgBox = cardW - padIn * 2;
    const slot = getEquipDef(stack.defId)?.slot ?? 'weapon';
    const icon = buildEquipIcon(stack.defId, slot, rarity, imgBox, seedFor(x, y, cardW));
    icon.x = x + cardW / 2; icon.y = y + padIn + imgBox / 2;
    core.modalPanelRoot.addChild(icon);

    const nameLbl = core.stxt(itemName(stack.defId), FS.micro, C.dark, true);
    nameLbl.anchor.set(0.5, 0); nameLbl.x = x + cardW / 2; nameLbl.y = y + padIn + imgBox + 6;
    if (nameLbl.width > cardW - 6) nameLbl.scale.set(Math.max(0.4, (cardW - 6) / nameLbl.width));
    core.modalPanelRoot.addChild(nameLbl);

    if (stack.count > 1) {
      const badge = core.stxt(`×${stack.count}`, FS.micro, C.mid, true);
      badge.anchor.set(1, 0); badge.x = x + cardW - 4; badge.y = y + 3;
      core.modalPanelRoot.addChild(badge);
    }

    const matId = stack.repId;
    core.modalHits.push({ rect: core.toModalScreen({ x, y, w: cardW, h: cardH }), fn: () => this.confirmReforge(target, matId) });
  }

  private confirmReforge(target: EquipmentInstance, materialId: string): void {
    const core = this.core;
    const save = core.cb.getSave();
    const mat = save.equipmentInv?.[materialId];
    if (!mat) return;
    // Coin cost surfaced in the confirm dialog itself (2026-08-03 fix) — previously the only
    // hint of this cost was a generic error toast after the fact if the player couldn't afford
    // it; the reforge action is also now omitted entirely from the grid when unaffordable (see
    // EquipmentScene/detail.ts's canAffordReforge), so reaching this dialog implies it's affordable.
    const msg = t('equip.confirmReforge', { coins: reforgeCoinCost(target.rarity) })
      .replace('{target}', itemName(target.defId))
      .replace('{material}', itemLabel(mat.defId, mat.level));
    core.showConfirm(msg, () => void this.doReforge(target.id, materialId));
  }

  private async doReforge(targetId: string, materialId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.bt.start();
    try {
      const res = await withTimeout(core.cb.reforge(targetId, materialId));
      if (res.ok) core.showToast(t('equip.reforged'), C.green);
      else core.showToast(t(res.key), C.red);
    } catch (e) {
      core.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'equip.err.generic'), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }
}
