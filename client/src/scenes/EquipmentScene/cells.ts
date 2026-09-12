// Inventory-grid cell drawing primitives, split out of inventory.ts purely to keep it under the
// 500-line convention (claudedocs/client-modules.md's split-form priority note) — form① free
// functions with no Core delegate methods. Both take `core` (and `detail`, for the on-tap
// openDetail/instanceActions calls) explicitly rather than being methods on InventoryPanel; the
// only caller is InventoryPanel itself (renderLoadout from renderInventory, renderInstanceCell from
// renderInventory + refreshInstanceCell), which imports them directly.
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import type { SaveData, EquipmentInstance } from '../../game/meta/SaveData';
import { getEquipDef, affixKind } from '../../game/meta/equipmentDefs';
import { LOADOUT_H, EQUIP_CELL_H, RARITY_COLOR, SLOTS, AFFIX_COL_GAP, EQUIP_GLYPH_MIN } from './layout';
import { itemName, affixDesc } from './helpers';
import type { EquipmentSceneCore } from './core';
import type { DetailPanel } from './detail';

/** Loadout strip (Weapon/Armor/Trinket preview cells), confined to the right column — right of the sidebar rail, mirroring the filter bar and item grid below it. */
export function renderLoadout(core: EquipmentSceneCore, detail: DetailPanel, save: SaveData, y: number, left: number): void {
  const { w } = core;
  const label = txt(t('equip.loadout'), FS.micro, C.mid);
  label.x = left + 10; label.y = y + 4;
  core.bodyLayer.addChild(label);

  // CC-1: gear lives on the active card instance, not on a global loadout.
  const activeCard = save.cardInv?.[core.cb.activeCardInstanceId];
  const gear = activeCard?.gear ?? {};
  const cellW = (w - left - 8 * 4) / 3;
  const cellH = LOADOUT_H - 28;
  SLOTS.forEach((slot, i) => {
    const x = left + 8 + i * (cellW + 8);
    const cy = y + 22;
    const instId = gear[slot];
    const inst = instId ? save.equipmentInv[instId] : undefined;
    const border = inst ? RARITY_COLOR[inst.rarity] : C.mid;
    const cell = sketchPanel(cellW, cellH, { fill: 0xfaf9f5, border, seed: seedFor(i, 7, cellW) });
    cell.x = x; cell.y = cy;
    core.bodyLayer.addChild(cell);

    // Slot label: when equipped, show the slot type in small text as a secondary hint; when empty, show it bold so the player can easily identify open slots.
    const slotLbl = txt(t(`equip.slot.${slot}` as TranslationKey), FS.micro, inst ? C.mid : C.dark, !inst);
    slotLbl.anchor.set(0.5, 0); slotLbl.x = x + cellW / 2; slotLbl.y = cy + 4;
    core.bodyLayer.addChild(slotLbl);

    if (inst) {
      core.addGlyph(slot, inst.rarity, x + cellW / 2, cy + cellH * 0.34, 30, seedFor(i, 13, cellW), 1, inst.defId);
      const nm = txt(itemName(inst.defId), FS.micro, C.dark);
      nm.anchor.set(0.5, 0.5); nm.x = x + cellW / 2; nm.y = cy + cellH * 0.66;
      core.bodyLayer.addChild(nm);
      if (inst.level > 0) {
        const starSize = 10;
        const stars = core.buildLevelStars(inst.level, cellW - 8, starSize, 2);
        // Bottom-anchored (not a cellH fraction) so the row always clears the slot cell's
        // bottom border regardless of cellH — a fraction-based y previously let the stars
        // overrun the border by a few px (2026-08-01).
        stars.x = x + cellW / 2 - stars.width / 2; stars.y = cy + cellH - starSize - 4;
        core.bodyLayer.addChild(stars);
      }
      core.hitRects.push({ rect: { x, y: cy, w: cellW, h: cellH }, fn: () => detail.openDetail(inst.id) });
    } else {
      // Empty slot: addGlyph renders the hollow "+" placeholder (no defId), paired
      // with the "empty" label so the player can clearly identify open positions.
      core.addGlyph(slot, 'common', x + cellW / 2, cy + cellH * 0.45, 28, seedFor(i, 13, cellW), 1);
      const empty = txt(t('equip.slotEmpty'), FS.micro, C.mid);
      empty.anchor.set(0.5, 0.5); empty.x = x + cellW / 2; empty.y = cy + cellH * 0.88;
      core.bodyLayer.addChild(empty);
    }
  });
}

/**
 * Icon-card cell: name + level across the top (stack count / lock badge in the top-right
 * corner), equipment glyph on the left, rarity / equipped tag / affix stat lines on the right,
 * action hint bottom-right. Border color encodes rarity when equipped, neutral otherwise.
 */
export function renderInstanceCell(
  core: EquipmentSceneCore, detail: DetailPanel,
  inst: EquipmentInstance, x: number, y: number, cellW: number, equipped: boolean, count = 1,
): void {
  const pad = 8;
  const color = RARITY_COLOR[inst.rarity];
  const save = core.cb.getSave();
  // Available on-card actions (enhance / equip / reforge / salvage …) — unavailable ones are
  // omitted so they're hidden rather than greyed (2026-07-22: actions moved off the detail modal
  // onto the cell; a tap on a button fires it directly, a tap on the card body opens the info modal).
  const actions = detail.instanceActions(save, inst);
  // Border always encodes rarity (equipped or not) so the color language is consistent
  // across the Equipped strip and the Bag grid — it used to fall back to neutral grey
  // for unequipped items, which made rarity only readable via the text label.
  const cell = sketchPanel(cellW, EQUIP_CELL_H, { fill: 0xfaf9f5, border: color, seed: seedFor(x, y, cellW) });
  cell.x = x; cell.y = y;
  core.bodyLayer.addChild(cell);

  // Top-right corner badge: lock icon takes priority; otherwise the stack count (×N). The two
  // never coexist — stacked entries are always unlocked/level 0 (see buildDisplayEntries), so a
  // locked instance is never also a counted stack.
  let cornerBadgeW = 0;
  if (inst.locked) {
    const l = buildIcon('lock', 18, C.mid);
    l.x = x + cellW - pad - 18; l.y = y + pad;
    core.bodyLayer.addChild(l);
    cornerBadgeW = 18;
  } else if (count > 1) {
    const badge = txt(`×${count}`, FS.body, C.mid, true);
    badge.anchor.set(1, 0); badge.x = x + cellW - pad; badge.y = y + pad;
    core.bodyLayer.addChild(badge);
    cornerBadgeW = badge.width;
  }

  // Top: name (scaled down to fit if too wide, leaving room for the corner badge above).
  const name = txt(itemName(inst.defId), FS.bodyLg, C.dark, true);
  name.x = x + pad; name.y = y + pad;
  const nameMaxW = cellW - pad * 2 - (cornerBadgeW > 0 ? cornerBadgeW + 8 : 0);
  if (name.width > nameMaxW) name.scale.set(Math.min(1, nameMaxW / name.width));
  core.bodyLayer.addChild(name);

  // Enhance level as a row of gold stars beneath the name, in place of the old "+N" suffix
  // (matches the Hero Roster / Card level-star convention). Header row grows to make room.
  const headerH = inst.level > 0 ? 40 : 32;
  if (inst.level > 0) {
    const stars = core.buildLevelStars(inst.level, cellW - pad * 2);
    stars.x = x + pad; stars.y = y + pad + 20;
    core.bodyLayer.addChild(stars);
  }

  // Bottom band reserved for the action button row (only when there are actions to show);
  // the glyph frame shrinks to leave room for it. Icon + small label stack → a bit taller.
  const btnBandH = actions.length > 0 ? 46 : 0;
  const bandGap = actions.length > 0 ? 8 : 0;

  // Left: glyph in a rarity-bordered frame.
  const slot = getEquipDef(inst.defId)?.slot ?? 'weapon';
  // The affix lines are built (not placed) FIRST, because the widest of them is what decides how
  // big the glyph may be (2026-09-12). The height-derived box below is the box the cell has room
  // for; it is not necessarily the box the cell can AFFORD, because whatever the glyph takes on the
  // left is taken from the stat column on the right — and that column has a hard requirement, which
  // is that an affix line fits on one line at the legibility floor. Squeezing it instead cost two
  // lines of wrap per affix, which pushed the third affix down into the action-button band and
  // straight under it (sweep 2026-09-12: 'Atk Speed +6%' reported `covered` on every epic cell).
  const affixLines = inst.affixes.map((af) =>
    txt(affixDesc(af.id, af.value, inst.level), FS.small, affixKind(af.id) === 'main' ? C.accent : C.dark));
  const widestAffix = affixLines.reduce((m, l) => Math.max(m, l.width), 0);
  const boxByHeight = EQUIP_CELL_H - (pad + headerH) - pad - btnBandH - bandGap;
  // What is left for the glyph once the stat column has the width it needs. Floored, because a
  // glyph small enough to be unrecognisable helps nobody either; below the floor the lines wrap
  // again, which is the lesser evil and still legible.
  const boxByWidth = cellW - pad * 2 - AFFIX_COL_GAP - Math.ceil(widestAffix);
  const imgBox = Math.max(EQUIP_GLYPH_MIN, Math.min(boxByHeight, boxByWidth));
  const imgX = x + pad;
  // Centred in the band the cell reserved for it, not pinned to its top: once the stat column
  // claims width the square gets smaller than the band is tall, and hugging the top left the
  // leftover as one hole under the glyph instead of as margin around it.
  const imgY = y + pad + headerH + Math.round((boxByHeight - imgBox) / 2);
  // fillAlpha: 0 — see CardScene/list.ts's renderCardCell (2026-08-21): the cell behind already
  // fills+borders in this same rarity color, so this frame's own fill only duplicated it.
  const frame = sketchPanel(imgBox, imgBox, { fill: 0xf0eee7, fillAlpha: 0, border: color, seed: seedFor(x, y, imgBox) });
  frame.x = imgX; frame.y = imgY;
  core.bodyLayer.addChild(frame);
  core.addGlyph(slot, inst.rarity, imgX + imgBox / 2, imgY + imgBox / 2, imgBox - 8, seedFor(x, imgBox, cellW), 1, inst.defId);

  // Right: rarity / equipped tag on top, then the item's affix lines (its stats, e.g.
  // "Health +10%") shown directly beside the icon — no need to open the detail modal just to
  // see what a piece rolls. Main affix highlighted in accent color, sub/skill in neutral dark
  // (mirrors the detail modal's affix list styling). Stack count moved to the top-right corner
  // badge above, so this column is now stat space instead of duplicate count text.
  const ax = imgX + imgBox + AFFIX_COL_GAP;
  const colW = x + cellW - pad - ax;
  let ay = imgY + 4;
  const rar = txt(t(`equip.rarity.${inst.rarity}` as TranslationKey), FS.body, color, true);
  rar.x = ax; rar.y = ay; core.bodyLayer.addChild(rar); ay += 26;
  // Neither of these SHRINKS any more (2026-09-12). `scale.set(colW / width)` is the exact
  // anti-pattern render/fontScale.ts's `fitFont` exists to replace: it multiplies the size the
  // legibility floor just guaranteed by an arbitrary float, so the label lands wherever that float
  // puts it. Measured by the sweep on a 390-wide phone: 'Crit Damage +30%' at scale 0.59, i.e. 11.8
  // CSS px against a 20px floor — and in German ('Krit.-Schaden +30%') the same line on all 15
  // cells. The column is made wide enough instead (see `boxByWidth` above); portrait's third grid
  // column is a deliberate 2026-08-09 choice (layout.ts `equipGridColumns`) and this cell has to
  // work inside it, so the width has to come from the glyph.
  if (equipped) {
    const slotLabel = t(`equip.slot.${slot}` as TranslationKey);
    const e = txt(`[${t('equip.equipped')} · ${slotLabel}]`, FS.small, C.green, true, colW);
    e.x = ax; e.y = ay; core.bodyLayer.addChild(e); ay += Math.max(22, Math.ceil(e.height) + 2);
  }
  for (const line of affixLines) {
    // Wrap only as a fallback: `imgBox` above is chosen so this normally does not trigger, but a
    // very long localisation on a very narrow cell can still outrun the glyph floor.
    if (line.width > colW) { line.style.wordWrap = true; line.style.wordWrapWidth = colW; line.style.breakWords = true; }
    line.x = ax; line.y = ay; core.bodyLayer.addChild(line);
    ay += Math.max(20, Math.ceil(line.height) + 2);
  }

  // Action buttons along the bottom of the cell, spanning its full width. Each is an icon-forward
  // button (glyph on top, small label under it) so every operation is a tap away on this one
  // screen — no need to open the item first. Only truly-unavailable actions are omitted (hidden);
  // a momentarily-busy one stays put but greyed (see CellAction.disabled) so the button band
  // never changes height while a request is in flight. Pushed to hitRects *before* the full-cell
  // rect below so a button tap wins over the card-body detail tap.
  if (actions.length > 0) {
    const n = actions.length;
    const bgap = 5;
    const by = y + EQUIP_CELL_H - pad - btnBandH;
    const bw = (cellW - pad * 2 - bgap * (n - 1)) / n;
    actions.forEach((a, i) => {
      const bx = x + pad + i * (bw + bgap);
      const fill = a.disabled ? C.btnOff : a.fill;
      const stroke = a.disabled ? C.mid : a.stroke;
      const g = sketchPanel(bw, btnBandH, { fill, border: stroke, seed: seedFor(bx, by, bw) });
      g.x = bx; g.y = by;
      core.bodyLayer.addChild(g);
      // Light ink on the dark/blue fills, dark on the pale (salvage/unequip) fills; muted grey once disabled.
      const onDark = !a.disabled && (a.fill === C.dark || a.fill === 0x3355aa);
      const inkColor = a.disabled ? C.mid : (onDark ? C.light : C.dark);
      const iconSz = 20;
      const ic = buildIcon(a.icon, iconSz, inkColor);
      ic.x = bx + bw / 2 - iconSz / 2; ic.y = by + 5;
      core.bodyLayer.addChild(ic);
      const lbl = txt(a.label, FS.micro, inkColor, true);
      lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + btnBandH - 10;
      if (lbl.width > bw - 4) lbl.scale.set(Math.max(0.35, (bw - 4) / lbl.width));
      core.bodyLayer.addChild(lbl);
      if (!a.disabled) core.hitRects.push({ rect: { x: bx, y: by, w: bw, h: btnBandH }, owner: inst.id, fn: a.fn });
    });
  }

  // Card body (outside the buttons) opens the info modal — affixes, enhance rate/cost, protect toggle.
  core.hitRects.push({ rect: { x, y, w: cellW, h: EQUIP_CELL_H }, owner: inst.id, fn: () => detail.openDetail(inst.id) });
}
