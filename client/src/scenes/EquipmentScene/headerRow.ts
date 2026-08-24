// headerRow.ts — the Equipment scene's header-row overlay (coin + capacity cluster) and the slim
// materials band just below it. Extracted from ./core.ts (2026-08-24, form (1): free functions taking
// `core`, no delegating methods left behind — same shape as FamilyScene/header.ts) when measuring the
// currency cluster's real width pushed core.ts past its baseline.
//
// Grouped rather than split further because the three share one invariant: `headerCurrencySpec` is
// the single source both the title-band reserve in core.build() and the draw call here read, and the
// materials band exists precisely because those material labels did NOT fit in this row.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, tearDownChildren } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { drawHeaderCurrency, sceneHeaderHeight } from '../../ui/widgets/SceneHeader';
import { buildMaterialIcon, type MaterialKind } from '../../render/atlas/materialAtlas';
import { EQUIPMENT_INV_CAP } from '../../game/meta/equipmentDefs';
import { MAT_BAND_H, TRACKED_MATERIALS, MAT_COLOR } from './layout';
import type { EquipmentSceneCore } from './core';

/**
 * Coin + material + capacity readout drawn into the header row itself (headerOverlayLayer sits
 * on top of the static header chrome), so it lines up with the "Equipment" title instead of floating
 * in its own band underneath. Called on every render(), independent of the assembly's renderHeaderRow/
 * assign mode, so it stays visible even while the card-assign picker is open.
 */
export function renderHeaderCurrency(core: EquipmentSceneCore): void {
  tearDownChildren(core.headerOverlayLayer);
  const spec = headerCurrencySpec(core);
  // Header carries only the coin balance + capacity — a compact right cluster that leaves room
  // for the left-aligned title on the narrow portrait bar. The three crafting materials are too
  // wide to fit here with readable labels, so they get their own body band (renderMaterialsBand).
  drawHeaderCurrency(
    core.headerOverlayLayer, core.w, core.headerH, spec.coins, [], spec.capacity, spec.scale,
    core.titleRight,
  );
}

/**
 * The coin + capacity cluster's inputs, in one place because two callers need the same answer:
 * build() measures it to size the title band, renderHeaderCurrency() draws it. Splitting the
 * expression between them is how the two silently drift apart.
 */
export function headerCurrencySpec(
  core: EquipmentSceneCore,
): { coins: number; capacity: { text: string; color: number }; scale: number } {
  const save = core.cb.getSave();
  const count = Object.keys(save.equipmentInv).length;
  return {
    coins: save.wallet.coins,
    capacity: { text: `${count}/${EQUIPMENT_INV_CAP}`, color: count >= EQUIPMENT_INV_CAP ? C.red : C.mid },
    // Keep the readout at a compact absolute size rather than scaling it up with a tall portrait bar.
    scale: 100 / sceneHeaderHeight(core.h),
  };
}

/**
 * Slim materials band at the top of the body (right of the sidebar rail): the three crafting
 * materials as icon + name + amount, at a readable size. Moved out of the header (see
 * renderHeaderCurrency) so the labels no longer collide with the title on the narrow portrait bar.
 */
export function renderMaterialsBand(core: EquipmentSceneCore, x: number, y: number, w: number): void {
  tearDownChildren(core.materialsLayer);
  const save = core.cb.getSave();
  const bg = new PIXI.Graphics();
  bg.beginFill(0xf3f1ea).drawRect(x, y, w, MAT_BAND_H).endFill();
  core.materialsLayer.addChild(bg);

  const midY = y + MAT_BAND_H / 2;
  const iconSize = Math.round(MAT_BAND_H * 0.44);
  const fontSize = snapFont(Math.round(MAT_BAND_H * 0.4));
  const slotW = w / TRACKED_MATERIALS.length;
  TRACKED_MATERIALS.forEach((m, i) => {
    const cx = x + i * slotW + Math.round(slotW * 0.1);
    const ic = buildMaterialIcon(m as MaterialKind, iconSize, MAT_COLOR[m] ?? C.mid);
    ic.x = cx; ic.y = midY - iconSize / 2;
    core.materialsLayer.addChild(ic);
    const lbl = txt(`${t(`material.${m}` as TranslationKey)} ${save.materials[m] ?? 0}`, fontSize, C.dark);
    lbl.anchor.set(0, 0.5); lbl.x = cx + iconSize + 6; lbl.y = midY;
    core.materialsLayer.addChild(lbl);
  });
}
