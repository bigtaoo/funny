// Craft tab: the craftable-equipment grid (icon-card cells with cost chips + Craft button) and the
// craft action itself. Depends only on EquipmentSceneCore — no cross-domain calls in either direction.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { sidebarNavW, bottomNavH } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import type { SaveData } from '../../game/meta/SaveData';
import { craftableDefs, getEquipDef, EQUIPMENT_INV_CAP } from '../../game/meta/equipmentDefs';
import { CELL_GAP, CELL_GAP_X, EQUIP_CELL_W_TARGET, CRAFT_CELL_H, RARITY_COLOR } from './layout';
import { itemName, canAffordMaterials } from './helpers';
import type { EquipmentSceneCore } from './core';

export class CraftPanel {
  constructor(private readonly core: EquipmentSceneCore) {}

  renderCraft(bodyTop: number): void {
    const core = this.core;
    const { w, h, landscape } = core;
    const save = core.cb.getSave();
    const defs = craftableDefs();
    const listY = bodyTop + 4;
    // Portrait's peer-level bottom bar (when shown) reserves bottomNavH off the bottom — same
    // hasGroupNav gate as InventoryPanel.renderInventory, since both tabs share that one bar.
    const availH = h - listY - 8 - (!landscape && core.hasGroupNav ? bottomNavH(h) : 0);
    const full = Object.keys(save.equipmentInv).length >= EQUIPMENT_INV_CAP;

    // Cells start right of the sidebar rail (landscape); portrait's sidebar is a bottom bar (§18),
    // no width reservation.
    const left = (landscape ? sidebarNavW(w, h, true) : 0) + CELL_GAP;
    const avail = w - left - CELL_GAP;
    const cols = Math.max(1, Math.floor((avail + CELL_GAP_X) / (EQUIP_CELL_W_TARGET + CELL_GAP_X)));
    const cellW = (avail - CELL_GAP_X * (cols - 1)) / cols;
    const rows = Math.ceil(defs.length / cols);
    const totalH = CELL_GAP + rows * (CRAFT_CELL_H + CELL_GAP);
    // Clamp the viewport so it always cuts mid-row when there's more below (see inventory.ts).
    const listH = peekViewportH(availH, CRAFT_CELL_H + CELL_GAP, totalH);
    const maxScroll = Math.max(0, totalH - listH);
    core.scrollY = Math.max(0, Math.min(core.scrollY, maxScroll));
    core.scrollRegionTop = listY;
    core.scrollRegionBottom = listY + listH;
    core.maxScroll = maxScroll;

    // Masked sub-layer so an overscrolled row never bleeds up past listY and paints over the
    // materials band above it (see the matching fix in inventory.ts's renderInventory).
    const gridLayer = new PIXI.Container();
    core.bodyLayer.addChild(gridLayer);
    const clip = new PIXI.Graphics();
    clip.beginFill(0xffffff).drawRect(0, listY, w, listH).endFill();
    core.bodyLayer.addChild(clip);
    gridLayer.mask = clip;
    const outerLayer = core.bodyLayer;
    core.bodyLayer = gridLayer;
    defs.forEach((def, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = left + col * (cellW + CELL_GAP_X);
      const y = listY + CELL_GAP + row * (CRAFT_CELL_H + CELL_GAP) - core.scrollY;
      if (y + CRAFT_CELL_H < listY || y > listY + listH) return;
      this.renderCraftCell(def.defId, x, y, cellW, save, full);
    });
    core.bodyLayer = outerLayer;

    drawScrollIndicator(core.bodyLayer, { x: left, y: listY, w: avail, h: listH }, core.scrollY, Math.max(0, totalH - listH));
  }

  /**
   * Craft icon-card cell: name +rarity across the top, equipment glyph in a
   * rarity-bordered frame on the left, cost chips + Craft button on the right.
   * Mirrors the inventory grid's `renderInstanceCell` visual language.
   */
  private renderCraftCell(defId: string, x: number, y: number, cellW: number, save: SaveData, full: boolean): void {
    const core = this.core;
    const pad = 8;
    const def = getEquipDef(defId)!;
    const color = RARITY_COLOR[def.rarity];
    const cell = sketchPanel(cellW, CRAFT_CELL_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cellW) });
    cell.x = x; cell.y = y;
    core.bodyLayer.addChild(cell);

    // Top: name (scaled to fit) + rarity tag.
    const name = txt(itemName(defId), FS.bodyLg, C.dark, true);
    name.x = x + pad; name.y = y + pad;
    if (name.width > cellW - pad * 2 - 80) name.scale.set(Math.min(1, (cellW - pad * 2 - 80) / name.width));
    core.bodyLayer.addChild(name);
    const rar = txt(t(`equip.rarity.${def.rarity}` as import('../../i18n').TranslationKey), FS.small, color, true);
    rar.anchor.set(1, 0); rar.x = x + cellW - pad; rar.y = y + pad + 2;
    core.bodyLayer.addChild(rar);

    // Left: glyph in a rarity-bordered frame.
    const imgBox = CRAFT_CELL_H - (pad + 32) - pad;
    const imgX = x + pad;
    const imgY = y + pad + 32;
    const frame = sketchPanel(imgBox, imgBox, { fill: 0xf0eee7, border: color, seed: seedFor(x, y, imgBox) });
    frame.x = imgX; frame.y = imgY;
    core.bodyLayer.addChild(frame);
    core.addGlyph(def.slot, def.rarity, imgX + imgBox / 2, imgY + imgBox / 2, imgBox - 8, seedFor(x, imgBox, cellW), 1, defId);

    // Right: cost chips (top) + Craft button (bottom).
    const ax = imgX + imgBox + 12;
    const cost = def.craftCost ?? {};
    const affordable = canAffordMaterials(save, cost);
    core.drawCostChips(core.bodyLayer, ax, imgY + 14, cost, null, affordable ? C.mid : C.red, 20);

    const enabled = affordable && !full && !core.bt.busy;
    const btnW = Math.min(104, x + cellW - pad - ax);
    const btnH = 36;
    const btnX = x + cellW - pad - btnW;
    const btnY = y + CRAFT_CELL_H - pad - btnH;
    const btn = sketchPanel(btnW, btnH, { fill: enabled ? C.dark : C.btnOff, border: enabled ? C.accent : C.mid, seed: seedFor(x, y, btnW) });
    btn.x = btnX; btn.y = btnY;
    core.bodyLayer.addChild(btn);
    // [anvil][gap][label] as one centred group — the same icon the Craft tab in the sidebar rail
    // uses, so the button and the tab that leads here read as the same action. The white `active`
    // ink is what the dark button fill asks for; disabled falls back to the paper-grey variant on
    // the `btnOff` fill. German ("Schmieden") is the label that actually reaches the button's
    // width, so the group scales down to fit rather than letting the icon push the text out.
    const bl = txt(t('equip.craftBtn'), FS.body, enabled ? C.light : C.mid);
    const icSz = Math.round(FS.body * 1.4);
    const icGap = Math.round(FS.body * 0.3);
    const groupW = icSz + icGap + bl.width;
    const fitW = btnW - 10;
    const fit = groupW > fitW ? fitW / groupW : 1;
    const groupX = btnX + (btnW - groupW * fit) / 2;
    const ic = buildIcon('craftTabIcon', icSz, enabled ? C.light : C.mid);
    ic.scale.set(fit);
    ic.x = groupX; ic.y = btnY + (btnH - icSz * fit) / 2;
    core.bodyLayer.addChild(ic);
    bl.scale.set(fit);
    bl.anchor.set(0, 0.5); bl.x = groupX + (icSz + icGap) * fit; bl.y = btnY + btnH / 2;
    core.bodyLayer.addChild(bl);
    if (enabled) {
      core.hitRects.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, owner: defId, action: () => void this.doCraft(defId) });
    } else if (!core.bt.busy) {
      // Tapping a greyed-out button still explains *why*: material shortage is already visible via
      // the red cost chips above, but "inventory full" has no other on-card cue — surface it here
      // instead of making players hunt for the small header counter (see equip.err.full).
      const reason = full ? 'equip.err.full' : 'equip.err.materials';
      core.hitRects.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, owner: defId, action: () => core.showToast(t(reason), C.red) });
    }
  }

  private async doCraft(defId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.bt.start(); core.render();
    try {
      const res = await withTimeout(core.cb.craft(defId));
      if (res.ok) core.showToast(t('equip.crafted').replace('{name}', itemName(defId)), C.green);
      else core.showToast(t(res.key), C.red);
    } catch (e) {
      core.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'equip.err.generic'), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }
}
